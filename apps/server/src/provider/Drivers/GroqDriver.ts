import {
  DEFAULT_GROQ_MODEL,
  GroqSettings,
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
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeOpenCodeTextGeneration } from "../../textGeneration/OpenCodeTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { checkGroqProviderStatus, makePendingGroqProvider } from "../Layers/GroqCloudProvider.ts";
import { makeOpenCodeAdapter } from "../Layers/OpenCodeAdapter.ts";
import { resolveOllamaOpenCodeEnvironment } from "../Layers/OllamaProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import { listGroqModels } from "../groqApi.ts";
import {
  buildGroqOpenCodeConfig,
  formatGroqOpenCodeFailureDetail,
  isGroqOpenCodeConfiguredModel,
  isGroqOpenCodeDiscoveredModel,
  normalizeGroqModelId,
} from "../groqOpenCode.ts";
import { OpenCodeRuntime } from "../opencodeRuntime.ts";
import { makeOpenCodeCapabilityRuntimeResolver } from "../opencodeCapabilityRuntimeResolver.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  makePackageManagedProviderMaintenanceResolver,
  normalizeCommandPath,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";

const decodeGroqSettings = Schema.decodeSync(GroqSettings);
const decodeOpenCodeSettings = Schema.decodeSync(OpenCodeSettings);
const DRIVER_KIND = ProviderDriverKind.make("groq");
const SNAPSHOT_REFRESH_INTERVAL = Duration.minutes(5);
const GROQ_MODEL_DISCOVERY_TIMEOUT_MS = 4_000;

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

export type GroqDriverEnv =
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

function makeHarnessSettings(settings: GroqSettings): OpenCodeSettings {
  return decodeOpenCodeSettings({
    enabled: settings.enabled,
    binaryPath: settings.binaryPath,
    serverUrl: "",
    serverPassword: "",
    customModels: [],
  });
}

function makeConfigContentEffect(
  settings: GroqSettings,
  environment: NodeJS.ProcessEnv,
  modelSelection?: ModelSelection,
  capabilityRuntime?: Parameters<typeof buildGroqOpenCodeConfig>[0]["capabilityRuntime"],
) {
  return Effect.promise(() =>
    listGroqModels(settings, environment, { timeoutMs: GROQ_MODEL_DISCOVERY_TIMEOUT_MS }).catch(
      () => [],
    ),
  ).pipe(
    Effect.map((discoveredModels) => {
      const selectedModel = modelSelection?.model;
      const modelIds = [
        ...discoveredModels.filter((model) => isGroqOpenCodeDiscoveredModel(model)),
        ...(selectedModel && isGroqOpenCodeConfiguredModel(selectedModel) ? [selectedModel] : []),
        ...settings.customModels.filter((model) => isGroqOpenCodeConfiguredModel(model)),
        DEFAULT_GROQ_MODEL,
      ];
      return buildGroqOpenCodeConfig({
        settings,
        modelIds,
        environment,
        ...(capabilityRuntime ? { capabilityRuntime } : {}),
      });
    }),
  );
}

export const GroqDriver: ProviderDriver<GroqSettings, GroqDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Groq",
    supportsMultipleInstances: true,
  },
  configSchema: GroqSettings,
  defaultConfig: (): GroqSettings => decodeGroqSettings({}),
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
      const effectiveConfig = { ...config, enabled } satisfies GroqSettings;
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
      const describeFailureDetail = (input: {
        readonly detail: string;
        readonly modelSelection?: ModelSelection | undefined;
        readonly emptyOutput?: boolean | undefined;
      }) =>
        formatGroqOpenCodeFailureDetail({
          detail: input.detail,
          model: normalizeGroqModelId(input.modelSelection?.model),
          baseUrl: effectiveConfig.baseUrl,
          emptyOutput: input.emptyOutput,
        });
      const configContent = ({
        modelSelection,
      }: {
        readonly modelSelection?: ModelSelection | undefined;
      }) => makeConfigContentEffect(effectiveConfig, runtimeEnvironment, modelSelection);

      const adapter = yield* makeOpenCodeAdapter(openCodeSettings, {
        provider: DRIVER_KIND,
        instanceId,
        environment: runtimeEnvironment,
        configContent,
        capabilityRuntime: resolveCapabilityRuntime,
        describeErrorDetail: ({ detail, modelSelection, emptyOutput }) =>
          describeFailureDetail({ detail, modelSelection, emptyOutput }),
        splitInlineThinking: true,
        failTurnOnStepFailure: true,
        failTurnOnRetryStatus: true,
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
                runtimeEnvironment,
                modelSelection,
                capabilityRuntime,
              );
            }),
          describeErrorDetail: ({ detail, modelSelection, emptyOutput }) =>
            describeFailureDetail({ detail, modelSelection, emptyOutput }),
        },
      );

      const checkProvider = checkGroqProviderStatus(
        effectiveConfig,
        serverConfig.cwd,
        runtimeEnvironment,
        { timeoutMs: GROQ_MODEL_DISCOVERY_TIMEOUT_MS },
      ).pipe(Effect.map(stampIdentity), Effect.provideService(OpenCodeRuntime, openCodeRuntime));

      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<GroqSettings>>({
        maintenanceCapabilities,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          makePendingGroqProvider(settings.provider).pipe(Effect.map(stampIdentity)),
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
              detail: "Failed to build Groq snapshot: " + (cause.message ?? String(cause)),
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
