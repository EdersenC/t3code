import type {
  AgentKind,
  AgentTraceContext,
  AgenticResourceLimitsSettings,
  AgentThreadMetadata,
  OrchestrationAgentTree,
  OrchestrationAgentTreeNode,
  OrchestrationAgentTreeStatus,
  OrchestrationProjectRootSessionAgentSummary,
  OrchestrationReadModel,
  OrchestrationSession,
  OrchestrationThread,
  ProviderInstanceId,
  ProjectId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { DEFAULT_AGENTIC_RESOURCE_LIMITS } from "@t3tools/contracts";

export const DEFAULT_AGENT_GRAPH_LIMITS = {
  maxDepth: DEFAULT_AGENTIC_RESOURCE_LIMITS.maxAgentDepth,
  maxChildrenPerParent: DEFAULT_AGENTIC_RESOURCE_LIMITS.maxChildrenPerAgent,
  maxActiveAgentsPerRoot: DEFAULT_AGENTIC_RESOURCE_LIMITS.maxActiveAgentsPerSession,
} as const;

export interface AgentGraphLimits {
  readonly maxDepth: number;
  readonly maxChildrenPerParent: number;
  readonly maxActiveAgentsPerRoot: number;
}

export function agentGraphLimitsFromSettings(
  limits: AgenticResourceLimitsSettings,
): AgentGraphLimits {
  return {
    maxDepth: limits.maxAgentDepth,
    maxChildrenPerParent: limits.maxChildrenPerAgent,
    maxActiveAgentsPerRoot: limits.maxActiveAgentsPerSession,
  };
}

export function agentMetadataForThread(thread: OrchestrationThread): AgentThreadMetadata {
  return (
    thread.agentMetadata ?? {
      threadId: thread.id,
      projectId: thread.projectId,
      rootThreadId: thread.id,
      agentRole: "root",
      agentKind: "root",
      depth: 0,
      createdAt: thread.createdAt,
    }
  );
}

export function isActiveAgentSession(session: OrchestrationSession | null): boolean {
  return session?.status === "starting" || session?.status === "running";
}

export function isWaitingAgentThread(thread: OrchestrationThread): boolean {
  return thread.session?.status === "running" && thread.latestTurn?.state === "running";
}

export function listDirectChildAgentThreads(
  readModel: OrchestrationReadModel,
  parentThreadId: ThreadId,
): ReadonlyArray<OrchestrationThread> {
  return readModel.threads
    .filter((thread) => {
      const metadata = agentMetadataForThread(thread);
      return metadata.parentThreadId === parentThreadId && thread.deletedAt === null;
    })
    .toSorted(
      (left, right) =>
        agentMetadataForThread(left).createdAt.localeCompare(
          agentMetadataForThread(right).createdAt,
        ) || left.id.localeCompare(right.id),
    );
}

export function findRootThreadForAgentThread(
  readModel: OrchestrationReadModel,
  threadId: ThreadId,
): OrchestrationThread | null {
  const thread = readModel.threads.find((candidate) => candidate.id === threadId);
  if (!thread) {
    return null;
  }
  const metadata = agentMetadataForThread(thread);
  return readModel.threads.find((candidate) => candidate.id === metadata.rootThreadId) ?? null;
}

function buildAgentTreeNode(
  readModel: OrchestrationReadModel,
  thread: OrchestrationThread,
): OrchestrationAgentTreeNode {
  return {
    threadId: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    agentMetadata: agentMetadataForThread(thread),
    session: thread.session,
    latestTurn: thread.latestTurn,
    updatedAt: thread.updatedAt,
    archivedAt: thread.archivedAt,
    deletedAt: thread.deletedAt,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    children: listDirectChildAgentThreads(readModel, thread.id).map((child) =>
      buildAgentTreeNode(readModel, child),
    ),
  };
}

function flattenAgentTree(
  root: OrchestrationAgentTreeNode,
): ReadonlyArray<OrchestrationAgentTreeNode> {
  return [root, ...root.children.flatMap(flattenAgentTree)];
}

export function getAgentTreeForRootThread(
  readModel: OrchestrationReadModel,
  rootThreadId: ThreadId,
): OrchestrationAgentTree | null {
  const rootThread = readModel.threads.find((thread) => thread.id === rootThreadId);
  if (!rootThread) {
    return null;
  }
  const rootMetadata = agentMetadataForThread(rootThread);
  if (rootMetadata.rootThreadId !== rootThread.id || rootMetadata.parentThreadId !== undefined) {
    return null;
  }

  const root = buildAgentTreeNode(readModel, rootThread);
  const nodes = flattenAgentTree(root);
  return {
    rootThreadId: rootThread.id,
    projectId: rootThread.projectId,
    root,
    activeAgentCount: nodes.filter((node) => isActiveAgentSession(node.session)).length,
    totalAgentCount: nodes.length,
  };
}

export function agentStatusForThread(thread: OrchestrationThread): OrchestrationAgentTreeStatus {
  if (thread.activities.some((activity) => activity.kind === "approval.requested")) {
    return "waiting-on-user";
  }
  if (thread.latestTurn?.state === "error" || thread.session?.status === "error") {
    return "failed";
  }
  if (thread.latestTurn?.state === "interrupted" || thread.session?.status === "interrupted") {
    return "interrupted";
  }
  if (thread.session?.status === "running" || thread.session?.status === "starting") {
    return "running";
  }
  if (thread.latestTurn?.state === "running") {
    return "running";
  }
  if (thread.session?.status === "stopped") {
    return "stopped";
  }
  if (thread.latestTurn?.state === "completed" || thread.session?.status === "ready") {
    return "complete";
  }
  return "idle";
}

export function listActiveAgentThreads(
  readModel: OrchestrationReadModel,
  rootThreadId: ThreadId,
): ReadonlyArray<OrchestrationThread> {
  return readModel.threads.filter((thread) => {
    const metadata = agentMetadataForThread(thread);
    return (
      metadata.rootThreadId === rootThreadId &&
      thread.deletedAt === null &&
      isActiveAgentSession(thread.session)
    );
  });
}

export function listBlockedOrWaitingAgentThreads(
  readModel: OrchestrationReadModel,
  rootThreadId: ThreadId,
): ReadonlyArray<OrchestrationThread> {
  return readModel.threads.filter((thread) => {
    const metadata = agentMetadataForThread(thread);
    const status = agentStatusForThread(thread);
    return (
      metadata.rootThreadId === rootThreadId &&
      thread.deletedAt === null &&
      (status === "waiting-on-tools" ||
        status === "waiting-on-user" ||
        isWaitingAgentThread(thread))
    );
  });
}

export function flattenAgentTreeNodes(
  node: OrchestrationAgentTreeNode,
): ReadonlyArray<OrchestrationAgentTreeNode> {
  return [node, ...node.children.flatMap(flattenAgentTreeNodes)];
}

export function makeAgentTraceContext(input: {
  readonly thread: OrchestrationThread;
  readonly timestamp: string;
  readonly correlationId: string;
  readonly turnId?: TurnId | null;
  readonly toolCallId?: string | undefined;
  readonly toolCallGroupId?: string | undefined;
  readonly providerInstanceId?: ProviderInstanceId | undefined;
}): AgentTraceContext {
  const metadata = agentMetadataForThread(input.thread);
  return {
    projectId: input.thread.projectId,
    rootThreadId: metadata.rootThreadId,
    threadId: input.thread.id,
    ...(metadata.parentThreadId !== undefined ? { parentThreadId: metadata.parentThreadId } : {}),
    agentKind: metadata.agentKind,
    depth: metadata.depth,
    ...(input.turnId !== undefined && input.turnId !== null ? { turnId: input.turnId } : {}),
    ...(metadata.spawnGroupId !== undefined ? { spawnGroupId: metadata.spawnGroupId } : {}),
    ...(input.toolCallId !== undefined ? { toolCallId: input.toolCallId } : {}),
    ...(input.toolCallGroupId !== undefined
      ? { toolCallGroupId: input.toolCallGroupId as AgentTraceContext["toolCallGroupId"] }
      : {}),
    ...(input.providerInstanceId !== undefined
      ? { providerInstanceId: input.providerInstanceId }
      : {}),
    correlationId: input.correlationId,
    timestamp: input.timestamp,
  };
}

export function listProjectRootSessionAgentSummaries(
  readModel: OrchestrationReadModel,
  projectId: ProjectId,
): ReadonlyArray<OrchestrationProjectRootSessionAgentSummary> {
  return readModel.threads
    .filter((thread) => {
      const metadata = agentMetadataForThread(thread);
      return (
        thread.projectId === projectId &&
        thread.deletedAt === null &&
        metadata.agentRole === "root" &&
        metadata.rootThreadId === thread.id &&
        metadata.parentThreadId === undefined
      );
    })
    .map((thread) => {
      const tree = getAgentTreeForRootThread(readModel, thread.id);
      return {
        projectId: thread.projectId,
        rootThreadId: thread.id,
        title: thread.title,
        activeAgentCount: tree?.activeAgentCount ?? (isActiveAgentSession(thread.session) ? 1 : 0),
        totalAgentCount: tree?.totalAgentCount ?? 1,
        updatedAt: thread.updatedAt,
      };
    })
    .toSorted(
      (left, right) =>
        left.updatedAt.localeCompare(right.updatedAt) ||
        left.rootThreadId.localeCompare(right.rootThreadId),
    );
}

export function agentKindForSubagentType(type: string): AgentKind {
  return type === "explore" || type === "implement" || type === "review" ? type : "custom";
}
