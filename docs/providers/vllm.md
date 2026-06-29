# vLLM

vLLM is the first local model server target for T3 Code's owned-model provider. It should be treated
as a local OpenAI-compatible endpoint: vLLM runs the model process, and T3 Code/OpenCode talk to its
`/v1` API.

## Local Runtime Setup

Source the repo helper before installing or running vLLM:

```bash
source scripts/local-ai-env.sh
```

The helper keeps large model and compiler caches on the S: drive:

```bash
AI_CACHE=/mnt/s/ai-cache
HF_HOME=$AI_CACHE/huggingface
HF_HUB_CACHE=$HF_HOME/hub
HF_DATASETS_CACHE=$HF_HOME/datasets
VLLM_CACHE_ROOT=$AI_CACHE/vllm
TORCH_HOME=$AI_CACHE/torch
TRITON_CACHE_DIR=$AI_CACHE/triton
T3CODE_AI_RUNTIME_DIR=/tmp/t3code-ai-$USER
TMPDIR=$T3CODE_AI_RUNTIME_DIR/tmp
UV_LINK_MODE=copy
```

Keep model/cache storage configurable, but keep runtime sockets and temporary IPC files on a Linux
filesystem. In WSL, `TMP` and `TEMP` may point at Windows paths under `/mnt/c/.../Temp`; vLLM's ZMQ
IPC sockets can fail there with `Operation not supported`.

## Install Shape

Use `uv` with Python 3.12:

```bash
source scripts/local-ai-env.sh
uv venv "$VLLM_CACHE_ROOT/venv" --python 3.12
uv pip install --python "$VLLM_CACHE_ROOT/venv/bin/python" vllm
```

If `uv` is installed but not found, source the helper first or call it directly from
`$HOME/.local/bin/uv`.

## First Smoke Model

Start with a small Hugging Face model so a 12 GB local GPU has room for runtime overhead:

```bash
source scripts/local-ai-env.sh
scripts/local-vllm-smoke.sh
```

The smoke script defaults to:

```bash
VLLM_SMOKE_MODEL=Qwen/Qwen2.5-Coder-0.5B-Instruct
VLLM_SMOKE_PORT=8018
VLLM_SMOKE_MAX_MODEL_LEN=2048
VLLM_SMOKE_GPU_MEMORY_UTILIZATION=0.75
VLLM_SMOKE_TIMEOUT_SECONDS=180
```

Use a shorter timeout while iterating. If a model is still downloading or compiling, rerun the script
after confirming the log is making progress instead of waiting blindly.

## Current Machine Findings

Observed on WSL with an RTX 5070:

- `uv` is installed at `/home/eddy/.local/bin/uv`; `scripts/local-ai-env.sh` puts it on `PATH`.
- `vllm==0.23.0` and `torch==2.11.0+cu130` installed into `/mnt/s/ai-cache/vllm/venv`.
- `torch.cuda.is_available()` is true and sees `NVIDIA GeForce RTX 5070`.
- First `vllm` import from the S: drive venv took about 39 seconds; if startup remains painful,
  consider keeping the Python venv on WSL ext4 while leaving model/cache storage on S:.
- A smoke run failed when `TMP`/`TEMP` pointed at `/mnt/c/.../Temp`; vLLM ZMQ IPC sockets need a
  Linux filesystem temp path.
- A later smoke run passed the temp issue but failed with default GPU memory utilization because
  vLLM requested 10.98 GiB while only 10.67 GiB was free.
- A low-memory run with `--gpu-memory-utilization 0.75` and `--max-model-len 2048` did not become
  ready within the 180 second iteration budget; inspect the log before deciding whether to wait
  longer or move the venv to WSL ext4.
- During short timeout testing, a vLLM process briefly entered uninterruptible sleep while starting
  from the S: drive venv. Prefer bounded probes, explicit process cleanup, and consider keeping the
  Python environment on WSL ext4 while keeping model artifacts and Hugging Face caches on S:.

## Provider Direction

The T3 provider should be named `Local` unless product direction changes. The first implementation
can use OpenCode's OpenAI-compatible provider config against `http://127.0.0.1:8000/v1`.

Model source tags should be separate from runtime tags:

- Runtime: `vLLM`
- Source: `Hugging Face`, `Local Path`, or another model-store/source label

This lets the UI say "Local / vLLM / Hugging Face" without hiding the actual model ID that OpenCode
needs to route requests.

## Local Model Hub Direction

The vLLM work should become a reproducible local-model hub, not a one-machine script. Before building
the hub UI or provider management workflow, pause and ask the user product questions about structure,
storage, and operations.

The hub should eventually support:

- choosing model/cache locations per machine
- downloading models from Hugging Face or registering existing local paths
- showing where each model lives and how much disk it uses
- starting, stopping, and health-checking vLLM servers
- showing GPU/VRAM suitability before launch
- tagging models by runtime (`vLLM`) and source (`Hugging Face`, `Local Path`, future sources)
- maintenance actions such as prune cache, redownload, refresh metadata, and verify files
- exporting/importing enough configuration to reproduce the setup on another machine
- a future Docker/container runtime without changing the provider UX

Question checkpoint before hub implementation:

- Should the settings surface be a provider tab, a dedicated Local Models tab, or both?
- Should one vLLM server run one selected model, or should T3 manage multiple server instances?
- Should downloads be initiated by T3 directly, by generated shell commands, or both?
- Which model metadata matters first: source, license, size, quantization, context, tool support,
  reasoning support, VRAM estimate, local path?
- What should be portable config versus machine-local config?
- How aggressive should T3 be about automatic cleanup and cache pruning?

## References

- vLLM quickstart: <https://docs.vllm.ai/en/latest/getting_started/quickstart.html>
- vLLM OpenAI-compatible server: <https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html>
- vLLM environment variables: <https://docs.vllm.ai/en/latest/configuration/env_vars.html>
- Hugging Face cache variables: <https://huggingface.co/docs/huggingface_hub/package_reference/environment_variables>
