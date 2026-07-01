import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  MessageId,
  RuntimeMode,
  type AgentKind,
  type T3SubagentRunChildResult,
  type T3SubagentRunError,
  type T3SubagentRunInput,
  type T3SubagentRunResult,
  type T3SubagentSpec,
  type T3SubagentType,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import {
  loadT3CapabilityRegistryEffect,
  type T3CapabilityRegistry,
} from "../capabilities/T3CapabilityRegistry.ts";
import {
  AGENT_GRAPH_LIMITS,
  agentKindForSubagentType,
  agentMetadataForThread,
} from "../orchestration/agentGraph.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";

const TOOL_CAPABILITY_ID = "t3:tool:subagent";
const subagentCapabilityId = (type: T3SubagentType) => `t3:subagent:${type}`;

const makeError = (code: T3SubagentRunError["code"], message: string): T3SubagentRunError => ({
  code,
  message,
});

interface NormalizedSubagentSpec {
  readonly subagentType: T3SubagentType;
  readonly agentKind: AgentKind;
  readonly title: string;
  readonly prompt: string;
  readonly priority?: number;
}

interface NormalizedSpawnRequest {
  parentThreadId?: ThreadId;
  rootThreadId?: ThreadId;
  parentTurnId?: TurnId;
  spawnedByToolCallId?: string;
  spawnGroupId?: string;
  readonly agents: ReadonlyArray<NormalizedSubagentSpec>;
}

const titleFor = (type: T3SubagentType, title?: string): string =>
  title ?? `${type[0]?.toUpperCase()}${type.slice(1)}`;

const runtimeModeFor = (type: T3SubagentType, parentRuntimeMode: RuntimeMode): RuntimeMode =>
  type === "implement" ? parentRuntimeMode : "approval-required";

const profileInstruction = (type: T3SubagentType): string => {
  switch (type) {
    case "explore":
      return [
        "You are the T3 explore subagent.",
        "Inspect the codebase, gather evidence, and report findings without editing files.",
      ].join("\n");
    case "implement":
      return [
        "You are the T3 implement subagent.",
        "Make a narrow code change, keep edits scoped, and report verification evidence.",
      ].join("\n");
    case "review":
      return [
        "You are the T3 review subagent.",
        "Review for bugs, regressions, missing tests, and contract drift. Lead with findings.",
      ].join("\n");
  }
};

function buildPrompt(spec: NormalizedSubagentSpec): string {
  return [profileInstruction(spec.subagentType), "", spec.prompt].join("\n");
}

function normalizeSubagentSpec(
  spec: T3SubagentSpec,
): Effect.Effect<NormalizedSubagentSpec, T3SubagentRunError> {
  const subagentType = spec.subagentType ?? spec.type;
  if (subagentType === undefined) {
    return Effect.fail(
      makeError(
        "invalid_input",
        "Each subagent spec must include a supported type or subagentType.",
      ),
    );
  }
  const agentKind = spec.agentKind ?? agentKindForSubagentType(subagentType);
  return Effect.succeed({
    subagentType,
    agentKind,
    title: titleFor(subagentType, spec.title ?? spec.displayName),
    prompt: spec.prompt,
    ...(spec.priority !== undefined ? { priority: spec.priority } : {}),
  });
}

const normalizeSpawnRequest = (
  input: T3SubagentRunInput,
): Effect.Effect<NormalizedSpawnRequest, T3SubagentRunError> =>
  Effect.gen(function* () {
    const specs =
      input.agents !== undefined && input.agents.length > 0
        ? input.agents
        : input.subagentType !== undefined && input.prompt !== undefined
          ? [
              {
                subagentType: input.subagentType,
                prompt: input.prompt,
                ...(input.title !== undefined ? { title: input.title } : {}),
              },
            ]
          : [];
    if (specs.length === 0) {
      return yield* Effect.fail(
        makeError(
          "invalid_input",
          "Provide either the legacy subagentType/prompt fields or a non-empty agents array.",
        ),
      );
    }
    const agents = yield* Effect.forEach(specs, normalizeSubagentSpec, { concurrency: 1 });
    const request: NormalizedSpawnRequest = {
      agents,
    };
    if (input.parentThreadId !== undefined) {
      request.parentThreadId = input.parentThreadId;
    }
    if (input.rootThreadId !== undefined) {
      request.rootThreadId = input.rootThreadId;
    }
    if (input.parentTurnId !== undefined) {
      request.parentTurnId = input.parentTurnId;
    }
    if (input.spawnedByToolCallId !== undefined) {
      request.spawnedByToolCallId = input.spawnedByToolCallId;
    }
    if (input.spawnGroupId !== undefined) {
      request.spawnGroupId = input.spawnGroupId;
    }
    return request;
  });

