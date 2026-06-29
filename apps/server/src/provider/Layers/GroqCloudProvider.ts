import {
  DEFAULT_GROQ_MODEL,
  ProviderDriverKind,
  type GroqSettings,
  type ModelCapabilities,
  type ServerProviderModel,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { createModelCapabilities } from "@t3tools/shared/model";
import { compareSemverVersions } from "@t3tools/shared/semver";
import {
  listGroqModels,
  normalizeGroqBaseUrl,
  resolveGroqApiKey,
  type GroqModel,
} from "../groqApi.ts";
import {
  buildGroqOpenCodeConfig,
  groqModelIdsForConfig,
  isGroqOpenCodeConfiguredModel,
  isGroqOpenCodeDiscoveredModel,
  normalizeGroqModelId,
  toGroqOpenCodeModelSlug,
} from "../groqOpenCode.ts";
import {
  OpenCodeRuntime,
  openCodeRuntimeErrorDetail,
  type OpenCodeInventory,
} from "../opencodeRuntime.ts";
import {
  buildServerProvider,
  parseGenericCliVersion,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import { flattenOpenCodeModels, MINIMUM_OPENCODE_VERSION } from "./OpenCodeProvider.ts";
import {
  resolveOllamaOpenCodeBinaryPath,
  resolveOllamaOpenCodeEnvironment,
} from "./OllamaProvider.ts";

const PROVIDER = ProviderDriverKind.make("groq");
const GROQ_PRESENTATION = {
  displayName: "Groq",
  showInteractionModeToggle: false,
} as const;

const DEFAULT_GROQ_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

class GroqProbeError extends Data.TaggedError("GroqProbeError")<{
  readonly cause: unknown;
  readonly detail: string;
  readonly status?: number | undefined;
}> {}

export interface GroqProviderOptions {
  readonly fetchFn?: typeof fetch | undefined;
  readonly timeoutMs?: number | undefined;
}

function modelDisplayName(modelId: string): string {
  return modelId.trim() || normalizeGroqModelId(DEFAULT_GROQ_MODEL)!;
}

function modelEntryFromId(modelId: string, isCustom: boolean): ServerProviderModel | null {
  const slug = toGroqOpenCodeModelSlug(modelId);
  if (!slug) return null;
  return {
    slug,
    name: modelDisplayName(modelId),
    subProvider: "Groq",
    isCustom,
    capabilities: DEFAULT_GROQ_MODEL_CAPABILITIES,
  };
}

function modelEntryFromGroqModel(model: GroqModel, isCustom: boolean): ServerProviderModel | null {
  const entry = modelEntryFromId(model.id, isCustom);
  if (!entry) return null;
  return {
    ...entry,
    ...(model.ownedBy ? { subProvider: model.ownedBy } : {}),
  };
}

function modelsWithConfiguredEntries(
  discovered: ReadonlyArray<ServerProviderModel>,
  settings: Pick<GroqSettings, "customModels">,
): ReadonlyArray<ServerProviderModel> {
  const seen = new Set(discovered.map((model) => model.slug));
  const models = [...discovered];
  for (const modelId of groqModelIdsForConfig({ settings })) {
    const entry = modelEntryFromId(modelId, true);
    if (!entry || seen.has(entry.slug)) continue;
    seen.add(entry.slug);
    models.push(entry);
  }
  return models.toSorted((left, right) => left.name.localeCompare(right.name));
}

function fallbackModels(settings: GroqSettings, discoveredModels: ReadonlyArray<GroqModel> = []) {
  const discoveredEntries = discoveredModels
    .filter((model) => isGroqOpenCodeDiscoveredModel(model))
    .map((model) => modelEntryFromGroqModel(model, false))
    .filter((model): model is ServerProviderModel => model !== null);
  return modelsWithConfiguredEntries(discoveredEntries, settings);
}

function groqModelsFromOpenCodeInventory(
  inventory: OpenCodeInventory,
): ReadonlyArray<ServerProviderModel> {
  return flattenOpenCodeModels(inventory).filter((model) => model.slug.startsWith("groq/"));
}

function isMissingOpenCodeBinary(cause: unknown): boolean {
  const detail = openCodeRuntimeErrorDetail(cause).toLowerCase();
  return detail.includes("enoent") || detail.includes("notfound") || detail.includes("not found");
}

function openCodeFailureMessage(cause: unknown): string {
  const detail = openCodeRuntimeErrorDetail(cause);
  return detail.trim().length > 0 ? detail : "OpenCode harness check failed.";
}

function groqProbeFailureMessage(cause: unknown, baseUrl: string): string {
  const status = cause instanceof GroqProbeError ? cause.status : undefined;
  const detail = cause instanceof GroqProbeError ? cause.detail : "Groq model discovery failed.";
  if (status === 401 || status === 403) {
    return "Groq rejected authentication. Check the Groq API key in settings or GROQ_API_KEY.";
  }
  return "Couldn't reach Groq model discovery at " + baseUrl + "/models. " + detail;
}

function groqProbeFailureAuth(cause: unknown) {
  const status = cause instanceof GroqProbeError ? cause.status : undefined;
  return status === 401 || status === 403
    ? ({ status: "unauthenticated", type: "api-key", label: "Groq API key" } as const)
    : ({ status: "unknown", type: "api-key", label: "Groq API key" } as const);
}

export const makePendingGroqProvider = (
  groqSettings: GroqSettings,
): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    return buildServerProvider({
      driver: PROVIDER,
      presentation: GROQ_PRESENTATION,
      enabled: groqSettings.enabled,
      checkedAt,
      models: fallbackModels(groqSettings),
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Groq and OpenCode harness...",
      },
    });
  });

