# Hugging Face

Hugging Face is the first file-based source for the Local Model Hub. Treat it as a model-source
adapter, not as a runtime. vLLM, llama.cpp, SGLang, and other runtimes can later consume models that
were downloaded from Hugging Face.

## Recommended V1 Integration

- Search and describe models with Hugging Face Hub metadata APIs.
- Download models with `hf download --local-dir <model-root>/huggingface/<namespace>/<model>`.
- Use `--revision` when a specific branch, tag, PR ref, or commit is selected.
- Use `--include` and `--exclude` later for quantization/format-specific downloads.
- Use `--dry-run` for size/changed-file preview only; the product behavior remains direct in-app
  download after the user clicks Download.
- Keep authentication in server-managed secrets/environment. Do not persist raw tokens in model
  metadata, logs, docs, or client-side state.

## Storage

Hugging Face's default cache is useful, but the hub needs a user-selected root that is easy to move,
back up, mount into containers, and reproduce on another machine. Prefer `--local-dir` under the hub
root for user-visible model stores:

```text
models/
  huggingface/
    Qwen/
      Qwen3-4B-AWQ/
        .cache/huggingface/
        config.json
        tokenizer.json
        model-*.safetensors
```

The `.cache/huggingface/` metadata under the local directory lets repeat downloads skip files that
are already current.

## Metadata

Normalize whatever the Hub exposes into the shared hub metadata shape:

- repo ID, revision, sha/digest when known
- tags, pipeline/task, library, license
- downloads, likes, last modified
- file list and total size
- quantization hints from file names/config where available
- architecture, parameter count, context hints, tokenizer/template files when available
- gated/private/access status

Missing metadata is normal. Store unknowns explicitly rather than guessing.

## Failure Handling

Hugging Face failures should include:

- repo ID and revision
- whether the action was search, describe, dry-run, or download
- command/API detail from the underlying tool
- access/gating hints when the error indicates auth or license acceptance
- target local directory for download failures

## References

- HfApi client: <https://huggingface.co/docs/huggingface_hub/package_reference/hf_api>
- Download guide: <https://huggingface.co/docs/huggingface_hub/guides/download>
- CLI guide: <https://huggingface.co/docs/huggingface_hub/guides/cli>
- Cache guide: <https://huggingface.co/docs/huggingface_hub/guides/manage-cache>
