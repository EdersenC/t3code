import {
  DEFAULT_LOCAL_MODEL,
  ProviderDriverKind,
  type LocalSettings,
  type ModelCapabilities,
  type ServerProviderModel,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { createModelCapabilities } from "@t3tools/shared/model";
import { compareSemverVersions } from "@t3tools/shared/semver";
import { mergePathValues } from "@t3tools/shared/shell";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import {
  buildServerProvider,
  parseGenericCliVersion,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  OpenCodeRuntime,
  openCodeRuntimeErrorDetail,
  type OpenCodeInventory,
} from "../opencodeRuntime.ts";
import { flattenOpenCodeModels, MINIMUM_OPENCODE_VERSION } from "./OpenCodeProvider.ts";
import {
  buildLocalOpenCodeConfig,
  localModelIdsForConfig,
  normalizeLocalModelId,
  normalizeLocalVllmBaseUrl,
  toLocalOpenCodeModelSlug,
} from "../localOpenCode.ts";

const PROVIDER = ProviderDriverKind.make("local");
const OPENCODE_COMMAND = "opencode";
const LOCAL_PRESENTATION = {
  displayName: "Local",
  badgeLabel: "vLLM",
  showInteractionModeToggle: false,
} as const;

const DEFAULT_LOCAL_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const VllmModelListResponse = Schema.Struct({
  data: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: Schema.optional(Schema.Unknown),
      }),
    ),
  ),
});
type VllmModelListResponse = typeof VllmModelListResponse.Type;

class LocalVllmProbeError extends Data.TaggedError("LocalVllmProbeError")<{
  readonly cause: unknown;
  readonly detail: string;
}> {}

export function resolveLocalOpenCodeBinaryPath(binaryPath: string): string {
  return binaryPath.trim() || OPENCODE_COMMAND;
}

export function resolveLocalOpenCodeEnvironment(
  binaryPath: string,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
  const command = resolveLocalOpenCodeBinaryPath(binaryPath);
  if (command !== OPENCODE_COMMAND) return environment;

  const home = environment.HOME ?? environment.USERPROFILE;
  if (!home) return environment;

  const managedBinDir = home.replace(/[\\/]+$/, "") + "/.opencode/bin";
  const mergedPath = mergePathValues(
    managedBinDir,
    environment.PATH ?? environment.Path ?? environment.path,
    platform,
  );
  return mergedPath ? { ...environment, PATH: mergedPath } : environment;
}

function modelSourceLabel(modelId: string): string {
  if (
    modelId.startsWith("/") ||
    modelId.startsWith("./") ||
    modelId.startsWith("../") ||
    /^[a-zA-Z]:[\\/]/u.test(modelId)
  ) {
    return "vLLM · Local Path";
  }
  return "vLLM · Hugging Face";
}

function modelDisplayName(modelId: string): string {
  return modelId.trim() || normalizeLocalModelId(DEFAULT_LOCAL_MODEL)!;
}

function modelEntryFromId(modelId: string, isCustom: boolean): ServerProviderModel | null {
  const normalized = normalizeLocalModelId(modelId);
  if (!normalized) return null;
  const slug = toLocalOpenCodeModelSlug(normalized);
  if (!slug) return null;
  return {
    slug,
    name: modelDisplayName(normalized),
    shortName: normalized.split(/[\\/]/u).at(-1) ?? normalized,
    subProvider: modelSourceLabel(normalized),
    isCustom,
    capabilities: DEFAULT_LOCAL_MODEL_CAPABILITIES,
  };
}

function modelEntriesFromIds(
  modelIds: ReadonlyArray<string>,
  isCustom: boolean,
): ReadonlyArray<ServerProviderModel> {
  const seen = new Set<string>();
  const models: Array<ServerProviderModel> = [];
  for (const modelId of modelIds) {
    const entry = modelEntryFromId(modelId, isCustom);
    if (!entry || seen.has(entry.slug)) continue;
    seen.add(entry.slug);
    models.push(entry);
  }
  return models.toSorted((left, right) => left.name.localeCompare(right.name));
}

function modelsWithConfiguredEntries(
  discovered: ReadonlyArray<ServerProviderModel>,
  settings: Pick<LocalSettings, "customModels">,
): ReadonlyArray<ServerProviderModel> {
  const seen = new Set(discovered.map((model) => model.slug));
  const models = [...discovered];
  for (const modelId of settings.customModels) {
    const entry = modelEntryFromId(modelId, true);
    if (!entry || seen.has(entry.slug)) continue;
    seen.add(entry.slug);
    models.push(entry);
  }
  return models.toSorted((left, right) => left.name.localeCompare(right.name));
}

