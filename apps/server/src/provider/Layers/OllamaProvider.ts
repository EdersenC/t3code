import {
  DEFAULT_OLLAMA_MODEL,
  ProviderDriverKind,
  type ModelCapabilities,
  type OllamaSettings,
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
import { mergePathValues } from "@t3tools/shared/shell";
import {
  buildServerProvider,
  parseGenericCliVersion,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  getOllamaVersion,
  listOllamaModels,
  listRunningOllamaModels,
  normalizeOllamaBaseUrl,
  type OllamaFetch,
  type OllamaRunningModel,
} from "../ollamaApi.ts";
import {
  buildOllamaOpenCodeConfig,
  isOllamaRunningModelCpuOnly,
  isOllamaRunningModelGpuResident,
  normalizeOllamaModelId,
  ollamaModelIdsForConfig,
  toOllamaOpenCodeModelSlug,
} from "../ollamaOpenCode.ts";
import { flattenOpenCodeModels, MINIMUM_OPENCODE_VERSION } from "./OpenCodeProvider.ts";
import {
  OpenCodeRuntime,
  openCodeRuntimeErrorDetail,
  type OpenCodeInventory,
} from "../opencodeRuntime.ts";

const PROVIDER = ProviderDriverKind.make("ollama");
const OPENCODE_COMMAND = "opencode";
const OLLAMA_PRESENTATION = {
  displayName: "Ollama",
  showInteractionModeToggle: false,
} as const;

class OllamaProbeError extends Data.TaggedError("OllamaProbeError")<{
  readonly cause: unknown;
  readonly detail: string;
}> {}

export function resolveOllamaOpenCodeBinaryPath(binaryPath: string): string {
  return binaryPath.trim() || OPENCODE_COMMAND;
}

export function resolveOllamaOpenCodeEnvironment(
  binaryPath: string,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
  const command = resolveOllamaOpenCodeBinaryPath(binaryPath);
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

export interface OllamaProviderOptions {
  readonly fetchFn?: OllamaFetch | undefined;
  readonly timeoutMs?: number | undefined;
}

const DEFAULT_OLLAMA_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

function modelDisplayName(modelId: string): string {
  return modelId.trim() || normalizeOllamaModelId(DEFAULT_OLLAMA_MODEL)!;
}

function modelEntryFromId(modelId: string, isCustom: boolean): ServerProviderModel | null {
  const slug = toOllamaOpenCodeModelSlug(modelId);
  if (!slug) return null;
  return {
    slug,
    name: modelDisplayName(modelId),
    subProvider: "Local",
    isCustom,
    capabilities: DEFAULT_OLLAMA_MODEL_CAPABILITIES,
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
  settings: Pick<OllamaSettings, "customModels">,
): ReadonlyArray<ServerProviderModel> {
  const seen = new Set(discovered.map((model) => model.slug));
  const models = [...discovered];
  for (const modelId of ollamaModelIdsForConfig({ settings })) {
    const entry = modelEntryFromId(modelId, true);
    if (!entry || seen.has(entry.slug)) continue;
    seen.add(entry.slug);
    models.push(entry);
  }
  return models.toSorted((left, right) => left.name.localeCompare(right.name));
}

function fallbackModels(settings: OllamaSettings, discoveredModels: ReadonlyArray<string> = []) {
  const modelIds = ollamaModelIdsForConfig({ settings, discoveredModels });
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

function describeRunningModel(model: OllamaRunningModel): string {
  const name = model.model || model.name;
  if (model.sizeVramBytes === null || model.sizeBytes === null || model.sizeBytes <= 0) {
    return name;
  }
  const percent = Math.round((model.sizeVramBytes / model.sizeBytes) * 100);
  return name + " (" + percent + "% in VRAM)";
}

function ollamaModelsFromOpenCodeInventory(
  inventory: OpenCodeInventory,
): ReadonlyArray<ServerProviderModel> {
  return flattenOpenCodeModels(inventory).filter((model) => model.slug.startsWith("ollama/"));
}

export const makePendingOllamaProvider = (
  ollamaSettings: OllamaSettings,
): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    return buildServerProvider({
      driver: PROVIDER,
      presentation: OLLAMA_PRESENTATION,
      enabled: ollamaSettings.enabled,
      checkedAt,
      models: fallbackModels(ollamaSettings),
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking local Ollama and OpenCode harness...",
      },
    });
  });

export const checkOllamaProviderStatus = Effect.fn("checkOllamaProviderStatus")(function* (
  ollamaSettings: OllamaSettings,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
  options?: OllamaProviderOptions,
): Effect.fn.Return<ServerProviderDraft, never, OpenCodeRuntime> {
  const openCodeRuntime = yield* OpenCodeRuntime;
  const resolvedEnvironment = environment ?? process.env;
  const platform = yield* HostProcessPlatform;
  const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
  const baseUrl = normalizeOllamaBaseUrl(ollamaSettings.baseUrl);
  const binaryPath = resolveOllamaOpenCodeBinaryPath(ollamaSettings.binaryPath);
  const openCodeEnvironment = resolveOllamaOpenCodeEnvironment(
    ollamaSettings.binaryPath,
    resolvedEnvironment,
    platform,
  );

  if (!ollamaSettings.enabled) {
    return buildServerProvider({
      driver: PROVIDER,
      presentation: OLLAMA_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels(ollamaSettings),
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Ollama is disabled in T3 Code settings.",
      },
    });
  }

  const ollamaProbeExit = yield* Effect.exit(
    Effect.tryPromise({
      try: async () => {
        const [ollamaVersion, discoveredModels, runningModels] = await Promise.all([
          getOllamaVersion(ollamaSettings, options),
          listOllamaModels(ollamaSettings, options),
          listRunningOllamaModels(ollamaSettings, options).catch(
            () => [] as ReadonlyArray<OllamaRunningModel>,
          ),
        ]);
        return { ollamaVersion, discoveredModels, runningModels };
      },
      catch: (cause) =>
        new OllamaProbeError({
          cause,
          detail: cause instanceof Error ? cause.message : String(cause),
        }),
    }),
  );

  if (Exit.isFailure(ollamaProbeExit)) {
    const cause = Cause.squash(ollamaProbeExit.cause);
    const detail =
      cause instanceof OllamaProbeError ? cause.detail : "Ollama server is unreachable.";
    return buildServerProvider({
      driver: PROVIDER,
      presentation: OLLAMA_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels(ollamaSettings),
      probe: {
        installed: false,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Couldn't reach the local Ollama server at " + baseUrl + ". " + detail,
      },
    });
  }

  const modelIds = ollamaModelIdsForConfig({
    settings: ollamaSettings,
    discoveredModels: ollamaProbeExit.value.discoveredModels,
  });
  const modelFallback = fallbackModels(ollamaSettings, ollamaProbeExit.value.discoveredModels);
  const configContent = buildOllamaOpenCodeConfig({ settings: ollamaSettings, modelIds });

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
      presentation: OLLAMA_PRESENTATION,
      enabled: true,
      checkedAt,
      models: modelFallback,
      probe: {
        installed: !missing,
        version: null,
        status: "error",
        auth: { status: "authenticated", type: "local", label: baseUrl },
        message: missing
          ? "Ollama is running, but OpenCode CLI (opencode) is not installed or not on PATH."
          : "Ollama is running, but OpenCode CLI health check failed: " +
            openCodeFailureMessage(cause),
      },
    });
  }

  const openCodeVersion = parseGenericCliVersion(versionExit.value.stdout);
  if (!openCodeVersion) {
    return buildServerProvider({
      driver: PROVIDER,
      presentation: OLLAMA_PRESENTATION,
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
      presentation: OLLAMA_PRESENTATION,
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
      presentation: OLLAMA_PRESENTATION,
      enabled: true,
      checkedAt,
      models: modelFallback,
      probe: {
        installed: true,
        version: openCodeVersion,
        status: "error",
        auth: { status: "authenticated", type: "local", label: baseUrl },
        message:
          "Ollama is running, but OpenCode could not load the generated Ollama provider config: " +
          openCodeFailureMessage(cause),
      },
    });
  }

  const openCodeModels = ollamaModelsFromOpenCodeInventory(inventoryExit.value);
  const hasOpenCodeOllamaModels = openCodeModels.length > 0;
  const models = modelsWithConfiguredEntries(openCodeModels, ollamaSettings);
  const discoveredModelCount = ollamaProbeExit.value.discoveredModels.length;
  const runningModels = ollamaProbeExit.value.runningModels;
  const configuredModelIds = new Set(
    modelIds
      .map((modelId) => normalizeOllamaModelId(modelId))
      .filter((modelId): modelId is string => modelId !== null),
  );
  const relevantRunningModels = runningModels.filter((model) => {
    const modelId = normalizeOllamaModelId(model.model) ?? normalizeOllamaModelId(model.name);
    return modelId !== null && configuredModelIds.has(modelId);
  });
  const cpuOnlyModel = relevantRunningModels.find(isOllamaRunningModelCpuOnly);
  const gpuResidentCount = relevantRunningModels.filter(isOllamaRunningModelGpuResident).length;
  const hasCpuOnlyViolation = cpuOnlyModel !== undefined && !ollamaSettings.allowCpuFallback;
  const hasOpenCodeProviderConfigViolation = discoveredModelCount > 0 && !hasOpenCodeOllamaModels;

  return buildServerProvider({
    driver: PROVIDER,
    presentation: OLLAMA_PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    probe: {
      installed: true,
      version: openCodeVersion,
      status: hasOpenCodeProviderConfigViolation
        ? "error"
        : hasCpuOnlyViolation
          ? "error"
          : cpuOnlyModel !== undefined
            ? "warning"
            : hasOpenCodeOllamaModels && discoveredModelCount > 0
              ? "ready"
              : "warning",
      auth: { status: "authenticated", type: "local", label: baseUrl },
      ...(hasOpenCodeProviderConfigViolation
        ? {
            message:
              "Ollama is reachable, but OpenCode did not expose any generated Ollama models. Check the generated provider config and OpenCode harness install.",
          }
        : hasCpuOnlyViolation
          ? {
              message:
                "Ollama has loaded " +
                describeRunningModel(cpuOnlyModel) +
                " on CPU instead of GPU. Free GPU memory, use a smaller model, or accept CPU fallback in Ollama settings if slower CPU inference is acceptable.",
            }
          : cpuOnlyModel !== undefined
            ? {
                message:
                  "Ollama CPU fallback is accepted and " +
                  describeRunningModel(cpuOnlyModel) +
                  " is currently CPU-backed. Turn this off after freeing GPU memory to require GPU residency.",
              }
            : hasOpenCodeOllamaModels && discoveredModelCount > 0
              ? {
                  message:
                    "Ollama is reachable and OpenCode loaded " +
                    openCodeModels.length +
                    " local model" +
                    (openCodeModels.length === 1 ? "" : "s") +
                    (gpuResidentCount > 0 ? " with GPU residency detected." : "."),
                }
              : {
                  message:
                    "Ollama is running, but no installed local models were discovered. Run ollama pull " +
                    normalizeOllamaModelId(DEFAULT_OLLAMA_MODEL) +
                    " or add a custom model.",
                }),
    },
  });
});
