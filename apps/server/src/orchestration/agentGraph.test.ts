import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  AGENT_GRAPH_LIMITS,
  findRootThreadForAgentThread,
  getAgentTreeForRootThread,
  listProjectRootSessionAgentSummaries,
} from "./agentGraph.ts";
import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = "2026-01-01T00:00:00.000Z";
const asCommandId = (value: string): CommandId => CommandId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asThreadId = (value: string): ThreadId => ThreadId.make(value);

type PlannedEvent = Omit<OrchestrationEvent, "sequence">;

function projectCreated(projectId: ProjectId): OrchestrationEvent {
  return {
    sequence: 1,
    eventId: asEventId(`evt-${projectId}`),
    aggregateKind: "project",
    aggregateId: projectId,
    type: "project.created",
    occurredAt: now,
    commandId: asCommandId(`cmd-${projectId}`),
    causationEventId: null,
    correlationId: asCommandId(`cmd-${projectId}`),
    metadata: {},
    payload: {
      projectId,
      title: `Project ${projectId}`,
      workspaceRoot: `/tmp/${projectId}`,
      defaultModelSelection: null,
      scripts: [],
      createdAt: now,
      updatedAt: now,
    },
  };
}

function createThreadCommand(input: {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly title?: string;
  readonly parentThreadId?: ThreadId;
  readonly rootThreadId?: ThreadId;
  readonly agentKind?: "explore" | "implement" | "review" | "custom";
}): Extract<OrchestrationCommand, { type: "thread.create" }> {
  return {
    type: "thread.create",
    commandId: asCommandId(`cmd-create-${input.threadId}`),
    threadId: input.threadId,
    projectId: input.projectId,
    title: input.title ?? `Thread ${input.threadId}`,
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    ...(input.parentThreadId !== undefined
      ? {
          agentMetadata: {
            rootThreadId: input.rootThreadId,
            parentThreadId: input.parentThreadId,
            agentRole: "subagent" as const,
            agentKind: input.agentKind ?? "custom",
          },
        }
      : {}),
    createdAt: now,
  };
}

function seedProject(projectId = asProjectId("project-agent-graph")) {
  return projectEvent(createEmptyReadModel(now), projectCreated(projectId));
}

function decideAndProject(readModel: OrchestrationReadModel, command: OrchestrationCommand) {
  return Effect.gen(function* () {
    const decided = yield* decideOrchestrationCommand({ command, readModel });
    const events = Array.isArray(decided) ? decided : [decided];
    let next = readModel;
    let sequence = readModel.snapshotSequence;
    for (const event of events) {
      sequence += 1;
      next = yield* projectEvent(next, { ...event, sequence } as OrchestrationEvent);
    }
    return { readModel: next, events };
  });
}

