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

### Adapter Boundary

The hub should use one source adapter contract for all model sources. The source-specific adapter owns
remote discovery, access checks, download execution, and local inventory mapping; the page and provider
binding code should only consume normalized hub records.

Proposed adapter shape:

```ts
interface LocalModelSourceAdapter {
  readonly source: "huggingface" | "ollama" | string;
  search(
    input: LocalModelSearchInput,
  ): Effect<ReadonlyArray<LocalModelSearchResult>, LocalModelHubError>;
  describe(input: LocalModelDescribeInput): Effect<LocalModelMetadata, LocalModelHubError>;
  listLocal(
    input: LocalModelInventoryInput,
  ): Effect<ReadonlyArray<LocalModelRecord>, LocalModelHubError>;
  download(input: LocalModelDownloadInput): Effect<LocalModelDownloadHandle, LocalModelHubError>;
  cancel(input: LocalModelDownloadId): Effect<void, LocalModelHubError>;
  remove(input: LocalModelRemoveInput): Effect<void, LocalModelHubError>;
  probeAccess(
    input: LocalModelAccessProbeInput,
  ): Effect<LocalModelAccessStatus, LocalModelHubError>;
}
```

Keep the persisted hub state source-neutral:

- model root and source folders
- normalized model ID
- source model ID and revision/digest
- local path
- source metadata snapshot
- file count, total artifact size, parameter count, and quantization hints when available
- current download status
- last error and raw provider detail

Do not let Hugging Face cache layout, Ollama manifests, or future provider-specific concepts leak
into the UI data model except as source-specific metadata fields.

## Researched Source Behavior

### Hugging Face

Hugging Face should be the first remote-file source because its Hub APIs expose the metadata and
file-resolution behavior the hub needs:

- `HfApi` is the flexible API client for Hub search and model metadata, including token-per-request
  usage without persisting credentials on disk.
- The model metadata API returns sibling file names for a repo.
- `/{model}/resolve/{revision}/{file}` downloads files without requiring a local Python/HF CLI
  install.
- `hf download`, `hf cache ls --format json`, and `scan_cache_dir()` remain useful references for
  future maintenance features, but the app should not require the `hf` executable for normal
  downloads.

V1 recommendation:

- Use `HfApi` or direct Hub HTTP for search/describe metadata.
- Download files with direct Hub HTTP streaming into
  `<model-root>/huggingface/<namespace>/<model>`, because it works inside the app process and avoids
  `spawn hf` platform/path failures.
- Support include/exclude download profiles so users can choose whole repos, safetensors, GGUF,
  4-bit, 8-bit, or 16-bit/BF16-style artifacts.
- Add dry-run/size preview later from metadata or a dedicated source adapter method, not as a
  user-facing confirmation gate.
- Pass tokens through process environment (`HF_TOKEN`) or command option plumbing owned by the server
  settings/secrets layer; never write raw tokens into docs, logs, or model metadata.

### Ollama

Ollama should be handled as a local/service-backed source rather than as normal files under the hub
root. Its own store uses manifests and blobs, and users may already have an active Ollama model
store. The hub should display and control Ollama models through the Ollama API first, then offer
storage-root guidance where Ollama itself supports it.

Useful Ollama API/CLI behavior:

- model names follow `model:tag`, with optional namespace and default `latest`
- `/api/tags` lists local models
- `/api/show` returns model details such as license, modelfile, template, parameters, and details
- `/api/pull` pulls models and streams status objects
- `/api/ps` / `ollama ps` show running models and processor placement
- `/api/generate` and `/api/chat` accept `keep_alive`, and an empty prompt can preload/unload
  models for later runtime management
- `ollama ps` exposes CPU/GPU placement (`100% GPU`, `100% CPU`, or split CPU/GPU), which should feed
  future safety rails

V1 recommendation:

- Inventory Ollama through `/api/tags` and enrich with `/api/show`.
- Pull through `/api/pull` so progress can stream without shell parsing.
- Keep existing Ollama storage intact unless the user explicitly configures `OLLAMA_MODELS` outside
  the app.
- Treat cloud models as remote-access entries with `cloud` tags and cached access probe state.

## Download Orchestration

Downloads should be tracked by a server-side hub runtime instead of fire-and-forget RPC calls.

V1 process:

1. Create a download record with source, model ID, target path, status, created time, and logs.
2. Resolve the selected source/download profile into concrete files or a source-native pull request.
3. Skip already-current files when the source can prove they match.
4. Start one source-adapter download task.
5. Capture progress/log lines into the record.
6. Mark `completed`, `failed`, or `cancelled`.
7. Refresh local inventory for that source.

The first implementation can expose progress through refreshable snapshots. A follow-up can add a
streaming subscription once the data model is stable.

Download records should be durable enough that a server restart can show "unknown/interrupted" for
unfinished downloads instead of losing the action entirely. Long-term, use SQLite or another
server-local database; a small JSON file under `models/metadata/downloads/` is acceptable for the
earliest slice if it is wrapped behind the same service interface.

## Metadata

Capture and display as much useful metadata as the source can provide. The normalized model record
should allow partial fields because no source exposes everything consistently.

High-value fields:

- source and model ID
- display name, description, tags, and license
- local path and total disk usage
- remote artifact size and file count
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
   - Add token-aware metadata fetch using `HfApi` or Hub HTTP.
   - Download selected models into the configured root with direct Hub HTTP streaming.
   - Track progress, cancellation, failure, and local status.

3. **Ollama inventory and cloud labels**
   - Inventory local Ollama models with `/api/tags` and enrich with `/api/show`.
   - Mark cloud models separately from local models.
   - Probe access sparingly and cache failures.
   - Pull models through `/api/pull` and surface streamed progress.

4. **Provider binding**
   - Let the Local provider select a hub-managed model/runtime target.
   - Keep OpenCode/vLLM endpoint details behind the Local provider boundary.

5. **Runtime management**
   - Add vLLM process lifecycle controls, health checks, and per-model launch presets.
   - Add Docker/container support without changing the hub's source and inventory model.

## Open Questions

- Which app-data location should be the default model root on Windows, WSL, macOS, and Linux?
- Should the hub keep its metadata in SQLite, server config, or a dedicated local JSON database?
- How much destructive cleanup should be available in V1: remove one model, prune failed downloads,
  prune old revisions, or all of the above?
- What provider/source placeholders should be visible on day one besides Hugging Face and Ollama?

## References

- Hugging Face HfApi client: <https://huggingface.co/docs/huggingface_hub/package_reference/hf_api>
- Hugging Face download guide: <https://huggingface.co/docs/huggingface_hub/guides/download>
- Hugging Face CLI guide: <https://huggingface.co/docs/huggingface_hub/guides/cli>
- Hugging Face cache guide: <https://huggingface.co/docs/huggingface_hub/guides/manage-cache>
- Hugging Face environment variables: <https://huggingface.co/docs/huggingface_hub/package_reference/environment_variables>
- Ollama API reference: <https://github.com/ollama/ollama/blob/main/docs/api.md>
- Ollama GPU/processor placement FAQ: <https://github.com/ollama/ollama/blob/main/docs/faq.mdx>
