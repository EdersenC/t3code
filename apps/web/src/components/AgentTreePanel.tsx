import type {
  EnvironmentId,
  OrchestrationAgentTreeSnapshot,
  OrchestrationAgentTreeSnapshotAgent,
  OrchestrationAgentTreeStatus,
  ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { BotIcon, CircleIcon, CornerDownRightIcon, GitBranchIcon } from "lucide-react";
import { useMemo } from "react";

import { useEnvironmentQuery } from "../state/query";
import { orchestrationEnvironment } from "../state/orchestration";
import { cn } from "../lib/utils";
import { Badge } from "./ui/badge";

interface AgentTreePanelProps {
  readonly environmentId: EnvironmentId;
  readonly rootThreadId: ThreadId;
  readonly activeThreadId: ThreadId;
}

const statusLabel: Record<OrchestrationAgentTreeStatus, string> = {
  idle: "Idle",
  running: "Running",
  "waiting-on-tools": "Waiting on tools",
  "waiting-on-user": "Waiting on user",
  complete: "Complete",
  failed: "Failed",
  interrupted: "Interrupted",
  stopped: "Stopped",
};

function statusVariant(
  status: OrchestrationAgentTreeStatus,
): "outline" | "warning" | "success" | "error" | "info" {
  switch (status) {
    case "running":
    case "waiting-on-tools":
    case "waiting-on-user":
      return "warning";
    case "complete":
      return "success";
    case "failed":
      return "error";
    case "interrupted":
      return "info";
    case "idle":
    case "stopped":
      return "outline";
  }
}

function displayName(agent: OrchestrationAgentTreeSnapshotAgent): string {
  if (agent.agentKind === "root") {
    return agent.displayName || "Root Agent";
  }
  return agent.displayName || `${agent.agentKind[0]?.toUpperCase()}${agent.agentKind.slice(1)}`;
}

function formatTraceId(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  return value.length > 22 ? `${value.slice(0, 10)}...${value.slice(-8)}` : value;
}

function AgentTrace({
  snapshot,
  selected,
  onOpenAgent,
}: {
  readonly snapshot: OrchestrationAgentTreeSnapshot;
  readonly selected: OrchestrationAgentTreeSnapshotAgent;
  readonly onOpenAgent: (threadId: ThreadId) => void;
}) {
  const byThreadId = useMemo(
    () => new Map(snapshot.agents.map((agent) => [agent.threadId, agent])),
    [snapshot.agents],
  );
  const parent = selected.parentThreadId ? byThreadId.get(selected.parentThreadId) : null;
  const root = byThreadId.get(snapshot.rootThreadId) ?? null;
  const spawnedByTurn = formatTraceId(selected.spawnedByTurnId);
  const spawnedByTool = formatTraceId(selected.spawnedByToolCallId);
  const spawnGroup = formatTraceId(selected.spawnGroupId);

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 border-border/60 border-t px-3 py-2 text-muted-foreground text-xs">
      {parent ? (
        <button
          type="button"
          className="min-w-0 truncate hover:text-foreground"
          onClick={() => onOpenAgent(parent.threadId)}
        >
          Parent: {displayName(parent)}
        </button>
      ) : (
        <span>Parent: none</span>
      )}
      {root ? (
        <button
          type="button"
          className="min-w-0 truncate hover:text-foreground"
          onClick={() => onOpenAgent(root.threadId)}
        >
          Root: {displayName(root)}
        </button>
      ) : null}
      <span>Spawned: {new Date(selected.createdAt).toLocaleString()}</span>
      {spawnedByTurn ? <span>Turn: {spawnedByTurn}</span> : null}
      {spawnedByTool ? <span>Tool: {spawnedByTool}</span> : null}
      {spawnGroup ? <span>Group: {spawnGroup}</span> : null}
      {selected.providerInstanceId ? <span>Provider: {selected.providerInstanceId}</span> : null}
    </div>
  );
}

export function AgentTreePanel({
  environmentId,
  rootThreadId,
  activeThreadId,
}: AgentTreePanelProps) {
  const navigate = useNavigate();
  const treeState = useEnvironmentQuery(
    orchestrationEnvironment.agentTreeSubscription({
      environmentId,
      input: { rootThreadId },
    }),
  );
  const snapshot = treeState.data;
  const selected = snapshot?.agents.find((agent) => agent.threadId === activeThreadId) ?? null;

  const openAgent = (threadId: ThreadId) => {
    void navigate({
      to: "/$environmentId/$threadId",
      params: {
        environmentId,
        threadId,
      },
    });
  };

  if (treeState.isPending && snapshot === null) {
    return (
      <section className="border-border/70 border-b bg-background/95 px-3 py-2 text-muted-foreground text-xs">
        Loading agent tree...
      </section>
    );
  }

  if (treeState.error && snapshot === null) {
    return (
      <section className="border-border/70 border-b bg-background/95 px-3 py-2 text-destructive text-xs">
        {treeState.error}
      </section>
    );
  }

  if (!snapshot || snapshot.agents.length <= 1) {
    return null;
  }

  return (
    <section className="border-border/70 border-b bg-background/95">
      <div className="flex min-w-0 items-center gap-2 px-3 pt-2 pb-1.5">
        <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <h2 className="font-medium text-foreground text-xs">Session agents</h2>
        <Badge variant="outline" size="sm">
          {snapshot.agents.length}
        </Badge>
      </div>
      <div className="flex gap-1 overflow-x-auto px-3 pb-2">
        {snapshot.agents.map((agent) => {
          const active = agent.threadId === activeThreadId;
          return (
            <button
              key={agent.threadId}
              type="button"
              onClick={() => openAgent(agent.threadId)}
              className={cn(
                "flex min-w-44 max-w-72 shrink-0 items-center gap-2 rounded-md border px-2 py-1.5 text-left transition-colors",
                active
                  ? "border-primary/40 bg-primary/8 text-foreground"
                  : "border-border/70 bg-card/60 text-muted-foreground hover:border-border hover:text-foreground",
              )}
              style={{ marginLeft: agent.depth > 0 ? Math.min(agent.depth, 4) * 10 : 0 }}
            >
              {agent.depth > 0 ? (
                <CornerDownRightIcon className="size-3.5 shrink-0 opacity-60" />
              ) : (
                <BotIcon className="size-3.5 shrink-0 opacity-70" />
              )}
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium text-xs">{displayName(agent)}</div>
                <div className="mt-0.5 flex items-center gap-1.5">
                  <CircleIcon className="size-2 shrink-0 fill-current opacity-60" />
                  <span className="truncate text-[0.68rem] capitalize">{agent.agentKind}</span>
                  {agent.childrenCount > 0 ? (
                    <span className="text-[0.68rem]">
                      {agent.childrenCount} {agent.childrenCount === 1 ? "child" : "children"}
                    </span>
                  ) : null}
                </div>
              </div>
              <Badge variant={statusVariant(agent.status)} size="sm">
                {statusLabel[agent.status]}
              </Badge>
            </button>
          );
        })}
      </div>
      {selected ? (
        <AgentTrace snapshot={snapshot} selected={selected} onOpenAgent={openAgent} />
      ) : null}
    </section>
  );
}
