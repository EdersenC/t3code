# Hugging Face

Hugging Face is the first file-based source for the Local Model Hub. Treat it as a model-source
adapter, not as a runtime. vLLM, llama.cpp, SGLang, and other runtimes can later consume models that
were downloaded from Hugging Face.

## Recommended V1 Integration

- Search and describe models with Hugging Face Hub metadata APIs.
- Download model files by streaming Hub `resolve` URLs into
  `<model-root>/huggingface/<namespace>/<model>`.
- Use the selected revision when a specific branch, tag, PR ref, or commit is selected.
- Offer include/exclude download profiles for common artifact sets: whole repo, safetensors,
  GGUF, 4-bit, 8-bit, and 16-bit/BF16-style files.
- Use metadata-based preview later for size/changed-file estimates only; the product behavior remains
  direct in-app download after the user clicks Download.
- Do not require the `hf` executable for normal downloads; it can be missing, non-executable, or
  different in app-bundled environments.
- Keep authentication in server-managed secrets/environment. Do not persist raw tokens in model
  metadata, logs, docs, or client-side state.

## Storage

Hugging Face's default cache is useful, but the hub needs a user-selected root that is easy to move,
back up, mount into containers, and reproduce on another machine. Keep files under the hub root for
user-visible model stores:

```text
models/
  huggingface/
    Qwen/
      Qwen3-4B-AWQ/
        config.json
        tokenizer.json
        model-*.safetensors
```

Repeat downloads should skip files that already match the metadata-reported size when that size is
available.

## Artifact Choice

The right download depends on the next task:

- **Whole repo** is safest for reproducibility and post-training because it preserves configs,
  tokenizer files, templates, generation config, docs, and all published weight artifacts.
- **Safetensors + configs/tokenizer** is usually enough for Transformers/vLLM inference and many
  fine-tuning flows when the selected repo stores the trainable weights in safetensors.
- **GGUF** is for llama.cpp-style inference. It is convenient and compact, but it is not the normal
  starting point for continued pretraining or LoRA/QLoRA fine-tuning in Transformers.
- **4-bit/8-bit quantized artifacts** are mainly for inference or quantization-aware workflows.
  They are often not what you want if the goal is high-quality post-training.
- **16-bit/BF16/FP16 artifacts** are the most useful weight precision for serious fine-tuning when
  the hardware can handle them.

Quant-specific downloads should still include tokenizer/config files. A weight shard by itself is
rarely enough to load a model correctly.

## Metadata

Normalize whatever the Hub exposes into the shared hub metadata shape:

- repo ID, revision, sha/digest when known
- tags, pipeline/task, library, license
- downloads, likes, last modified
- file list and total size
- quantization hints from file names/config where available
- parameter count from safetensors metadata when available
- architecture, parameter count, context hints, tokenizer/template files when available
- gated/private/access status

Missing metadata is normal. Store unknowns explicitly rather than guessing.

## Failure Handling

Hugging Face failures should include:

- repo ID and revision
- whether the action was search, describe, dry-run, or download
- HTTP/API detail from the underlying source
- access/gating hints when the error indicates auth or license acceptance
- target local directory for download failures

## References

- HfApi client: <https://huggingface.co/docs/huggingface_hub/package_reference/hf_api>
- Download guide: <https://huggingface.co/docs/huggingface_hub/guides/download>
- Cache guide: <https://huggingface.co/docs/huggingface_hub/guides/manage-cache>
