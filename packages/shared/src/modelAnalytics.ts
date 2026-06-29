import type {
  OrchestrationLatestTurn,
  OrchestrationThreadActivity,
  ThreadTokenUsageSnapshot,
  TurnId,
} from "@t3tools/contracts";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonNegative(value: number | null): number | null {
  return value !== null && value >= 0 ? value : null;
}

function sumOptional(values: ReadonlyArray<number | null | undefined>): number | null {
  let total = 0;
  let hasValue = false;
  for (const value of values) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      continue;
    }
    total += value;
    hasValue = true;
  }
  return hasValue ? total : null;
}

function elapsedMs(startIso: string | null | undefined, endIso: string | null | undefined) {
  if (!startIso || !endIso) return null;
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return end - start;
}

export interface TurnUsageAnalytics {
  readonly turnId: TurnId;
  readonly updatedAt: string;
  readonly usage: ThreadTokenUsageSnapshot;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number;
  readonly durationMs: number | null;
}

export interface ModelAnalyticsRollup {
  readonly turnCount: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly durationMs: number | null;
  readonly tokensPerSecond: number | null;
}

export interface CurrentModelAnalytics {
  readonly currentTurn: TurnUsageAnalytics | null;
  readonly session: ModelAnalyticsRollup;
}

export function usageFromActivity(
  activity: Pick<OrchestrationThreadActivity, "kind" | "payload">,
): ThreadTokenUsageSnapshot | null {
  if (activity.kind !== "context-window.updated") return null;
  const payload = asRecord(activity.payload);
  const usedTokens = nonNegative(asFiniteNumber(payload?.usedTokens));
  if (usedTokens === null) return null;

  return {
    usedTokens,
    ...(nonNegative(asFiniteNumber(payload?.totalProcessedTokens)) !== null
      ? { totalProcessedTokens: nonNegative(asFiniteNumber(payload?.totalProcessedTokens))! }
      : {}),
    ...(nonNegative(asFiniteNumber(payload?.maxTokens)) !== null
      ? { maxTokens: nonNegative(asFiniteNumber(payload?.maxTokens))! }
      : {}),
    ...(nonNegative(asFiniteNumber(payload?.inputTokens)) !== null
      ? { inputTokens: nonNegative(asFiniteNumber(payload?.inputTokens))! }
      : {}),
    ...(nonNegative(asFiniteNumber(payload?.cachedInputTokens)) !== null
      ? { cachedInputTokens: nonNegative(asFiniteNumber(payload?.cachedInputTokens))! }
      : {}),
    ...(nonNegative(asFiniteNumber(payload?.outputTokens)) !== null
      ? { outputTokens: nonNegative(asFiniteNumber(payload?.outputTokens))! }
      : {}),
    ...(nonNegative(asFiniteNumber(payload?.reasoningOutputTokens)) !== null
      ? { reasoningOutputTokens: nonNegative(asFiniteNumber(payload?.reasoningOutputTokens))! }
      : {}),
    ...(nonNegative(asFiniteNumber(payload?.lastUsedTokens)) !== null
      ? { lastUsedTokens: nonNegative(asFiniteNumber(payload?.lastUsedTokens))! }
      : {}),
    ...(nonNegative(asFiniteNumber(payload?.lastInputTokens)) !== null
      ? { lastInputTokens: nonNegative(asFiniteNumber(payload?.lastInputTokens))! }
      : {}),
    ...(nonNegative(asFiniteNumber(payload?.lastCachedInputTokens)) !== null
      ? { lastCachedInputTokens: nonNegative(asFiniteNumber(payload?.lastCachedInputTokens))! }
      : {}),
    ...(nonNegative(asFiniteNumber(payload?.lastOutputTokens)) !== null
      ? { lastOutputTokens: nonNegative(asFiniteNumber(payload?.lastOutputTokens))! }
      : {}),
    ...(nonNegative(asFiniteNumber(payload?.lastReasoningOutputTokens)) !== null
      ? {
          lastReasoningOutputTokens: nonNegative(
            asFiniteNumber(payload?.lastReasoningOutputTokens),
          )!,
        }
      : {}),
    ...(nonNegative(asFiniteNumber(payload?.toolUses)) !== null
      ? { toolUses: nonNegative(asFiniteNumber(payload?.toolUses))! }
      : {}),
    ...(nonNegative(asFiniteNumber(payload?.durationMs)) !== null
      ? { durationMs: nonNegative(asFiniteNumber(payload?.durationMs))! }
      : {}),
    ...(typeof payload?.compactsAutomatically === "boolean"
      ? { compactsAutomatically: payload.compactsAutomatically }
      : {}),
  };
}

