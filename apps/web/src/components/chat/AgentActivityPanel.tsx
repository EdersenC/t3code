import type {
  OrchestrationLatestTurn,
  OrchestrationThreadActivity,
  TurnId,
} from "@t3tools/contracts";
import {
  CheckCircle2,
  ChevronDown,
  Circle,
  CircleAlert,
  Clock3,
  Hammer,
  TerminalSquare,
  Wrench,
  XCircle,
} from "lucide-react";
import { memo, useMemo, useState } from "react";

import { formatDuration, type WorkLogEntry, workLogEntryIsToolLike } from "../../session-logic";
import {
  deriveTurnUsageAnalyticsByTurnId,
  formatTokensPerSecond,
  type TurnUsageAnalytics,
} from "../../lib/modelAnalytics";
import { formatContextWindowTokens } from "../../lib/contextWindow";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { ScrollArea } from "../ui/scroll-area";
import { Separator } from "../ui/separator";
import { MessageCopyButton } from "./MessageCopyButton";
import {
  buildWorkEntryExpandedBody,
  buildWorkEntryDetailSections,
  resolveWorkEntryStatus,
  workEntryHeading,
  workEntryPreview,
  workEntryStatusLabel,
  type WorkEntryStatus,
} from "./workEntryPresentation";

interface AgentActivityPanelProps {
  workLogEntries: ReadonlyArray<WorkLogEntry>;
  threadActivities: ReadonlyArray<OrchestrationThreadActivity>;
  latestTurn: OrchestrationLatestTurn | null;
  activeTurnInProgress: boolean;
  workspaceRoot: string | undefined;
}

interface ActivityTurnGroup {
  id: string;
  turnId: TurnId | null;
  label: string;
  entries: WorkLogEntry[];
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
}

function elapsedMs(startIso: string | null | undefined, endIso: string | null | undefined) {
  if (!startIso || !endIso) return null;
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return end - start;
}

function entryCompletedAt(entry: WorkLogEntry): string {
  return entry.createdAt;
}

function statusTone(status: WorkEntryStatus): "success" | "error" | "warning" | "outline" {
  switch (status) {
    case "completed":
      return "success";
    case "failed":
      return "error";
    case "running":
      return "warning";
    case "empty":
      return "outline";
  }
}

function StatusIcon({ status, className }: { status: WorkEntryStatus; className?: string }) {
  switch (status) {
    case "completed":
      return <CheckCircle2 className={cn("size-4 text-success-foreground", className)} />;
    case "failed":
      return <XCircle className={cn("size-4 text-destructive", className)} />;
    case "running":
      return <Clock3 className={cn("size-4 text-warning-foreground", className)} />;
    case "empty":
      return <Circle className={cn("size-4 text-muted-foreground", className)} />;
  }
}

function entryIcon(entry: WorkLogEntry) {
  if (entry.command || entry.itemType === "command_execution") return TerminalSquare;
  if (entry.itemType === "mcp_tool_call") return Wrench;
  return Hammer;
}

function deriveActivityTurnGroups(input: {
  entries: ReadonlyArray<WorkLogEntry>;
  latestTurn: OrchestrationLatestTurn | null;
}): ActivityTurnGroup[] {
  const groups = new Map<string, ActivityTurnGroup>();
  for (const entry of input.entries.filter(workLogEntryIsToolLike)) {
    const turnId = entry.turnId ?? null;
    const id = turnId ? `turn:${turnId}` : "turn:unknown";
    const existing = groups.get(id);
    if (existing) {
      existing.entries.push(entry);
      const isLatest = turnId !== null && input.latestTurn?.turnId === turnId;
      existing.completedAt = isLatest
        ? (input.latestTurn?.completedAt ?? null)
        : existing.completedAt && existing.completedAt > entryCompletedAt(entry)
          ? existing.completedAt
          : entryCompletedAt(entry);
      existing.durationMs = elapsedMs(existing.startedAt, existing.completedAt);
      continue;
    }
    const isLatest = turnId !== null && input.latestTurn?.turnId === turnId;
    const startedAt = isLatest ? (input.latestTurn?.startedAt ?? entry.createdAt) : entry.createdAt;
    const completedAt = isLatest
      ? (input.latestTurn?.completedAt ?? null)
      : entryCompletedAt(entry);
    groups.set(id, {
      id,
      turnId,
      label: turnId ? `Turn ${String(turnId).slice(0, 8)}` : "Unassigned activity",
      entries: [entry],
      startedAt,
      completedAt,
      durationMs: elapsedMs(startedAt, completedAt),
    });
  }
  return [...groups.values()].toSorted((left, right) =>
    right.startedAt.localeCompare(left.startedAt),
  );
}