it.layer(NodeServices.layer)("agent graph", (it) => {
  it.effect("defaults legacy thread.created payloads to root session metadata", () =>
    Effect.gen(function* () {
      const projectId = asProjectId("project-legacy-root");
      const threadId = asThreadId("thread-legacy-root");
      const withProject = yield* seedProject(projectId);

      const readModel = yield* projectEvent(withProject, {
        sequence: withProject.snapshotSequence + 1,
        eventId: asEventId("evt-legacy-thread-created"),
        aggregateKind: "thread",
        aggregateId: threadId,
        type: "thread.created",
        occurredAt: now,
        commandId: asCommandId("cmd-legacy-thread-created"),
        causationEventId: null,
        correlationId: asCommandId("cmd-legacy-thread-created"),
        metadata: {},
        payload: {
          threadId,
          projectId,
          title: "Legacy Root",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      expect(readModel.threads[0]?.agentMetadata).toMatchObject({
        threadId,
        projectId,
        rootThreadId: threadId,
        agentRole: "root",
        agentKind: "root",
        depth: 0,
      });
    }),
  );

  it.effect("creates one child agent and projects it under the root session", () =>
    Effect.gen(function* () {
      const projectId = asProjectId("project-child-agent");
      const rootThreadId = asThreadId("thread-root");
      const childThreadId = asThreadId("thread-child");
      const withProject = yield* seedProject(projectId);
      const root = yield* decideAndProject(
        withProject,
        createThreadCommand({ threadId: rootThreadId, projectId, title: "Root" }),
      );
      const child = yield* decideAndProject(
        root.readModel,
        createThreadCommand({
          threadId: childThreadId,
          projectId,
          title: "Explore child",
          rootThreadId,
          parentThreadId: rootThreadId,
          agentKind: "explore",
        }),
      );

      expect(child.events.map((event) => event.type)).toEqual([
        "agent.spawn.requested",
        "thread.created",
        "agent.spawned",
      ]);
      expect(
        child.readModel.threads.find((thread) => thread.id === childThreadId)?.agentMetadata,
      ).toMatchObject({
        rootThreadId,
        parentThreadId: rootThreadId,
        agentRole: "subagent",
        agentKind: "explore",
        depth: 1,
      });

      const tree = getAgentTreeForRootThread(child.readModel, rootThreadId);
      expect(tree?.root.children.map((node) => node.threadId)).toEqual([childThreadId]);
      expect(tree?.totalAgentCount).toBe(2);
    }),
  );

  it.effect("supports recursive child agents and can resolve root/project summaries", () =>
    Effect.gen(function* () {
      const projectId = asProjectId("project-recursive-agent");
      const rootThreadId = asThreadId("thread-root-recursive");
      const childThreadId = asThreadId("thread-child-recursive");
      const grandchildThreadId = asThreadId("thread-grandchild-recursive");
      const withProject = yield* seedProject(projectId);
      const root = yield* decideAndProject(
        withProject,
        createThreadCommand({ threadId: rootThreadId, projectId }),
      );
      const child = yield* decideAndProject(
        root.readModel,
        createThreadCommand({
          threadId: childThreadId,
          projectId,
          rootThreadId,
          parentThreadId: rootThreadId,
          agentKind: "review",
        }),
      );
      const grandchild = yield* decideAndProject(
        child.readModel,
        createThreadCommand({
          threadId: grandchildThreadId,
          projectId,
          rootThreadId,
          parentThreadId: childThreadId,
          agentKind: "implement",
        }),
      );

      const tree = getAgentTreeForRootThread(grandchild.readModel, rootThreadId);
      expect(tree?.root.children[0]?.children[0]?.threadId).toBe(grandchildThreadId);
      expect(tree?.root.children[0]?.children[0]?.agentMetadata.depth).toBe(2);
      expect(findRootThreadForAgentThread(grandchild.readModel, grandchildThreadId)?.id).toBe(
        rootThreadId,
      );
      expect(listProjectRootSessionAgentSummaries(grandchild.readModel, projectId)).toEqual([
        expect.objectContaining({
          projectId,
          rootThreadId,
          totalAgentCount: 3,
        }),
      ]);
    }),
  );

  it.effect("rejects self-parent and cross-project child links", () =>
    Effect.gen(function* () {
      const projectA = asProjectId("project-agent-a");
      const projectB = asProjectId("project-agent-b");
      const rootThreadId = asThreadId("thread-root-cross-project");
      const withProjectA = yield* seedProject(projectA);
      const withProjects = yield* projectEvent(withProjectA, {
        ...projectCreated(projectB),
        sequence: withProjectA.snapshotSequence + 1,
      });
      const root = yield* decideAndProject(
        withProjects,
        createThreadCommand({ threadId: rootThreadId, projectId: projectA }),
      );

      const selfParentError = yield* decideOrchestrationCommand({
        readModel: root.readModel,
        command: createThreadCommand({
          threadId: asThreadId("thread-self-parent"),
          projectId: projectA,
          rootThreadId,
          parentThreadId: asThreadId("thread-self-parent"),
          agentKind: "custom",
        }),
      }).pipe(Effect.flip);
      expect(selfParentError.message).toContain("cannot parent itself");

      const crossProjectError = yield* decideOrchestrationCommand({
        readModel: root.readModel,
        command: createThreadCommand({
          threadId: asThreadId("thread-cross-project-child"),
          projectId: projectB,
          rootThreadId,
          parentThreadId: rootThreadId,
          agentKind: "custom",
        }),
      }).pipe(Effect.flip);
      expect(crossProjectError.message).toContain("same project as parent");
    }),
  );

  it.effect("enforces max recursive depth", () =>
    Effect.gen(function* () {
      const projectId = asProjectId("project-max-depth");
      const rootThreadId = asThreadId("thread-depth-root");
      let state = yield* seedProject(projectId);
      state = (yield* decideAndProject(
        state,
        createThreadCommand({ threadId: rootThreadId, projectId }),
      )).readModel;

      let parentThreadId = rootThreadId;
      for (let depth = 1; depth <= AGENT_GRAPH_LIMITS.maxDepth; depth += 1) {
        const threadId = asThreadId(`thread-depth-${depth}`);
        state = (yield* decideAndProject(
          state,
          createThreadCommand({
            threadId,
            projectId,
            rootThreadId,
            parentThreadId,
            agentKind: "custom",
          }),
        )).readModel;
        parentThreadId = threadId;
      }

      const error = yield* decideOrchestrationCommand({
        readModel: state,
        command: createThreadCommand({
          threadId: asThreadId("thread-depth-too-far"),
          projectId,
          rootThreadId,
          parentThreadId,
          agentKind: "custom",
        }),
      }).pipe(Effect.flip);
      expect(error.message).toContain(`exceeds max depth ${AGENT_GRAPH_LIMITS.maxDepth}`);
    }),
  );

  it.effect("replaying events reconstructs the same tree", () =>
    Effect.gen(function* () {
      const projectId = asProjectId("project-replay");
      const rootThreadId = asThreadId("thread-replay-root");
      const childThreadId = asThreadId("thread-replay-child");
      let state = yield* seedProject(projectId);
      const plannedEvents: PlannedEvent[] = [];

      const root = yield* decideAndProject(
        state,
        createThreadCommand({ threadId: rootThreadId, projectId }),
      );
      plannedEvents.push(...root.events);
      state = root.readModel;
      const child = yield* decideAndProject(
        state,
        createThreadCommand({
          threadId: childThreadId,
          projectId,
          rootThreadId,
          parentThreadId: rootThreadId,
          agentKind: "custom",
        }),
      );
      plannedEvents.push(...child.events);

      let replayed = yield* seedProject(projectId);
      let sequence = replayed.snapshotSequence;
      for (const event of plannedEvents) {
        sequence += 1;
        replayed = yield* projectEvent(replayed, { ...event, sequence } as OrchestrationEvent);
      }

      expect(getAgentTreeForRootThread(replayed, rootThreadId)).toEqual(
        getAgentTreeForRootThread(child.readModel, rootThreadId),
      );
    }),
  );
});
