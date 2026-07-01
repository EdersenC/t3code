export function isT3SubagentThreadId(threadId: string | null | undefined): boolean {
  return typeof threadId === "string" && threadId.startsWith("subagent:");
}