function fallbackModels(settings: LocalSettings, discoveredModels: ReadonlyArray<string> = []) {
  const modelIds = localModelIdsForConfig({ settings, discoveredModels });
  return modelsWithConfiguredEntries(modelEntriesFromIds(modelIds, false), settings);
}

function isMissingOpenCodeBinary(cause: unknown): boolean {
  const detail = openCodeRuntimeErrorDetail(cause).toLowerCase();
  return detail.includes("enoent") || detail.includes("notfound") || detail.includes("not found");
}

function openCodeFailureMessage(cause: unknown): string {
  const detail = openCodeRuntimeErrorDetail(cause);
  return detail.trim().length > 0 ? detail : "OpenCode harness check failed.";
}

function localModelsFromOpenCodeInventory(
  inventory: OpenCodeInventory,
): ReadonlyArray<ServerProviderModel> {
  return flattenOpenCodeModels(inventory).filter((model) => model.slug.startsWith("local-vllm/"));
}

function parseVllmModelIds(response: VllmModelListResponse): ReadonlyArray<string> {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const model of response.data ?? []) {
    if (typeof model.id !== "string") continue;
    const normalized = normalizeLocalModelId(model.id);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    ids.push(normalized);
  }
  return ids;
}

function probeFailureDetail(cause: unknown): string {
  if (cause instanceof Error && cause.message.trim().length > 0) return cause.message;
  const detail = String(cause);
  return detail.trim().length > 0 ? detail : "Unknown vLLM probe failure.";
}

function fetchVllmModelIds(
  settings: LocalSettings,
  timeoutMs: number,
): Effect.Effect<ReadonlyArray<string>, LocalVllmProbeError, HttpClient.HttpClient> {
  return Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const request = HttpClientRequest.get(
      normalizeLocalVllmBaseUrl(settings.baseUrl) + "/v1/models",
    ).pipe(HttpClientRequest.acceptJson);
    const response = yield* httpClient.execute(request).pipe(
      Effect.timeout(Duration.millis(timeoutMs)),
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(VllmModelListResponse)),
      Effect.mapError(
        (cause) =>
          new LocalVllmProbeError({
            cause,
            detail: probeFailureDetail(cause),
          }),
      ),
    );
    return parseVllmModelIds(response);
  });
}

export const makePendingLocalProvider = (
  localSettings: LocalSettings,
): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    return buildServerProvider({
      driver: PROVIDER,
      presentation: LOCAL_PRESENTATION,
      enabled: localSettings.enabled,
      checkedAt,
      models: fallbackModels(localSettings),
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking local vLLM endpoint and OpenCode harness...",
      },
    });
  });

