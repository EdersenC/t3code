# GLM and Z.ai

This note tracks practical routes for GLM-family models, especially GLM-5.2.

## Ollama Cloud

Ollama lists `glm-5.2:cloud`, but the model page marks it as high usage. It may not be runnable on a
free Ollama account even when it appears in the cloud catalog.

Sources:

- <https://ollama.com/search?c=cloud>
- <https://ollama.com/library/glm-5.2:cloud>

## OpenRouter

OpenRouter currently exposes at least one free GLM-family route, `z-ai/glm-4.5-air:free`. This is not
GLM-5.2, but it is the best low-friction free GLM option to validate a GLM provider flow in T3 Code.

Source: <https://openrouter.ai/models/z-ai/glm-4.5-air:free>

Implementation notes:

- Prefer OpenCode's OpenRouter SDK/provider integration if available.
- Otherwise use OpenCode's OpenAI-compatible provider shape with `https://openrouter.ai/api/v1`.
- Keep the API key in `OPENROUTER_API_KEY`.
- Add OpenRouter model metadata separately from Ollama Cloud so plan/access failures are easier to
  diagnose.

## Z.ai Direct

Z.ai documents an OpenAI-compatible API and lists GLM-5.2 in its model ecosystem. This is the most
direct route for GLM-5.2 if the account has access, but availability and pricing should be verified
with a real key before exposing it as a default.

Source: <https://docs.z.ai/>

Suggested implementation order:

1. Add OpenRouter as a provider first and smoke-test `z-ai/glm-4.5-air:free`.
2. Add Z.ai direct as an OpenAI-compatible provider if GLM-5.2 access is confirmed.
3. Add Ollama Cloud GLM probing only after the cloud access UI can disable unavailable models without
   retry loops.