function summarizeEntries(entries: ReadonlyArray<WorkLogEntry>, activeTurnInProgress: boolean) {
  let completed = 0;
  let failed = 0;
  let running = 0;
  let empty = 0;
  for (const entry of entries) {
    const status = resolveWorkEntryStatus(entry, !activeTurnInProgress);
    if (status === "completed") completed += 1;
    else if (status === "failed") failed += 1;
    else if (status === "running") running += 1;
    else empty += 1;
  }
  return { completed, failed, running, empty, total: entries.length };
}

function summarizeGroups(
  groups: ReadonlyArray<ActivityTurnGroup>,
  latestTurn: OrchestrationLatestTurn | null,
  activeTurnInProgress: boolean,
) {
  return groups.reduce(
    (total, group) => {
      const groupSummary = summarizeEntries(
        group.entries,
        activeTurnInProgress && latestTurn?.turnId === group.turnId,
      );
      return {
        completed: total.completed + groupSummary.completed,
        failed: total.failed + groupSummary.failed,
        running: total.running + groupSummary.running,
        empty: total.empty + groupSummary.empty,
        total: total.total + groupSummary.total,
      };
    },
    { completed: 0, failed: 0, running: 0, empty: 0, total: 0 },
  );
}

export const AgentActivityPanel = memo(function AgentActivityPanel({
  workLogEntries,
  threadActivities,
  latestTurn,
  activeTurnInProgress,
  workspaceRoot,
}: AgentActivityPanelProps) {
  const [expandedEntryIds, setExpandedEntryIds] = useState<ReadonlySet<string>>(new Set());
  const usageByTurnId = useMemo(
    () => deriveTurnUsageAnalyticsByTurnId(threadActivities),
    [threadActivities],
  );
  const groups = useMemo(
    () => deriveActivityTurnGroups({ entries: workLogEntries, latestTurn }),
    [latestTurn, workLogEntries],
  );
  const totals = summarizeGroups(groups, latestTurn, activeTurnInProgress);

  const toggleEntry = (entryId: string) => {
    setExpandedEntryIds((current) => {
      const next = new Set(current);
      if (next.has(entryId)) next.delete(entryId);
      else next.add(entryId);
      return next;
    });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <div className="border-b border-border/70 px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-foreground">Activity</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {totals.total === 0
                ? "No tool calls yet"
                : `${totals.total} tool calls across ${groups.length} turns`}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {totals.running > 0 ? <Badge variant="warning">{totals.running} running</Badge> : null}
            {totals.failed > 0 ? <Badge variant="error">{totals.failed} failed</Badge> : null}
            {totals.completed > 0 ? <Badge variant="success">{totals.completed} done</Badge> : null}
          </div>
        </div>
      </div>

      <ScrollArea scrollFade scrollbarGutter className="min-h-0 flex-1">
        {groups.length === 0 ? (
          <div className="flex min-h-80 flex-col items-center justify-center px-6 text-center">
            <CircleAlert className="mb-3 size-8 text-muted-foreground/50" />
            <p className="text-sm font-medium text-foreground">No activity for this thread</p>
            <p className="mt-1 max-w-80 text-xs leading-relaxed text-muted-foreground">
              Tool calls, terminal commands, file reads, approvals, and provider diagnostics will
              appear here as the agent works.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border/60">
            {groups.map((group) => (
              <ActivityTurnSection
                key={group.id}
                group={group}
                usage={group.turnId ? (usageByTurnId.get(group.turnId) ?? null) : null}
                activeTurnInProgress={activeTurnInProgress && latestTurn?.turnId === group.turnId}
                expandedEntryIds={expandedEntryIds}
                workspaceRoot={workspaceRoot}
                onToggleEntry={toggleEntry}
              />
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  );
});

function ActivityTurnSection({
  group,
  usage,
  activeTurnInProgress,
  expandedEntryIds,
  workspaceRoot,
  onToggleEntry,
}: {
  group: ActivityTurnGroup;
  usage: TurnUsageAnalytics | null;
  activeTurnInProgress: boolean;
  expandedEntryIds: ReadonlySet<string>;
  workspaceRoot: string | undefined;
  onToggleEntry: (entryId: string) => void;
}) {
  const summary = summarizeEntries(group.entries, activeTurnInProgress);
  const durationLabel =
    usage?.durationMs !== null && usage?.durationMs !== undefined
      ? formatDuration(usage.durationMs)
      : group.durationMs !== null
        ? formatDuration(group.durationMs)
        : activeTurnInProgress
          ? "running"
          : null;
  const effectiveDurationMs = usage?.durationMs ?? group.durationMs;
  const tps =
    usage && effectiveDurationMs !== null
      ? formatTokensPerSecond(usage.totalTokens / Math.max(0.001, effectiveDurationMs / 1000))
      : null;

  return (
    <section className="px-3 py-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-xs font-semibold uppercase text-muted-foreground">
            {activeTurnInProgress ? "Current turn" : group.label}
          </h3>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
            <span>{summary.total} calls</span>
            {durationLabel ? (
              <>
                <span aria-hidden>/</span>
                <span>{durationLabel}</span>
              </>
            ) : null}
            {usage ? (
              <>
                <span aria-hidden>/</span>
                <span>{formatContextWindowTokens(usage.totalTokens)} tokens</span>
              </>
            ) : null}
            {tps ? (
              <>
                <span aria-hidden>/</span>
                <span>{tps}</span>
              </>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {summary.failed > 0 ? <Badge variant="error">{summary.failed}</Badge> : null}
          {summary.running > 0 ? <Badge variant="warning">{summary.running}</Badge> : null}
          {summary.completed > 0 ? <Badge variant="success">{summary.completed}</Badge> : null}
        </div>
      </div>
      <div className="overflow-hidden rounded-md border border-border/70">
        {group.entries.map((entry, index) => (
          <ActivityEntryRow
            key={entry.id}
            entry={entry}
            expanded={expandedEntryIds.has(entry.id)}
            activeTurnInProgress={activeTurnInProgress}
            workspaceRoot={workspaceRoot}
            onToggle={() => onToggleEntry(entry.id)}
            showSeparator={index > 0}
          />
        ))}
      </div>
    </section>
  );
}

function ActivityEntryRow({
  entry,
  expanded,
  activeTurnInProgress,
  workspaceRoot,
  onToggle,
  showSeparator,
}: {
  entry: WorkLogEntry;
  expanded: boolean;
  activeTurnInProgress: boolean;
  workspaceRoot: string | undefined;
  onToggle: () => void;
  showSeparator: boolean;
}) {
  const Icon = entryIcon(entry);
  const status = resolveWorkEntryStatus(entry, !activeTurnInProgress);
  const sections = buildWorkEntryDetailSections(entry, workspaceRoot);
  const body = buildWorkEntryExpandedBody(entry, workspaceRoot);
  const heading = workEntryHeading(entry);
  const preview = workEntryPreview(entry, workspaceRoot);
  const canExpand = sections.length > 0 && body !== null;
  const statusLabel = workEntryStatusLabel(status);

  return (
    <div className="bg-card/30">
      {showSeparator ? <Separator /> : null}
      <button
        type="button"
        disabled={!canExpand}
        onClick={canExpand ? onToggle : undefined}
        className={cn(
          "flex w-full items-start gap-2 px-2.5 py-2 text-left",
          canExpand &&
            "hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
        )}
      >
        <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground">
          <Icon className="size-3.5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-sm font-medium text-foreground">{heading}</span>
            <Badge variant={statusTone(status)} size="sm">
              {statusLabel}
            </Badge>
          </span>
          {preview ? (
            <span className="mt-0.5 block truncate text-xs text-muted-foreground">{preview}</span>
          ) : null}
        </span>
        <StatusIcon status={status} className="mt-1 shrink-0" />
        {canExpand ? (
          <ChevronDown
            className={cn(
              "mt-1 size-4 shrink-0 text-muted-foreground transition-transform",
              expanded && "rotate-180",
            )}
          />
        ) : null}
      </button>
      {expanded && body ? (
        <div className="border-t border-border/60 bg-background/70">
          <div className="flex h-8 items-center justify-between px-2.5">
            <span className="text-[10px] font-medium uppercase text-muted-foreground">
              Tool call details
            </span>
            <MessageCopyButton text={body} size="icon-xs" variant="ghost" className="h-5 w-5" />
          </div>
          <div className="max-h-[55vh] overflow-auto px-2.5 pb-2.5 scrollbar-gutter-stable">
            <div className="space-y-2">
              {sections.map((section) => (
                <section
                  key={`${entry.id}:${section.id}`}
                  className="overflow-hidden rounded border border-border/60 bg-card/35"
                >
                  <div className="border-b border-border/50 bg-muted/25 px-2 py-1 text-[10px] font-medium uppercase text-muted-foreground">
                    {section.label}
                  </div>
                  <pre className="whitespace-pre-wrap break-words px-2 py-1.5 font-mono text-[11px] leading-relaxed text-muted-foreground">
                    {section.text}
                  </pre>
                </section>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