export const checkLocalProviderStatus = Effect.fn("checkLocalProviderStatus")(function* (
  localSettings: LocalSettings,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
  options?: { readonly timeoutMs?: number | undefined },
): Effect.fn.Return<ServerProviderDraft, never, OpenCodeRuntime | HttpClient.HttpClient> {
  const openCodeRuntime = yield* OpenCodeRuntime;
  const resolvedEnvironment = environment ?? process.env;
  const platform = yield* HostProcessPlatform;
  const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
  const baseUrl = normalizeLocalVllmBaseUrl(localSettings.baseUrl);
  const binaryPath = resolveLocalOpenCodeBinaryPath(localSettings.binaryPath);
  const openCodeEnvironment = resolveLocalOpenCodeEnvironment(
    localSettings.binaryPath,
    resolvedEnvironment,
    platform,
  );
  const timeoutMs = options?.timeoutMs ?? 4_000;

  if (!localSettings.enabled) {
    return buildServerProvider({
      driver: PROVIDER,
      presentation: LOCAL_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels(localSettings),
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Local vLLM provider is disabled in T3 Code settings.",
      },
    });
  }

  const vllmProbeExit = yield* Effect.exit(fetchVllmModelIds(localSettings, timeoutMs));

  if (Exit.isFailure(vllmProbeExit)) {
    const cause = Cause.squash(vllmProbeExit.cause);
    const detail =
      cause instanceof LocalVllmProbeError ? cause.detail : "vLLM endpoint is unreachable.";
    return buildServerProvider({
      driver: PROVIDER,
      presentation: LOCAL_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels(localSettings),
      probe: {
        installed: false,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message:
          "Couldn't reach the local vLLM server at " +
          baseUrl +
          ". Start vLLM or update the Local provider base URL. Details: " +
          detail,
      },
    });
  }

  const discoveredModels = vllmProbeExit.value;
  const modelIds = localModelIdsForConfig({ settings: localSettings, discoveredModels });
  const modelFallback = fallbackModels(localSettings, discoveredModels);
  const configContent = buildLocalOpenCodeConfig({ settings: localSettings, modelIds });

  const versionExit = yield* Effect.exit(
    openCodeRuntime.runOpenCodeCommand({
      binaryPath,
      args: ["--version"],
      environment: openCodeEnvironment,
    }),
  );

  if (Exit.isFailure(versionExit)) {
    const cause = Cause.squash(versionExit.cause);
    const missing = isMissingOpenCodeBinary(cause);
    return buildServerProvider({
      driver: PROVIDER,
      presentation: LOCAL_PRESENTATION,
      enabled: true,
      checkedAt,
      models: modelFallback,
      probe: {
        installed: !missing,
        version: null,
        status: "error",
        auth: { status: "authenticated", type: "local", label: baseUrl },
        message: missing
          ? "vLLM is reachable, but OpenCode CLI (opencode) is not installed or not on PATH."
          : "vLLM is reachable, but OpenCode CLI health check failed: " +
            openCodeFailureMessage(cause),
      },
    });
  }

  const openCodeVersion = parseGenericCliVersion(versionExit.value.stdout);
  if (!openCodeVersion) {
    return buildServerProvider({
      driver: PROVIDER,
      presentation: LOCAL_PRESENTATION,
      enabled: true,
      checkedAt,
      models: modelFallback,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "authenticated", type: "local", label: baseUrl },
        message:
          "Unable to determine OpenCode version from opencode --version output. T3 Code requires OpenCode v" +
          MINIMUM_OPENCODE_VERSION +
          " or newer.",
      },
    });
  }

  if (compareSemverVersions(openCodeVersion, MINIMUM_OPENCODE_VERSION) < 0) {
    return buildServerProvider({
      driver: PROVIDER,
      presentation: LOCAL_PRESENTATION,
      enabled: true,
      checkedAt,
      models: modelFallback,
      probe: {
        installed: true,
        version: openCodeVersion,
        status: "error",
        auth: { status: "authenticated", type: "local", label: baseUrl },
        message:
          "OpenCode v" +
          openCodeVersion +
          " is too old. Upgrade to v" +
          MINIMUM_OPENCODE_VERSION +
          " or newer.",
      },
    });
  }

  const inventoryExit = yield* Effect.exit(
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* openCodeRuntime.connectToOpenCodeServer({
          binaryPath,
          environment: openCodeEnvironment,
          configContent,
        });
        return yield* openCodeRuntime.loadOpenCodeInventory(
          openCodeRuntime.createOpenCodeSdkClient({
            baseUrl: server.url,
            directory: cwd,
          }),
        );
      }),
    ),
  );

  if (Exit.isFailure(inventoryExit)) {
    const cause = Cause.squash(inventoryExit.cause);
    return buildServerProvider({
      driver: PROVIDER,
      presentation: LOCAL_PRESENTATION,
      enabled: true,
      checkedAt,
      models: modelFallback,
      probe: {
        installed: true,
        version: openCodeVersion,
        status: "error",
        auth: { status: "authenticated", type: "local", label: baseUrl },
        message:
          "vLLM is reachable, but OpenCode could not load the generated Local vLLM provider config: " +
          openCodeFailureMessage(cause),
      },
    });
  }

  const openCodeModels = localModelsFromOpenCodeInventory(inventoryExit.value);
  const hasOpenCodeLocalModels = openCodeModels.length > 0;
  const models = modelsWithConfiguredEntries(openCodeModels, localSettings);
  const discoveredCount = discoveredModels.length;

  return buildServerProvider({
    driver: PROVIDER,
    presentation: LOCAL_PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    probe: {
      installed: true,
      version: openCodeVersion,
      status: hasOpenCodeLocalModels ? "ready" : "warning",
      auth: { status: "authenticated", type: "local", label: baseUrl },
      message: hasOpenCodeLocalModels
        ? "Local vLLM is reachable and OpenCode loaded " +
          openCodeModels.length +
          " model" +
          (openCodeModels.length === 1 ? "" : "s") +
          (discoveredCount > 0 ? " from the running endpoint." : ".")
        : "Local vLLM is reachable, but OpenCode did not expose any generated Local models. Check the generated provider config and OpenCode harness install.",
    },
  });
});
