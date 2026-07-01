import {
  DEFAULT_OLLAMA_MODEL,
  OllamaSettings,
  OpenCodeSettings,
  ProviderDriverKind,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import { makeOpenCodeTextGeneration } from "../../textGeneration/OpenCodeTextGeneration.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeOpenCodeAdapter } from "../Layers/OpenCodeAdapter.ts";
import {
  checkOllamaProviderStatus,
  makePendingOllamaProvider,
  resolveOllamaOpenCodeEnvironment,
} from "../Layers/OllamaProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import { OpenCodeRuntime } from "../opencodeRuntime.ts";
import { makeOpenCodeCapabilityRuntimeResolver } from "../opencodeCapabilityRuntimeResolver.ts";
import { getOllamaModelMetadata, listOllamaModels } from "../ollamaApi.ts";
import {
  buildOllamaOpenCodeConfig,
  formatOllamaOpenCodeFailureDetail,
  makeOllamaTokenUsageSnapshot,
  normalizeOllamaModelId,
  ollamaModelIdsFromCandidates,
} from "../ollamaOpenCode.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  makePackageManagedProviderMaintenanceResolver,
  normalizeCommandPath,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";

const decodeOllamaSettings = Schema.decodeSync(OllamaSettings);
const decodeOpenCodeSettings = Schema.decodeSync(OpenCodeSettings);
const DRIVER_KIND = ProviderDriverKind.make("ollama");
const SNAPSHOT_REFRESH_INTERVAL = Duration.minutes(2);
const OLLAMA_MODEL_DISCOVERY_TIMEOUT_MS = 4_000;
const OLLAMA_CONTEXT_DISCOVERY_TIMEOUT_MS = 4_000;

function isOpenCodeNativeCommandPath(commandPath: string): boolean {
  const normalized = normalizeCommandPath(commandPath);
  return (
    normalized.endsWith("/.opencode/bin/opencode") ||
    normalized.endsWith("/.opencode/bin/opencode.exe")
  );
}

const UPDATE = makePackageManagedProviderMaintenanceResolver({
  provider: DRIVER_KIND,
  npmPackageName: "opencode-ai",
  homebrewFormula: "anomalyco/tap/opencode",
  nativeUpdate: {
    executable: "opencode",
    args: ["upgrade"],
    lockKey: "opencode-native",
    isCommandPath: isOpenCodeNativeCommandPath,
  },
});

export type OllamaDriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | OpenCodeRuntime
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService;

const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });

function makeHarnessSettings(settings: OllamaSettings): OpenCodeSettings {
  return decodeOpenCodeSettings({
    enabled: settings.enabled,
    binaryPath: settings.binaryPath,
    serverUrl: "",
    serverPassword: "",
    customModels: [],
  });
}

function modelIdForOllamaApi(settings: OllamaSettings, modelSelection?: ModelSelection): string {
  return (
    normalizeOllamaModelId(modelSelection?.model) ??
    normalizeOllamaModelId(settings.customModels[0]) ??
    normalizeOllamaModelId(DEFAULT_OLLAMA_MODEL)!
  );
}

function makeConfigContentEffect(
  settings: OllamaSettings,
  modelSelection?: ModelSelection,
  capabilityRuntime?: Parameters<typeof buildOllamaOpenCodeConfig>[0]["capabilityRuntime"],
) {
  return Effect.promise(() =>
    listOllamaModels(settings, { timeoutMs: OLLAMA_MODEL_DISCOVERY_TIMEOUT_MS }).catch(
      () => [] as ReadonlyArray<string>,
    ),
  ).pipe(
    Effect.map((discoveredModels) => {
      const modelIds = ollamaModelIdsFromCandidates([
        ...discoveredModels,
        modelSelection?.model,
        ...settings.customModels,
        DEFAULT_OLLAMA_MODEL,
      ]);
      return buildOllamaOpenCodeConfig({
        settings,
        modelIds,
        modelSelection,
        ...(capabilityRuntime ? { capabilityRuntime } : {}),
      });
    }),
  );
}

