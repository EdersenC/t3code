import type {
  AgentThreadMetadata,
  OrchestrationCommand,
  OrchestrationProject,
  OrchestrationReadModel,
  OrchestrationThread,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { OrchestrationCommandInvariantError } from "./Errors.ts";
import { AGENT_GRAPH_LIMITS, agentMetadataForThread, isActiveAgentSession } from "./agentGraph.ts";

function invariantError(commandType: string, detail: string): OrchestrationCommandInvariantError {
  return new OrchestrationCommandInvariantError({
    commandType,
    detail,
  });
}

export function findThreadById(
  readModel: OrchestrationReadModel,
  threadId: ThreadId,
): OrchestrationThread | undefined {
  return readModel.threads.find((thread) => thread.id === threadId);
}

export function findProjectById(
  readModel: OrchestrationReadModel,
  projectId: ProjectId,
): OrchestrationProject | undefined {
  return readModel.projects.find((project) => project.id === projectId);
}

export function listThreadsByProjectId(
  readModel: OrchestrationReadModel,
  projectId: ProjectId,
): ReadonlyArray<OrchestrationThread> {
  return readModel.threads.filter((thread) => thread.projectId === projectId);
}

export function validateThreadCreateAgentMetadata(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: Extract<OrchestrationCommand, { type: "thread.create" }>;
}): Effect.Effect<AgentThreadMetadata, OrchestrationCommandInvariantError> {
  const { command, readModel } = input;
  const requested = command.agentMetadata;

  if (requested?.parentThreadId === undefined) {
    return Effect.succeed({
      threadId: command.threadId,
      projectId: command.projectId,
      rootThreadId: command.threadId,
      agentRole: "root",
      agentKind: "root",
      ...(requested?.displayName !== undefined ? { displayName: requested.displayName } : {}),
      depth: 0,
      ...(requested?.spawnedByTurnId !== undefined
        ? { spawnedByTurnId: requested.spawnedByTurnId }
        : {}),
      ...(requested?.spawnedByToolCallId !== undefined
        ? { spawnedByToolCallId: requested.spawnedByToolCallId }
        : {}),
      ...(requested?.spawnGroupId !== undefined ? { spawnGroupId: requested.spawnGroupId } : {}),
      createdAt: command.createdAt,
    });
  }

  if (requested.rootThreadId === undefined) {
    return Effect.fail(
      invariantError(command.type, "Child agent threads must include rootThreadId."),
    );
  }
  if (requested.agentKind === undefined || requested.agentKind === "root") {
    return Effect.fail(
      invariantError(command.type, "Child agent threads must include a non-root agentKind."),
    );
  }
  if (requested.agentRole !== undefined && requested.agentRole !== "subagent") {
    return Effect.fail(
      invariantError(command.type, "Child agent threads must use agentRole=subagent."),
    );
  }
  if (requested.parentThreadId === command.threadId) {
    return Effect.fail(invariantError(command.type, "Child agent thread cannot parent itself."));
  }

  const parentThread = findThreadById(readModel, requested.parentThreadId);
  if (!parentThread || parentThread.deletedAt !== null) {
    return Effect.fail(
      invariantError(
        command.type,
        `Parent thread '${requested.parentThreadId}' does not exist for child agent '${command.threadId}'.`,
      ),
    );
  }
  if (parentThread.projectId !== command.projectId) {
    return Effect.fail(
      invariantError(command.type, "Child agent thread must belong to the same project as parent."),
    );
  }

  const rootThread = findThreadById(readModel, requested.rootThreadId);
  if (!rootThread || rootThread.deletedAt !== null) {
    return Effect.fail(
      invariantError(
        command.type,
        `Root thread '${requested.rootThreadId}' does not exist for child agent '${command.threadId}'.`,
      ),
    );
  }
  if (rootThread.projectId !== command.projectId) {
    return Effect.fail(
      invariantError(command.type, "Child agent thread must belong to the same project as root."),
    );
  }

  const rootMetadata = agentMetadataForThread(rootThread);
  if (
    rootMetadata.rootThreadId !== requested.rootThreadId ||
    rootMetadata.parentThreadId !== undefined
  ) {
    return Effect.fail(
      invariantError(command.type, "rootThreadId must point to the root session thread."),
    );
  }

  const parentMetadata = agentMetadataForThread(parentThread);
  if (parentMetadata.rootThreadId !== requested.rootThreadId) {
    return Effect.fail(
      invariantError(command.type, "Parent agent must belong to the requested root session."),
    );
  }

  const depth = parentMetadata.depth + 1;
  if (depth > AGENT_GRAPH_LIMITS.maxDepth) {
    return Effect.fail(
      invariantError(
        command.type,
        `Agent graph depth ${depth} exceeds max depth ${AGENT_GRAPH_LIMITS.maxDepth}.`,
      ),
    );
  }

  const directChildCount = readModel.threads.filter((thread) => {
    const metadata = agentMetadataForThread(thread);
    return metadata.parentThreadId === requested.parentThreadId && thread.deletedAt === null;
  }).length;
  if (directChildCount >= AGENT_GRAPH_LIMITS.maxChildrenPerParent) {
    return Effect.fail(
      invariantError(
        command.type,
        `Parent thread '${requested.parentThreadId}' already has ${directChildCount} child agents.`,
      ),
    );
  }

  const activeAgentCount = readModel.threads.filter((thread) => {
    const metadata = agentMetadataForThread(thread);
    return (
      metadata.rootThreadId === requested.rootThreadId &&
      thread.deletedAt === null &&
      isActiveAgentSession(thread.session)
    );
  }).length;
  if (activeAgentCount >= AGENT_GRAPH_LIMITS.maxActiveAgentsPerRoot) {
    return Effect.fail(
      invariantError(
        command.type,
        `Root thread '${requested.rootThreadId}' already has ${activeAgentCount} active agents.`,
      ),
    );
  }

  return Effect.succeed({
    threadId: command.threadId,
    projectId: command.projectId,
    rootThreadId: requested.rootThreadId,
    parentThreadId: requested.parentThreadId,
    agentRole: "subagent",
    agentKind: requested.agentKind,
    ...(requested.displayName !== undefined ? { displayName: requested.displayName } : {}),
    depth,
    ...(requested.spawnedByTurnId !== undefined
      ? { spawnedByTurnId: requested.spawnedByTurnId }
      : {}),
    ...(requested.spawnedByToolCallId !== undefined
      ? { spawnedByToolCallId: requested.spawnedByToolCallId }
      : {}),
    ...(requested.spawnGroupId !== undefined ? { spawnGroupId: requested.spawnGroupId } : {}),
    createdAt: command.createdAt,
  });
}

