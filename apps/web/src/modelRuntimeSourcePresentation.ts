import type { ServerProviderModelRuntimeSource } from "@t3tools/contracts";

export function getModelRuntimeSourceLabel(source: ServerProviderModelRuntimeSource): string {
  return source === "cloud" ? "Cloud" : "Local";
}

export function getModelRuntimeSourceBadgeClassName(
  source: ServerProviderModelRuntimeSource,
): string {
  if (source === "cloud") {
    return "border-sky-500/30 bg-sky-500/12 text-sky-700 dark:border-sky-400/30 dark:bg-sky-400/12 dark:text-sky-200";
  }

  return "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:border-emerald-400/25 dark:bg-emerald-400/10 dark:text-emerald-200";
}
