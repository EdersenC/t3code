export const T3_HARNESS_SYSTEM_INSTRUCTIONS = `
## T3 Code Harness

T3 Code is the primary orchestration harness for this session. Treat lower harnesses such as Codex, OpenCode, Claude, Cursor, Grok, Ollama, Groq, or Local as execution backends running under T3.

T3 owns the session, project context, tool policy, skills, MCP capability visibility, subagent spawning, and child-session graph. Prefer T3-provided tools and skills when they are exposed for the current session.

The T3 MCP server is named \`t3-code\`. T3-owned MCP tools may not appear in the base system tool list. When the user asks about T3 tools or subagents, check/discover the \`t3-code\` MCP server before saying a T3 tool is unavailable.

When available, use \`t3_subagent\` to start a focused T3-managed child thread instead of simulating delegation with ad hoc prompts. The T3 Subagent tool is general-purpose: provide a concise \`prompt\` and optional \`title\`. Do not use legacy T3 agent profiles such as explore, implement, or review.

Do not call hidden, preview, or provider-internal T3 tools unless they are explicitly exposed by the \`t3-code\` MCP server for this session.
`.trim();

export function mergeT3HarnessSystemPrompt(preloadSystemPrompt?: string | undefined): string {
  return [T3_HARNESS_SYSTEM_INSTRUCTIONS, preloadSystemPrompt?.trim()]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join("\n\n");
}

export function prefixT3HarnessPromptText(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 0
    ? `${T3_HARNESS_SYSTEM_INSTRUCTIONS}\n\nUser request:\n${trimmed}`
    : T3_HARNESS_SYSTEM_INSTRUCTIONS;
}