export const checkGroqProviderStatus = Effect.fn("checkGroqProviderStatus")(function* (
  groqSettings: GroqSettings,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
  options?: GroqProviderOptions,
): Effect.fn.Return<ServerProviderDraft, never, OpenCodeRuntime> {
  const openCodeRuntime = yield* OpenCodeRuntime;
  const platform = yield* HostProcessPlatform;
  const resolvedEnvironment = environment ?? process.env;
  const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
  const baseUrl = normalizeGroqBaseUrl(groqSettings.baseUrl);
  const apiKey = resolveGroqApiKey(groqSettings, resolvedEnvironment);
  const binaryPath = resolveOllamaOpenCodeBinaryPath(groqSettings.binaryPath);
  const openCodeEnvironment = resolveOllamaOpenCodeEnvironment(
    groqSettings.binaryPath,
    resolvedEnvironment,
    platform,
  );

  if (!groqSettings.enabled) {
    return buildServerProvider({
      driver: PROVIDER,
      presentation: GROQ_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels(groqSettings),
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Groq is disabled in T3 Code settings.",
      },
    });
  }

  if (!apiKey) {
    return buildServerProvider({
      driver: PROVIDER,
      presentation: GROQ_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels(groqSettings),
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unauthenticated", type: "api-key", label: "Groq API key" },
        message: "Add a Groq API key in provider settings or set GROQ_API_KEY.",
      },
    });
  }

  const groqProbeExit = yield* Effect.exit(
    Effect.tryPromise({
      try: () => listGroqModels(groqSettings, resolvedEnvironment, options),
      catch: (cause) =>
        new GroqProbeError({
          cause,
          detail: cause instanceof Error ? cause.message : String(cause),
          status:
            cause && typeof cause === "object" && "status" in cause
              ? (cause.status as number | undefined)
              : undefined,
        }),
    }),
  );

  if (Exit.isFailure(groqProbeExit)) {
    const cause = Cause.squash(groqProbeExit.cause);
    return buildServerProvider({
      driver: PROVIDER,
      presentation: GROQ_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels(groqSettings),
      probe: {
        installed: false,
        version: null,
        status: "error",
        auth: groqProbeFailureAuth(cause),
        message: groqProbeFailureMessage(cause, baseUrl),
      },
    });
  }

  const discoveredModels = groqProbeExit.value;
  const modelIds = groqModelIdsForConfig({ settings: groqSettings, discoveredModels });
  const modelFallback = fallbackModels(groqSettings, discoveredModels);
  const configContent = buildGroqOpenCodeConfig({
    settings: groqSettings,
    modelIds: [
      ...discoveredModels.filter((model) => isGroqOpenCodeDiscoveredModel(model)),
      ...groqSettings.customModels.filter((model) => isGroqOpenCodeConfiguredModel(model)),
      ...modelIds,
    ],
    environment: resolvedEnvironment,
  });

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
      presentation: GROQ_PRESENTATION,
      enabled: true,
      checkedAt,
      models: modelFallback,
      probe: {
        installed: !missing,
        version: null,
        status: "error",
        auth: { status: "authenticated", type: "api-key", label: "Groq API key" },
        message: missing
          ? "Groq authenticated, but OpenCode CLI (opencode) is not installed or not on PATH."
          : "Groq authenticated, but OpenCode CLI health check failed: " +
            openCodeFailureMessage(cause),
      },
    });
  }

  const openCodeVersion = parseGenericCliVersion(versionExit.value.stdout);
  if (!openCodeVersion) {
    return buildServerProvider({
      driver: PROVIDER,
      presentation: GROQ_PRESENTATION,
      enabled: true,
      checkedAt,
      models: modelFallback,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "authenticated", type: "api-key", label: "Groq API key" },
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
      presentation: GROQ_PRESENTATION,
      enabled: true,
      checkedAt,
      models: modelFallback,
      probe: {
        installed: true,
        version: openCodeVersion,
        status: "error",
        auth: { status: "authenticated", type: "api-key", label: "Groq API key" },
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
      presentation: GROQ_PRESENTATION,
      enabled: true,
      checkedAt,
      models: modelFallback,
      probe: {
        installed: true,
        version: openCodeVersion,
        status: "error",
        auth: { status: "authenticated", type: "api-key", label: "Groq API key" },
        message:
          "Groq authenticated, but OpenCode could not load the generated Groq provider config: " +
          openCodeFailureMessage(cause),
      },
    });
  }

  const openCodeModels = groqModelsFromOpenCodeInventory(inventoryExit.value);
  const hasOpenCodeGroqModels = openCodeModels.length > 0;
  const models = modelsWithConfiguredEntries(openCodeModels, groqSettings);

  return buildServerProvider({
    driver: PROVIDER,
    presentation: GROQ_PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    probe: {
      installed: true,
      version: openCodeVersion,
      status: hasOpenCodeGroqModels && discoveredModels.length > 0 ? "ready" : "warning",
      auth: { status: "authenticated", type: "api-key", label: "Groq API key" },
      message:
        hasOpenCodeGroqModels && discoveredModels.length > 0
          ? "Groq is reachable and OpenCode loaded " +
            openCodeModels.length +
            " Groq model" +
            (openCodeModels.length === 1 ? "." : "s.")
          : "Groq is reachable, but OpenCode did not expose any generated Groq models. Check the generated provider config and OpenCode harness install.",
    },
  });
});
