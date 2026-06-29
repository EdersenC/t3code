# Groq

Groq is useful for fast hosted inference, but the current on-demand/free limits make it a poor fit for
full OpenCode coding-agent turns. Keep the implementation available, but treat it as an optional
cloud provider that needs a paid or higher-limit Groq account for serious use.

## Implementation Path

- Use OpenCode's native Groq provider SDK path with `@ai-sdk/groq`.
- Do not route Groq through a generic OpenAI-compatible shim when OpenCode supports the first-class
  SDK.
- Generate OpenCode config and let OpenCode own the request/stream lifecycle.
- Keep request massaging small and covered by config tests.

OpenCode SDK/provider shape should be verified against the local OpenCode reference clone at
`/home/eddy/Projects/opencode` before changing this provider.

## Practical Limit

OpenCode turns are much larger than normal chat prompts because they include instructions, tool
schemas, project context, and conversation state. A tiny user message can become thousands of prompt
tokens before it reaches Groq.

Groq rate limits include token-per-minute and request-size limits. When the OpenCode prompt exceeds
those limits, Groq can reject the request before any useful assistant text is produced.

Source: <https://console.groq.com/docs/rate-limits>

## Failure Handling

Groq failures should be propagated to the UI as copyable provider errors. In particular:

- fail fast on TPM/request-size/rate-limit errors
- avoid retry loops for deterministic request-size failures
- include the selected model ID and underlying Groq/OpenCode detail
- suggest a smaller-context thread, a smaller model, or an upgraded Groq tier

The current implementation should suppress extra OpenCode status noise after a fatal Groq rate-limit
failure so the thread does not keep looping.

## Current Recommendation

Keep Groq in the app for users with higher limits. For the current local-model direction, prioritize
Ollama and OpenRouter/Z.ai GLM routes before investing more UX in Groq.
