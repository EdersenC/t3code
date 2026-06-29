# Local Model Hub

The Local Model Hub is the product boundary for models the user owns or can run outside the
frontier-provider path. It should make local and user-controlled model setup reproducible across
machines while keeping the provider UX predictable inside T3 Code.

This page captures the agreed direction before implementation. Keep it current as the hub moves from
planning into code.

## Product Shape

- Add a sidebar entry that opens a dedicated main page for local models.
- Treat the hub as separate from the provider settings form, while still letting provider settings
  reference models managed by the hub.
- V1 sources are Hugging Face and Ollama.
- Show visible placeholders for future sources and runtimes, but keep them disabled until backed by
  working code.
- Use `Local` as the user-facing provider boundary. vLLM is one runtime inside Local, not the whole
  product concept.

The first page should be useful without launching servers: inventory, metadata, downloads, and
maintenance are enough for V1.

## V1 Scope

Build V1 around model acquisition and model-store management:

- choose and persist a model storage root per machine
- search or list models from Hugging Face and Ollama
- download models directly from the app
- detect already-downloaded models and avoid duplicate downloads
- show model status such as missing, downloading, available, failed, and stale metadata
- expose local path, disk usage, source, model ID, and last refresh/download time
- allow cancel/retry for failed or active downloads when the underlying source supports it

Do not make V1 responsible for launching vLLM, choosing runtime flags, or managing multiple model
server processes. Those controls belong in a later runtime-management phase after the model store is
solid.

## Storage Layout

The storage root must be dynamic and user-selectable. Do not hard-code this machine's paths or assume
`/mnt/s` exists.

Use a normal `models` root as the conceptual default. The actual default should be derived from the
runtime environment, such as an app data directory or another cross-machine-safe location chosen by
the user.

Suggested layout:

```text
models/
  huggingface/
    <namespace>/
      <model-name>/
  ollama/
    manifests/
    blobs/
  metadata/
    models.sqlite
    downloads/
```

The top-level folders should be source-oriented first (`huggingface`, `ollama`). Avoid modality or
format folders such as `gguf`, `voice`, or `vision` in V1; those can be added once the hub supports
format-specific runtimes.

Machine-local configuration should store:

- selected model root
- source credentials/token references
- source-specific cache paths
- runtime availability checks

Portable configuration should store:

- desired model IDs and revisions
- aliases and tags
- runtime presets
- provider bindings

This split matters because the eventual containerized runtime should be able to mount a host model
root without rewriting user-facing provider configuration.

## Source Abstraction

Each source should implement the same lifecycle concepts even if the backend details differ:

- `search`: find remote models and return normalized metadata
- `describe`: refresh a specific model card or manifest
- `listLocal`: inventory models already present under the configured root
- `download`: start a tracked download
- `cancel`: stop an active download if possible
- `remove`: delete a local model or cached revision after user action
- `probeAccess`: detect whether the current account can use a gated/cloud model

Hugging Face should preserve revision information when possible. Ollama should distinguish local
models from cloud models, including `:cloud` and `-cloud` naming forms, without hiding the full
provider ID from the backend.

## Metadata

Capture and display as much useful metadata as the source can provide. The normalized model record
should allow partial fields because no source exposes everything consistently.

High-value fields:

- source and model ID
- display name, description, tags, and license
- local path and total disk usage
- downloaded revision or digest
- file list and quantization hints
- context length and recommended max output tokens
- parameter count and architecture
- estimated VRAM/RAM requirements
- tool-calling support and required parser hints
- reasoning support and required parser hints
- downloads, likes, recency, and source popularity signals
- access status such as public, gated, unavailable, plan-limited, or unknown

The UI should show metadata honestly. If a value is inferred, label it as an estimate in code and
avoid treating it as a hard capability limit.

## Download Behavior

Downloads should be direct in-app actions. Do not make command generation the default UX.

Expected flow:

1. User picks a model.
2. App checks local inventory and current access state.
3. If the model is not already present, app starts the download.
4. Download progress streams to the hub page.
5. Completion updates inventory and provider availability.

Only prompt for extra confirmation when the action is destructive, unusually large, or overwrites an
existing local artifact. A normal first download should not require another "are you sure" step after
the user clicks download.

Failures should be copyable and source-specific: include the model ID, source, HTTP/CLI error text,
and suggested next action when known.

## Future Runtime Controls

Runtime launch and tuning are intentionally deferred, but the hub should be shaped so these controls
fit later:

- start/stop/health-check local vLLM instances
- one model per vLLM server by default
- choose host, port, GPU memory utilization, max model length, max output, and max concurrency
- configure tool parser and reasoning parser values required by the model/runtime
- expose model template/chat-template configuration when needed
- keep per-model runtime presets separate from downloaded model metadata
- support future Docker/container execution with explicit host path mounts

The provider should read from managed runtime instances instead of hard-coded endpoints. The current
manual vLLM server path is a stepping stone, not the final product shape.

## Safety Rails

Safety rails are mostly runtime-phase work, but the model hub data model should leave room for them:

- warn when estimated model memory exceeds available GPU memory
- warn before CPU fallback for large models
- cap max output and context to the runtime's reported capacity
- fail fast on deterministic context/window errors instead of retrying loops
- show access-plan failures for Ollama Cloud and gated Hugging Face models
- keep raw provider/runtime errors copyable in the UI

## Implementation Phases

1. **Model store settings**
   - Persist a machine-local model root.
   - Add source folders and local inventory discovery.
   - Show an empty hub page from the sidebar.

2. **Hugging Face downloads**
   - Add token-aware metadata fetch.
   - Download selected models into the configured root.
   - Track progress, cancellation, failure, and local status.

3. **Ollama inventory and cloud labels**
   - Inventory local Ollama models.
   - Mark cloud models separately from local models.
   - Probe access sparingly and cache failures.

4. **Provider binding**
   - Let the Local provider select a hub-managed model/runtime target.
   - Keep OpenCode/vLLM endpoint details behind the Local provider boundary.

5. **Runtime management**
   - Add vLLM process lifecycle controls, health checks, and per-model launch presets.
   - Add Docker/container support without changing the hub's source and inventory model.

## Open Questions

- Which app-data location should be the default model root on Windows, WSL, macOS, and Linux?
- Should Hugging Face downloads use `huggingface_hub`, `hf` CLI, direct HTTP, or a small T3-managed
  worker abstraction first?
- Should the hub keep its metadata in SQLite, server config, or a dedicated local JSON database?
- How much destructive cleanup should be available in V1: remove one model, prune failed downloads,
  prune old revisions, or all of the above?
- What provider/source placeholders should be visible on day one besides Hugging Face and Ollama?
