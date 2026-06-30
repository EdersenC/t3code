/**
 * LocalDriver — first-party Local Models hub driver.
 *
 * The first runtime under this hub is vLLM. T3 owns the provider identity
 * (`local`) while OpenCode receives a generated OpenAI-compatible provider
 * config (`local-vllm`) pointed at the user's running vLLM `/v1` endpoint.
 *
 * @module provider/Drivers/LocalDriver
 */
import {
  LocalSettings,
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

import { makeOpenCodeTextGeneration } from "../../textGeneration/OpenCodeTextGeneration.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeOpenCodeAdapter } from "../Layers/OpenCodeAdapter.ts";
import {
  checkLocalProviderStatus,
  makePendingLocalProvider,
  resolveLocalOpenCodeEnvironment,
} from "../Layers/LocalProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import { OpenCodeRuntime } from "../opencodeRuntime.ts";
import {
  buildLocalOpenCodeConfig,
  formatLocalOpenCodeFailureDetail,
  localModelIdsFromCandidates,
  makeLocalTokenUsageSnapshot,
} from "../localOpenCode.ts";
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
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

const decodeLocalSettings = Schema.decodeSync(LocalSettings);
const decodeOpenCodeSettings = Schema.decodeSync(OpenCodeSettings);
const DRIVER_KIND = ProviderDriverKind.make("local");
const SNAPSHOT_REFRESH_INTERVAL = Duration.minutes(2);

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

export type LocalDriverEnv =
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

function makeHarnessSettings(settings: LocalSettings): OpenCodeSettings {
  return decodeOpenCodeSettings({
    enabled: settings.enabled,
    binaryPath: settings.binaryPath,
    serverUrl: "",
    serverPassword: "",
    customModels: [],
  });
}

function makeConfigContent(settings: LocalSettings, modelSelection?: ModelSelection): string {
  const modelIds = localModelIdsFromCandidates([modelSelection?.model, ...settings.customModels]);
  return buildLocalOpenCodeConfig({ settings, modelIds });
}

export const LocalDriver: ProviderDriver<LocalSettings, LocalDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Local",
    supportsMultipleInstances: true,
  },
  configSchema: LocalSettings,
  defaultConfig: (): LocalSettings => decodeLocalSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const openCodeRuntime = yield* OpenCodeRuntime;
      const serverConfig = yield* ServerConfig;
      const httpClient = yield* HttpClient.HttpClient;
      const serverSettings = yield* ServerSettingsService;
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
      const effectiveConfig = { ...config, enabled } satisfies LocalSettings;
      const runtimeEnvironment = resolveLocalOpenCodeEnvironment(
        effectiveConfig.binaryPath,
        processEnv,
        platform,
      );
      const openCodeSettings = makeHarnessSettings(effectiveConfig);
      const maintenanceCapabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
        binaryPath: effectiveConfig.binaryPath,
        env: runtimeEnvironment,
      });

      const configContent = ({
        modelSelection,
      }: {
        readonly modelSelection?: ModelSelection | undefined;
      }) => Effect.succeed(makeConfigContent(effectiveConfig, modelSelection));

      const describeFailureDetail = (input: {
        readonly detail: string;
        readonly modelSelection?: ModelSelection | undefined;
        readonly emptyOutput?: boolean | undefined;
      }) =>
        formatLocalOpenCodeFailureDetail({
          detail: input.detail,
          model: input.modelSelection?.model,
          baseUrl: effectiveConfig.baseUrl,
          emptyOutput: input.emptyOutput,
        });

      const adapter = yield* makeOpenCodeAdapter(openCodeSettings, {
        provider: DRIVER_KIND,
        instanceId,
        environment: runtimeEnvironment,
        configContent,
        describeErrorDetail: ({ detail, modelSelection }) =>
          describeFailureDetail({ detail, modelSelection }),
        splitInlineThinking: true,
        estimateTokenUsage: (input) =>
          Effect.succeed(
            makeLocalTokenUsageSnapshot({
              inputText: input.inputText,
              assistantText: input.assistantText,
              attachmentCount: input.attachmentCount,
              contextWindow: effectiveConfig.contextWindow,
            }),
          ),
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
      });
      const textGeneration = yield* makeOpenCodeTextGeneration(
        openCodeSettings,
        runtimeEnvironment,
        {
          resolveConfigContent: ({ modelSelection }) =>
            Effect.succeed(makeConfigContent(effectiveConfig, modelSelection)),
          describeErrorDetail: ({ detail, modelSelection, emptyOutput }) =>
            describeFailureDetail({ detail, modelSelection, emptyOutput }),
        },
      );

      const checkProvider = checkLocalProviderStatus(
        effectiveConfig,
        serverConfig.cwd,
        runtimeEnvironment,
      ).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(OpenCodeRuntime, openCodeRuntime),
        Effect.provideService(HttpClient.HttpClient, httpClient),
      );

      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<LocalSettings>>({
        maintenanceCapabilities,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          makePendingLocalProvider(settings.provider).pipe(Effect.map(stampIdentity)),
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
              detail: "Failed to build Local snapshot: " + (cause.message ?? String(cause)),
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
