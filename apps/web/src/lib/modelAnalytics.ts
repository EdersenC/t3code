import { formatTokensPerSecond, type TurnUsageAnalytics } from "@t3tools/shared/modelAnalytics";
export {
  deriveCurrentModelAnalytics,
  deriveModelAnalyticsRollup,
  deriveTurnUsageAnalytics,
  deriveTurnUsageAnalyticsByTurnId,
  formatTokensPerSecond,
  type CurrentModelAnalytics,
  type ModelAnalyticsRollup,
  type TurnUsageAnalytics,
} from "@t3tools/shared/modelAnalytics";
import { formatContextWindowTokens } from "./contextWindow";

export function formatTurnAnalyticsSuffix(
  analytics: TurnUsageAnalytics | null,
  durationMs: number | null,
): string | null {
  if (!analytics) return null;
  const parts = [`${formatContextWindowTokens(analytics.totalTokens)} tokens`];
  const effectiveDurationMs = analytics.durationMs ?? durationMs;
  const tokensPerSecond =
    effectiveDurationMs !== null
      ? analytics.totalTokens / Math.max(0.001, effectiveDurationMs / 1000)
      : null;
  const formattedTps = formatTokensPerSecond(tokensPerSecond);
  if (formattedTps) parts.push(formattedTps);
  return parts.join(" · ");
}
