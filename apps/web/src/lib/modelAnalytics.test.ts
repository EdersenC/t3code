import { describe, expect, it } from "vite-plus/test";
import { EventId, type OrchestrationThreadActivity, TurnId } from "@t3tools/contracts";
import {
  deriveCurrentModelAnalytics,
  deriveModelAnalyticsRollup,
  formatTokensPerSecond,
  formatTurnAnalyticsSuffix,
} from "./modelAnalytics";

function usageActivity(input: {
  readonly id: string;
  readonly turnId: string;
  readonly createdAt: string;
  readonly payload: Record<string, unknown>;
}): OrchestrationThreadActivity {
  return {
    id: EventId.make(input.id),
    turnId: TurnId.make(input.turnId),
    kind: "context-window.updated",
    tone: "info",
    summary: "Context updated",
    payload: input.payload,
    createdAt: input.createdAt,
  };
}

describe("modelAnalytics", () => {
  it("dedupes usage by turn and derives session totals", () => {
    const rollup = deriveModelAnalyticsRollup([
      [
        usageActivity({
          id: "usage-1",
          turnId: "turn-1",
          createdAt: "2026-01-01T00:00:01Z",
          payload: { usedTokens: 100, lastInputTokens: 70, lastOutputTokens: 30 },
        }),
        usageActivity({
          id: "usage-2",
          turnId: "turn-1",
          createdAt: "2026-01-01T00:00:02Z",
          payload: {
            usedTokens: 200,
            lastInputTokens: 140,
            lastOutputTokens: 60,
            durationMs: 2_000,
          },
        }),
        usageActivity({
          id: "usage-3",
          turnId: "turn-2",
          createdAt: "2026-01-01T00:00:03Z",
          payload: {
            usedTokens: 300,
            lastInputTokens: 200,
            lastOutputTokens: 100,
            durationMs: 3_000,
          },
        }),
      ],
    ]);

    expect(rollup).toMatchObject({
      turnCount: 2,
      inputTokens: 340,
      outputTokens: 160,
      totalTokens: 500,
      durationMs: 5_000,
      tokensPerSecond: 100,
    });
  });

  it("keeps the same turn id distinct across activity streams", () => {
    const rollup = deriveModelAnalyticsRollup([
      [
        usageActivity({
          id: "usage-1",
          turnId: "shared-turn",
          createdAt: "2026-01-01T00:00:01Z",
          payload: {
            usedTokens: 200,
            lastInputTokens: 140,
            lastOutputTokens: 60,
            durationMs: 2_000,
          },
        }),
      ],
      [
        usageActivity({
          id: "usage-2",
          turnId: "shared-turn",
          createdAt: "2026-01-01T00:00:02Z",
          payload: {
            usedTokens: 300,
            lastInputTokens: 200,
            lastOutputTokens: 100,
            durationMs: 3_000,
          },
        }),
      ],
    ]);

    expect(rollup).toMatchObject({
      turnCount: 2,
      inputTokens: 340,
      outputTokens: 160,
      totalTokens: 500,
      durationMs: 5_000,
      tokensPerSecond: 100,
    });
  });

  it("derives current-turn analytics from latest turn timing", () => {
    const analytics = deriveCurrentModelAnalytics({
      activities: [
        usageActivity({
          id: "usage-1",
          turnId: "turn-1",
          createdAt: "2026-01-01T00:00:02Z",
          payload: { usedTokens: 120, lastInputTokens: 80, lastOutputTokens: 40 },
        }),
      ],
      latestTurn: {
        turnId: TurnId.make("turn-1"),
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: "2026-01-01T00:00:04Z",
      },
    });

    expect(analytics.currentTurn).toMatchObject({
      totalTokens: 120,
      inputTokens: 80,
      outputTokens: 40,
      durationMs: 4_000,
    });
    expect(formatTurnAnalyticsSuffix(analytics.currentTurn, null)).toBe("120 tokens · 30 tok/s");
  });

  it("does not label stale usage as the current turn", () => {
    const analytics = deriveCurrentModelAnalytics({
      activities: [
        usageActivity({
          id: "usage-1",
          turnId: "turn-1",
          createdAt: "2026-01-01T00:00:02Z",
          payload: { usedTokens: 120, lastInputTokens: 80, lastOutputTokens: 40 },
        }),
      ],
      latestTurn: {
        turnId: TurnId.make("turn-2"),
        startedAt: "2026-01-01T00:00:04Z",
        completedAt: null,
      },
    });

    expect(analytics.currentTurn).toBeNull();
    expect(analytics.session).toMatchObject({
      turnCount: 1,
      totalTokens: 120,
    });
  });

  it("formats compact token throughput", () => {
    expect(formatTokensPerSecond(4.25)).toBe("4.3 tok/s");
    expect(formatTokensPerSecond(42.5)).toBe("43 tok/s");
    expect(formatTokensPerSecond(null)).toBeNull();
  });
});
