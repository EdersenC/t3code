import type {
  AgentKind,
  AgentThreadMetadata,
  OrchestrationAgentTree,
  OrchestrationAgentTreeNode,
  OrchestrationProjectRootSessionAgentSummary,
  OrchestrationReadModel,
  OrchestrationSession,
  OrchestrationThread,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";

export const AGENT_GRAPH_LIMITS = {
  maxDepth: 8,
  maxChildrenPerParent: 64,
  maxActiveAgentsPerRoot: 64,
} as const;

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