export function requireProject(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly projectId: ProjectId;
}): Effect.Effect<OrchestrationProject, OrchestrationCommandInvariantError> {
  const project = findProjectById(input.readModel, input.projectId);
  if (project) {
    return Effect.succeed(project);
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Project '${input.projectId}' does not exist for command '${input.command.type}'.`,
    ),
  );
}

export function requireProjectAbsent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly projectId: ProjectId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (!findProjectById(input.readModel, input.projectId)) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Project '${input.projectId}' already exists and cannot be created twice.`,
    ),
  );
}

export function requireThread(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<OrchestrationThread, OrchestrationCommandInvariantError> {
  const thread = findThreadById(input.readModel, input.threadId);
  if (thread) {
    return Effect.succeed(thread);
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Thread '${input.threadId}' does not exist for command '${input.command.type}'.`,
    ),
  );
}

export function requireThreadArchived(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<OrchestrationThread, OrchestrationCommandInvariantError> {
  return requireThread(input).pipe(
    Effect.flatMap((thread) =>
      thread.archivedAt !== null
        ? Effect.succeed(thread)
        : Effect.fail(
            invariantError(
              input.command.type,
              `Thread '${input.threadId}' is not archived for command '${input.command.type}'.`,
            ),
          ),
    ),
  );
}

export function requireThreadNotArchived(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<OrchestrationThread, OrchestrationCommandInvariantError> {
  return requireThread(input).pipe(
    Effect.flatMap((thread) =>
      thread.archivedAt === null
        ? Effect.succeed(thread)
        : Effect.fail(
            invariantError(
              input.command.type,
              `Thread '${input.threadId}' is already archived and cannot handle command '${input.command.type}'.`,
            ),
          ),
    ),
  );
}

export function requireThreadAbsent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (!findThreadById(input.readModel, input.threadId)) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Thread '${input.threadId}' already exists and cannot be created twice.`,
    ),
  );
}

export function requireNonNegativeInteger(input: {
  readonly commandType: OrchestrationCommand["type"];
  readonly field: string;
  readonly value: number;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (Number.isInteger(input.value) && input.value >= 0) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.commandType,
      `${input.field} must be an integer greater than or equal to 0.`,
    ),
  );
}