export const OllamaDriver: ProviderDriver<OllamaSettings, OllamaDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Ollama",
    supportsMultipleInstances: true,
  },
  configSchema: OllamaSettings,
  defaultConfig: (): OllamaSettings => decodeOllamaSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const openCodeRuntime = yield* OpenCodeRuntime;
      const serverConfig = yield* ServerConfig;
      const httpClient = yield* HttpClient.HttpClient;
      const serverSettings = yield* ServerSettingsService;
      const fileSystem = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const eventLoggers = yield* ProviderEventLoggers;
      const platform = yield* HostProcessPlatform;
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const effectiveConfig = { ...config, enabled } satisfies OllamaSettings;
      const contextWindowByModel = new Map<string, number | null>();
      const describeFailureDetail = (input: {
        readonly detail: string;
        readonly modelSelection?: ModelSelection | undefined;
        readonly emptyOutput?: boolean | undefined;
      }) =>
        formatOllamaOpenCodeFailureDetail({
          detail: input.detail,
          model: input.modelSelection?.model,
          baseUrl: effectiveConfig.baseUrl,
          emptyOutput: input.emptyOutput,
        });
      const resolveContextWindow = (modelSelection?: ModelSelection | undefined) => {
        const modelId = modelIdForOllamaApi(effectiveConfig, modelSelection);
        if (contextWindowByModel.has(modelId)) {
          return Effect.succeed(contextWindowByModel.get(modelId) ?? null);
        }
        return Effect.promise(() =>
          getOllamaModelMetadata(effectiveConfig, modelId, {
            timeoutMs: OLLAMA_CONTEXT_DISCOVERY_TIMEOUT_MS,
          })
            .then((metadata) => metadata.contextWindow)
            .catch(() => null),
        ).pipe(
          Effect.tap((contextWindow) =>
            contextWindow === null
              ? Effect.void
              : Effect.sync(() => {
                  contextWindowByModel.set(modelId, contextWindow);
                }),
          ),
        );
      };
      const runtimeEnvironment = resolveOllamaOpenCodeEnvironment(
        effectiveConfig.binaryPath,
        processEnv,
        platform,
      );
      const openCodeSettings = makeHarnessSettings(effectiveConfig);
      const resolveCapabilityRuntime = makeOpenCodeCapabilityRuntimeResolver({
        serverConfig,
        serverSettings,
        instanceId,
        fileSystem,
        pathService,
      });
      const maintenanceCapabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
        binaryPath: effectiveConfig.binaryPath,
        env: runtimeEnvironment,
      });
      const configContent = ({
        modelSelection,
      }: {
        readonly modelSelection?: ModelSelection | undefined;
      }) => makeConfigContentEffect(effectiveConfig, modelSelection);

      const adapter = yield* makeOpenCodeAdapter(openCodeSettings, {
        provider: DRIVER_KIND,
        instanceId,
        environment: runtimeEnvironment,
        configContent,
        capabilityRuntime: resolveCapabilityRuntime,
        describeErrorDetail: ({ detail, modelSelection, emptyOutput }) =>
          describeFailureDetail({ detail, modelSelection, emptyOutput }),
        splitInlineThinking: true,
        estimateTokenUsage: (input) =>
          resolveContextWindow(input.modelSelection).pipe(
            Effect.map((contextWindow) =>
              makeOllamaTokenUsageSnapshot({
                inputText: input.inputText,
                assistantText: input.assistantText,
                attachmentCount: input.attachmentCount,
                contextWindow,
              }),
            ),
          ),
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
      });
      const textGeneration = yield* makeOpenCodeTextGeneration(
        openCodeSettings,
        runtimeEnvironment,
        {
          resolveConfigContent: ({ modelSelection }) =>
            Effect.gen(function* () {
              const capabilityRuntime = yield* resolveCapabilityRuntime();
              return yield* makeConfigContentEffect(
                effectiveConfig,
                modelSelection,
                capabilityRuntime,
              );
            }),
          describeErrorDetail: ({ detail, modelSelection, emptyOutput }) =>
            describeFailureDetail({ detail, modelSelection, emptyOutput }),
        },
      );

      const checkProvider = checkOllamaProviderStatus(
        effectiveConfig,
        serverConfig.cwd,
        runtimeEnvironment,
        { timeoutMs: OLLAMA_MODEL_DISCOVERY_TIMEOUT_MS },
      ).pipe(Effect.map(stampIdentity), Effect.provideService(OpenCodeRuntime, openCodeRuntime));

      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<OllamaSettings>>({
        maintenanceCapabilities,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          makePendingOllamaProvider(settings.provider).pipe(Effect.map(stampIdentity)),
        checkProvider,
        enrichSnapshot: ({ settings, snapshot, publishSnapshot }) =>
          enrichProviderSnapshotWithVersionAdvisory(snapshot, maintenanceCapabilities, {
            enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
          }).pipe(
            Effect.provideService(HttpClient.HttpClient, httpClient),
            Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
          ),
        refreshInterval: SNAPSHOT_REFRESH_INTERVAL,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: "Failed to build Ollama snapshot: " + (cause.message ?? String(cause)),
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
