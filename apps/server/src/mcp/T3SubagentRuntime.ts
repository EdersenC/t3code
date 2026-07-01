import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  MessageId,
  type ModelSelection,
  ProviderInstanceId,
  type T3SubagentAgent,
  type T3SubagentRunError,
  type T3SubagentRunInput,
  type T3SubagentRunResult,
  ThreadId,
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
import * as McpInvocationContext from "./McpInvocationContext.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerSettingsService } from "../serverSettings.ts";

const TOOL_CAPABILITY_ID = "t3:tool:subagent";

const AGENT_MODEL_SELECTIONS: Readonly<Record<T3SubagentAgent, ModelSelection>> = {
  "ollama-gpt-oss-120b-cloud": {
    instanceId: ProviderInstanceId.make("ollama"),
    model: "ollama/gpt-oss:120b-cloud",
  },
  "ollama-gpt-oss-20b-cloud": {
    instanceId: ProviderInstanceId.make("ollama"),
    model: "ollama/gpt-oss:20b-cloud",
  },
};

const makeError = (code: T3SubagentRunError["code"], message: string): T3SubagentRunError => ({
  code,
  message,
});

const titleFor = (input: T3SubagentRunInput): string => input.title ?? "Subagent";

function buildPrompt(input: T3SubagentRunInput): string {
  return input.prompt;
}

function previewText(text: string, limit = 180): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, limit - 3)}...`;
}

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

  const run: T3SubagentRuntimeShape["run"] = Effect.fn("T3SubagentRuntime.run")(function* (input) {
    const invocation = yield* McpInvocationContext.requireMcpCapability(
      McpInvocationContext.T3_SUBAGENT_MCP_CAPABILITY,
    ).pipe(
      Effect.mapError(() =>
        makeError("capability_unavailable", "MCP credential does not grant t3_subagent access."),
      ),
    );
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
    const childThreadId = ThreadId.make(`subagent:${yield* randomUuid}`);
    const childMessageId = MessageId.make(`subagent-message:${yield* randomUuid}`);
    const queueItemId = EventId.make(`t3:subagent:queue:${yield* randomUuid}`);
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    const title = titleFor(input);
    const childModelSelection = input.agent
      ? AGENT_MODEL_SELECTIONS[input.agent]
      : parentThread.modelSelection;

    yield* dispatch({
      type: "thread.create",
      commandId: yield* nextCommandId("create"),
      threadId: childThreadId,
      projectId: parentThread.projectId,
      title,
      modelSelection: childModelSelection,
      runtimeMode: parentThread.runtimeMode,
      interactionMode: parentThread.interactionMode,
      branch: parentThread.branch,
      worktreePath: parentThread.worktreePath,
      createdAt,
    });
    yield* dispatch({
      type: "thread.activity.append",
      commandId: yield* nextCommandId("activity"),
      threadId: parentThread.id,
      activity: {
        id: queueItemId,
        tone: "tool",
        kind: "t3.subagent.started",
        summary: `${title} subagent started`,
        payload: {
          queueItemId,
          status: "started",
          capabilityId: TOOL_CAPABILITY_ID,
          capabilityKind: "tool",
          capabilitySource: "t3",
          harnessName: "T3 MCP",
          toolName: "t3_subagent",
          parentThreadId: parentThread.id,
          parentTurnId: parentThread.latestTurn?.turnId ?? null,
          childThreadId,
          childMessageId,
          title,
          prompt: input.prompt,
          promptPreview: previewText(input.prompt),
          ...(input.agent ? { agent: input.agent } : {}),
        },
        turnId: parentThread.latestTurn?.turnId ?? null,
        createdAt,
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
        text: buildPrompt(input),
        attachments: [],
      },
      modelSelection: childModelSelection,
      titleSeed: title,
      runtimeMode: parentThread.runtimeMode,
      interactionMode: parentThread.interactionMode,
      createdAt,
    });

    return {
      status: "started",
      queueItemId,
      parentThreadId: parentThread.id,
      childThreadId,
      childMessageId,
      title,
      ...(input.agent ? { agent: input.agent } : {}),
    };
  });

  return T3SubagentRuntime.of({ run });
});

export const layer = Layer.effect(T3SubagentRuntime, make);