export function deriveTurnUsageAnalytics(input: {
  readonly turnId: TurnId;
  readonly usage: ThreadTokenUsageSnapshot;
  readonly updatedAt: string;
  readonly durationMs?: number | null | undefined;
}): TurnUsageAnalytics {
  const inputTokens = sumOptional([input.usage.lastInputTokens, input.usage.lastCachedInputTokens]);
  const outputTokens = sumOptional([
    input.usage.lastOutputTokens,
    input.usage.lastReasoningOutputTokens,
  ]);
  const fallbackInputTokens = sumOptional([input.usage.inputTokens, input.usage.cachedInputTokens]);
  const fallbackOutputTokens = sumOptional([
    input.usage.outputTokens,
    input.usage.reasoningOutputTokens,
  ]);
  const totalTokens =
    input.usage.lastUsedTokens ??
    sumOptional([inputTokens, outputTokens]) ??
    sumOptional([fallbackInputTokens, fallbackOutputTokens]) ??
    input.usage.usedTokens;
  const durationMs = nonNegative(input.usage.durationMs ?? input.durationMs ?? null);

  return {
    turnId: input.turnId,
    updatedAt: input.updatedAt,
    usage: input.usage,
    inputTokens: inputTokens ?? fallbackInputTokens,
    outputTokens: outputTokens ?? fallbackOutputTokens,
    totalTokens,
    durationMs,
  };
}

export function deriveTurnUsageAnalyticsByTurnId(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyMap<TurnId, TurnUsageAnalytics> {
  const latestByTurn = new Map<TurnId, TurnUsageAnalytics>();
  for (const activity of activities) {
    if (!activity.turnId) continue;
    const usage = usageFromActivity(activity);
    if (!usage) continue;
    latestByTurn.set(
      activity.turnId,
      deriveTurnUsageAnalytics({
        turnId: activity.turnId,
        usage,
        updatedAt: activity.createdAt,
      }),
    );
  }
  return latestByTurn;
}

export function deriveModelAnalyticsRollup(
  activityStreams: ReadonlyArray<ReadonlyArray<OrchestrationThreadActivity>>,
): ModelAnalyticsRollup {
  const latestByTurn = new Map<string, TurnUsageAnalytics>();
  activityStreams.forEach((activities, streamIndex) => {
    for (const [turnId, analytics] of deriveTurnUsageAnalyticsByTurnId(activities)) {
      latestByTurn.set(`${streamIndex}:${turnId}`, analytics);
    }
  });

  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let durationMs = 0;
  let hasDuration = false;
  for (const analytics of latestByTurn.values()) {
    inputTokens += analytics.inputTokens ?? 0;
    outputTokens += analytics.outputTokens ?? 0;
    totalTokens += analytics.totalTokens;
    if (analytics.durationMs !== null) {
      durationMs += analytics.durationMs;
      hasDuration = true;
    }
  }

  const duration = hasDuration ? durationMs : null;
  return {
    turnCount: latestByTurn.size,
    inputTokens,
    outputTokens,
    totalTokens,
    durationMs: duration,
    tokensPerSecond: duration !== null ? totalTokens / Math.max(0.001, duration / 1000) : null,
  };
}

export function deriveCurrentModelAnalytics(input: {
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly latestTurn?: Pick<
    OrchestrationLatestTurn,
    "turnId" | "startedAt" | "completedAt"
  > | null;
}): CurrentModelAnalytics {
  const session = deriveModelAnalyticsRollup([input.activities]);
  const latestByTurn = deriveTurnUsageAnalyticsByTurnId(input.activities);
  const latestTurn = input.latestTurn ?? null;
  const currentTurn = latestTurn?.turnId
    ? latestByTurn.has(latestTurn.turnId)
      ? deriveTurnUsageAnalytics({
          turnId: latestTurn.turnId,
          usage: latestByTurn.get(latestTurn.turnId)!.usage,
          updatedAt: latestByTurn.get(latestTurn.turnId)!.updatedAt,
          durationMs: elapsedMs(latestTurn.startedAt, latestTurn.completedAt),
        })
      : null
    : (Array.from(latestByTurn.values()).at(-1) ?? null);

  return { currentTurn, session };
}

export function formatTokensPerSecond(value: number | null): string | null {
  if (value === null || !Number.isFinite(value) || value < 0) return null;
  if (value < 10) return `${value.toFixed(1).replace(/\.0$/, "")} tok/s`;
  return `${Math.round(value)} tok/s`;
}