function assertCapabilityEnabled(
  registry: T3CapabilityRegistry,
  capabilityId: string,
): Effect.Effect<void, T3SubagentRunError> {
  const capability = registry.snapshot.capabilities.find(
    (candidate) => candidate.id === capabilityId,
  );
  if (!capability || !capability.enabled || capability.activation === "hidden") {
    return Effect.fail(makeError("disabled", `Subagent capability '${capabilityId}' is disabled.`));
  }
  return Effect.void;
}

export interface T3SubagentRuntimeShape {
  readonly run: (
    input: T3SubagentRunInput,
  ) => Effect.Effect<
    T3SubagentRunResult,
    T3SubagentRunError,
    McpInvocationContext.McpInvocationContext
  >;
}

export class T3SubagentRuntime extends Context.Service<T3SubagentRuntime, T3SubagentRuntimeShape>()(
  "t3/mcp/T3SubagentRuntime",
) {}

export const withRuntime = <A, E, R>(
  f: (runtime: T3SubagentRuntimeShape) => Effect.Effect<A, E, R>,
) => Effect.flatMap(T3SubagentRuntime, f);

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const settings = yield* ServerSettingsService;
  const projection = yield* ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngineService;

  const randomUuid = crypto.randomUUIDv4.pipe(Effect.orDie);
  const nextCommandId = (label: string) =>
    randomUuid.pipe(Effect.map((uuid) => CommandId.make(`mcp:subagent:${label}:${uuid}`)));

  const dispatch = (command: Parameters<OrchestrationEngineShape["dispatch"]>[0]) =>
    engine
      .dispatch(command)
      .pipe(
        Effect.mapError((error) =>
          makeError("dispatch_failed", `Failed to start subagent thread: ${error.message}`),
        ),
      );

  const appendSpawnFailureActivity = (input: {
    readonly parentThreadId: ThreadId;
    readonly rootThreadId: ThreadId;
    readonly parentTurnId: TurnId | null;
    readonly spawnGroupId: string;
    readonly message: string;
    readonly createdAt: string;
  }) =>
    Effect.gen(function* () {
      yield* Effect.forEach(
        [input.parentThreadId, input.rootThreadId].filter(
          (candidate, index, array) => array.indexOf(candidate) === index,
        ),
        (threadId) =>
          Effect.gen(function* () {
            yield* dispatch({
              type: "thread.activity.append",
              commandId: yield* nextCommandId("spawn-failed-activity"),
              threadId,
              activity: {
                id: EventId.make(`mcp:subagents:spawn-failed:${yield* randomUuid}`),
                tone: "error",
                kind: "t3.subagents.spawn.failed",
                summary: "Subagent spawn rejected",
                payload: {
                  capabilityId: TOOL_CAPABILITY_ID,
                  capabilityKind: "tool",
                  capabilitySource: "t3",
                  harnessName: "T3 MCP",
                  toolName: "t3_subagent",
                  spawnGroupId: input.spawnGroupId,
                  parentThreadId: input.parentThreadId,
                  rootThreadId: input.rootThreadId,
                  status: "failed",
                  message: input.message,
                },
                turnId: input.parentTurnId,
                createdAt: input.createdAt,
              },
              createdAt: input.createdAt,
            });
          }),
        { concurrency: 1 },
      );
    });

  const run: T3SubagentRuntimeShape["run"] = Effect.fn("T3SubagentRuntime.run")(function* (input) {
    const invocation = yield* McpInvocationContext.requireMcpCapability(
      McpInvocationContext.T3_SUBAGENT_MCP_CAPABILITY,
    ).pipe(
      Effect.mapError(() =>
        makeError("capability_unavailable", "MCP credential does not grant t3_subagent access."),
      ),
    );
    const spawnRequest = yield* normalizeSpawnRequest(input);
    if (
      spawnRequest.parentThreadId !== undefined &&
      spawnRequest.parentThreadId !== invocation.threadId
    ) {
      return yield* Effect.fail(
        makeError("invalid_input", "parentThreadId must match the current MCP invocation thread."),
      );
    }

    const currentSettings = yield* settings.getSettings.pipe(
      Effect.mapError((error) =>
        makeError("registry_unavailable", `Failed to read subagent settings: ${error.message}`),
      ),
    );
    const registry = yield* loadT3CapabilityRegistryEffect({
      settings: currentSettings,
      cwd: process.cwd(),
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.mapError((error) =>
        makeError("registry_unavailable", `Failed to load subagent registry: ${error.message}`),
      ),
    );
    yield* assertCapabilityEnabled(registry, TOOL_CAPABILITY_ID);
    yield* Effect.forEach(
      new Set(spawnRequest.agents.map((agent) => agent.subagentType)),
      (subagentType) => assertCapabilityEnabled(registry, subagentCapabilityId(subagentType)),
      { concurrency: 1 },
    );

    const parentThreadOption = yield* projection
      .getThreadDetailById(invocation.threadId)
      .pipe(
        Effect.mapError((error) =>
          makeError("parent_thread_missing", `Failed to load parent thread: ${error.message}`),
        ),
      );
    if (Option.isNone(parentThreadOption)) {
      return yield* Effect.fail(
        makeError("parent_thread_missing", `Parent thread '${invocation.threadId}' was not found.`),
      );
    }

    const parentThread = parentThreadOption.value;
    const parentAgentMetadata = agentMetadataForThread(parentThread);
    const rootThreadId = parentAgentMetadata.rootThreadId;
    if (spawnRequest.rootThreadId !== undefined && spawnRequest.rootThreadId !== rootThreadId) {
      return yield* Effect.fail(
        makeError("invalid_input", "rootThreadId must match the parent thread's root session."),
      );
    }

    const createdAt = DateTime.formatIso(yield* DateTime.now);
    const spawnGroupId =
      spawnRequest.spawnGroupId ?? `t3:subagent:spawn:${String(yield* randomUuid)}`;
    const parentTurnId = spawnRequest.parentTurnId ?? parentThread.latestTurn?.turnId ?? null;

    const failWithActivity = (message: string, code: T3SubagentRunError["code"]) =>
      Effect.gen(function* () {
        yield* appendSpawnFailureActivity({
          parentThreadId: parentThread.id,
          rootThreadId,
          parentTurnId,
          spawnGroupId,
          message,
          createdAt,
        });
        return yield* Effect.fail(makeError(code, message));
      });

    if (parentAgentMetadata.depth >= AGENT_GRAPH_LIMITS.maxDepth) {
      return yield* failWithActivity(
        `Subagent depth limit ${AGENT_GRAPH_LIMITS.maxDepth} would be exceeded.`,
        "limit_exceeded",
      );
    }

    const childThreads = yield* projection
      .listChildAgentThreads(parentThread.id)
      .pipe(
        Effect.mapError((error) =>
          makeError("read_model_unavailable", `Failed to load child agents: ${error.message}`),
        ),
      );
    if (
      childThreads.length + spawnRequest.agents.length >
      AGENT_GRAPH_LIMITS.maxChildrenPerParent
    ) {
      return yield* failWithActivity(
        `Subagent child limit ${AGENT_GRAPH_LIMITS.maxChildrenPerParent} would be exceeded.`,
        "limit_exceeded",
      );
    }

    const rootTree = yield* projection
      .getAgentTreeByRootThreadId(rootThreadId)
      .pipe(
        Effect.mapError((error) =>
          makeError("read_model_unavailable", `Failed to load root agent tree: ${error.message}`),
        ),
      );
    const activeAgentCount = Option.isSome(rootTree) ? rootTree.value.activeAgentCount : 0;
    if (activeAgentCount + spawnRequest.agents.length > AGENT_GRAPH_LIMITS.maxActiveAgentsPerRoot) {
      return yield* failWithActivity(
        `Active agent limit ${AGENT_GRAPH_LIMITS.maxActiveAgentsPerRoot} would be exceeded.`,
        "limit_exceeded",
      );
    }

    const children = yield* Effect.forEach(
      spawnRequest.agents,
      (agent) =>
        Effect.gen(function* () {
          const childThreadId = ThreadId.make(`subagent:${yield* randomUuid}`);
          const childMessageId = MessageId.make(`subagent-message:${yield* randomUuid}`);
          const runtimeMode = runtimeModeFor(agent.subagentType, parentThread.runtimeMode);
          const queueKey = `thread:${childThreadId}`;

          yield* dispatch({
            type: "thread.create",
            commandId: yield* nextCommandId("create"),
            threadId: childThreadId,
            projectId: parentThread.projectId,
            title: agent.title,
            modelSelection: parentThread.modelSelection,
            runtimeMode,
            interactionMode: parentThread.interactionMode,
            branch: parentThread.branch,
            worktreePath: parentThread.worktreePath,
            agentMetadata: {
              rootThreadId,
              parentThreadId: parentThread.id,
              agentRole: "subagent",
              agentKind: agent.agentKind,
              displayName: agent.title,
              ...(parentTurnId !== null ? { spawnedByTurnId: parentTurnId } : {}),
              ...(spawnRequest.spawnedByToolCallId !== undefined
                ? { spawnedByToolCallId: spawnRequest.spawnedByToolCallId }
                : {}),
              spawnGroupId,
            },
            createdAt,
          });

          yield* dispatch({
            type: "thread.turn.start",
            commandId: yield* nextCommandId("turn"),
            threadId: childThreadId,
            message: {
              messageId: childMessageId,
              role: "user",
              text: buildPrompt(agent),
              attachments: [],
            },
            modelSelection: parentThread.modelSelection,
            titleSeed: agent.title,
            runtimeMode,
            interactionMode: parentThread.interactionMode,
            createdAt,
          });

          return {
            status: "started" as const,
            parentThreadId: parentThread.id,
            rootThreadId,
            childThreadId,
            childMessageId,
            subagentType: agent.subagentType,
            agentKind: agent.agentKind,
            title: agent.title,
            queueKey,
          } satisfies T3SubagentRunChildResult;
        }),
      { concurrency: 1 },
    );

    yield* Effect.forEach(
      [parentThread.id, rootThreadId].filter(
        (candidate, index, array) => array.indexOf(candidate) === index,
      ),
      (threadId) =>
        Effect.gen(function* () {
          yield* dispatch({
            type: "thread.activity.append",
            commandId: yield* nextCommandId("activity"),
            threadId,
            activity: {
              id: EventId.make(`mcp:subagents:spawned:${yield* randomUuid}`),
              tone: "tool",
              kind: "t3.subagents.spawned",
              summary:
                children.length === 1
                  ? `${children[0]?.title ?? "Subagent"} started`
                  : `${children.length} subagents started`,
              payload: {
                capabilityId: TOOL_CAPABILITY_ID,
                capabilityKind: "tool",
                capabilitySource: "t3",
                harnessName: "T3 MCP",
                toolName: "t3_subagent",
                spawnGroupId,
                parentThreadId: parentThread.id,
                rootThreadId,
                providerInstanceId: invocation.providerInstanceId,
                providerSessionId: invocation.providerSessionId,
                children: children.map((child) => ({
                  threadId: child.childThreadId,
                  title: child.title,
                  type: child.subagentType,
                  agentKind: child.agentKind,
                  status: "started",
                  queueKey: child.queueKey,
                })),
              },
              turnId: parentTurnId,
              createdAt,
            },
            createdAt,
          });
        }),
      { concurrency: 1 },
    ).pipe(Effect.asVoid);

    const firstChild = children[0];
    return {
      status: "started",
      parentThreadId: parentThread.id,
      rootThreadId,
      spawnGroupId,
      children,
      title:
        children.length === 1 ? (firstChild?.title ?? "Subagent") : `${children.length} subagents`,
      ...(firstChild !== undefined && children.length === 1
        ? {
            childThreadId: firstChild.childThreadId,
            childMessageId: firstChild.childMessageId,
            subagentType: firstChild.subagentType,
          }
        : {}),
    };
  });

  return T3SubagentRuntime.of({ run });
});

export const layer = Layer.effect(T3SubagentRuntime, make);
