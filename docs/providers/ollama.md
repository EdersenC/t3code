# Ollama

Ollama is the preferred local-first provider path for open-weight models in T3 Code. The current
implementation generates an OpenCode provider config for Ollama's OpenAI-compatible endpoint and lets
OpenCode own the harness session.

## Implementation Path

- Use the local Ollama server at `http://localhost:11434/v1`.
- Generate OpenCode config with `@ai-sdk/openai-compatible` until OpenCode ships a first-class
  Ollama provider SDK.
- Keep the OpenCode config-generation tests close to `apps/server/src/provider/ollamaOpenCode.ts`;
  this is where model names, cloud labels, context estimates, and model options are translated.
- Prefer passing model behavior through OpenCode model `options` instead of custom HTTP request
  rewrites.

## Local Models

Local models are the most reliable Ollama route because they avoid hosted-provider TPM/RPM limits and
provider-account gating. They still need operational guardrails:

- report startup/load failures with the underlying Ollama/OpenCode error text
- prefer GPU-resident models and warn before CPU fallback when GPU memory is unavailable
- show estimated context usage because local models do not all report exact context accounting

## Cloud Models

Ollama Cloud models are exposed with cloud-flavored IDs such as `gpt-oss:20b-cloud`,
`gpt-oss:120b-cloud`, or `glm-5.2:cloud`. T3 Code should normalize the visible label and show a
Cloud tag while keeping the full provider ID available internally.

Ollama's pricing page says the free tier includes cloud access, while Pro includes higher cloud usage
and access to larger cloud models. Treat the cloud catalog as discoverable but not automatically
usable for the current account.

Source: <https://ollama.com/pricing>

Current cloud catalog examples include:

- `gpt-oss`
- `glm-5.2`
- `qwen3.5`
- `deepseek-v4.2`
- `kimi-k2.7-code`

Source: <https://ollama.com/search?c=cloud>

## Access Probing

The catalog can list models the user's plan cannot run. When an account is limited, Ollama can return
upgrade or model-access errors only after a real request. For cloud models:

- probe sparingly and cache the result
- make inaccessible models visibly disabled or tagged with the failure reason
- surface the provider error text in the UI so it can be copied
- do not loop retries on access failures

`glm-5.2:cloud` is listed as a cloud model, but its model page marks it as high usage. Assume it may
require an upgraded Ollama plan unless a probe succeeds for the current account.

Source: <https://ollama.com/library/glm-5.2:cloud>

## Reasoning Level

Some Ollama-compatible reasoning models accept `reasoning_effort`. OpenCode's provider option
migration maps a model option named `reasoningEffort` into `reasoning_effort` for compatible
providers. T3 Code exposes this as:

- Default
- None
- Low
- Medium
- High

Models that do not support reasoning controls may ignore the option or reject the request. If a
request fails because of this option, show the provider error and ask the user to retry with Default.
