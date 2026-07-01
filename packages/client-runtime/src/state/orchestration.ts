import { ORCHESTRATION_WS_METHODS } from "@t3tools/contracts";
import * as Stream from "effect/Stream";
import { Atom } from "effect/unstable/reactivity";

import {
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

export function createOrchestrationEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    turnDiff: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:turn-diff",
      tag: ORCHESTRATION_WS_METHODS.getTurnDiff,
    }),
    fullThreadDiff: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:full-thread-diff",
      tag: ORCHESTRATION_WS_METHODS.getFullThreadDiff,
    }),
    projectModelAnalytics: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:project-model-analytics",
      tag: ORCHESTRATION_WS_METHODS.getProjectModelAnalytics,
      staleTimeMs: 60_000,
    }),
    archivedShellSnapshot: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:archived-shell-snapshot",
      tag: ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot,
    }),
    agentTree: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:agent-tree",
      tag: ORCHESTRATION_WS_METHODS.getAgentTree,
    }),
    agentTreeSubscription: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:orchestration:agent-tree-subscription",
      tag: ORCHESTRATION_WS_METHODS.subscribeAgentTree,
      transform: (stream) => Stream.map(stream, (item) => item.snapshot),
    }),
  };
}
