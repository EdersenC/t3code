import type { ProviderInstanceId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  buildOpenCodeCapabilityRuntimeEffect,
  emptyOpenCodeCapabilityRuntime,
  type OpenCodeCapabilityRuntime,
} from "../capabilities/T3CapabilityRegistry.ts";
import type { ServerConfig } from "../config.ts";
import type { ServerSettingsService } from "../serverSettings.ts";

export function makeOpenCodeCapabilityRuntimeResolver(input: {
  readonly serverConfig: Pick<ServerConfig["Service"], "cwd" | "stateDir">;
  readonly serverSettings: Pick<ServerSettingsService["Service"], "getSettings">;
  readonly instanceId: ProviderInstanceId;
  readonly fileSystem: FileSystem.FileSystem;
  readonly pathService: Path.Path;
}): () => Effect.Effect<OpenCodeCapabilityRuntime> {
  const runtimeRoot = input.pathService.join(
    input.serverConfig.stateDir,
    "capabilities",
    "opencode",
    input.instanceId,
  );
  return () =>
    input.serverSettings.getSettings.pipe(
      Effect.flatMap((settings) =>
        buildOpenCodeCapabilityRuntimeEffect({
          settings,
          cwd: input.serverConfig.cwd,
          runtimeRoot,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, input.fileSystem),
          Effect.provideService(Path.Path, input.pathService),
        ),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("Failed to build OpenCode capability runtime.", {
          cause: Cause.pretty(cause),
          providerInstanceId: input.instanceId,
        }).pipe(Effect.as(emptyOpenCodeCapabilityRuntime())),
      ),
    );
}
