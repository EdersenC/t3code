#!/usr/bin/env bash
# Source this file before running local model servers so model and compiler
# caches stay on the large S: drive instead of the default home directory.

export AI_CACHE="${AI_CACHE:-/mnt/s/ai-cache}"

export HF_HOME="${HF_HOME:-$AI_CACHE/huggingface}"
export HF_HUB_CACHE="${HF_HUB_CACHE:-$HF_HOME/hub}"
export HF_DATASETS_CACHE="${HF_DATASETS_CACHE:-$HF_HOME/datasets}"

export VLLM_CACHE_ROOT="${VLLM_CACHE_ROOT:-$AI_CACHE/vllm}"
export T3CODE_VLLM_VENV_ROOT="${T3CODE_VLLM_VENV_ROOT:-$HOME/.local/share/t3code/vllm}"
export T3CODE_VLLM_VENV_PATH="${T3CODE_VLLM_VENV_PATH:-$T3CODE_VLLM_VENV_ROOT/venv}"

export TORCH_HOME="${TORCH_HOME:-$AI_CACHE/torch}"
export TRITON_CACHE_DIR="${TRITON_CACHE_DIR:-$AI_CACHE/triton}"
export T3CODE_AI_RUNTIME_DIR="${T3CODE_AI_RUNTIME_DIR:-/tmp/t3code-ai-${USER:-user}}"
export UV_LINK_MODE="${UV_LINK_MODE:-copy}"

if [[ -z "${TMPDIR:-}" || "${TMPDIR:-}" == /mnt/* ]]; then
  export TMPDIR="$T3CODE_AI_RUNTIME_DIR/tmp"
fi

if [[ -z "${TMP:-}" || "${TMP:-}" == /mnt/* ]]; then
  export TMP="$TMPDIR"
fi

if [[ -z "${TEMP:-}" || "${TEMP:-}" == /mnt/* ]]; then
  export TEMP="$TMPDIR"
fi

mkdir -p \
  "$HF_HOME" \
  "$HF_HUB_CACHE" \
  "$HF_DATASETS_CACHE" \
  "$VLLM_CACHE_ROOT" \
  "$T3CODE_VLLM_VENV_ROOT" \
  "$TORCH_HOME" \
  "$TRITON_CACHE_DIR" \
  "$TMPDIR"

if [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
  export PATH="$HOME/.local/bin:$PATH"
fi

if [[ -d "$T3CODE_VLLM_VENV_PATH/bin" && ":$PATH:" != *":$T3CODE_VLLM_VENV_PATH/bin:"* ]]; then
  export PATH="$T3CODE_VLLM_VENV_PATH/bin:$PATH"
fi

T3CODE_VLLM_BUNDLED_CUDA_HOME="$T3CODE_VLLM_VENV_PATH/lib/python3.12/site-packages/nvidia/cu13"
if [[ -z "${CUDA_HOME:-}" && -x "$T3CODE_VLLM_BUNDLED_CUDA_HOME/bin/nvcc" ]]; then
  export CUDA_HOME="$T3CODE_VLLM_BUNDLED_CUDA_HOME"
  export CUDA_PATH="$CUDA_HOME"
fi

if [[ -n "${CUDA_HOME:-}" && -d "$CUDA_HOME/bin" && ":$PATH:" != *":$CUDA_HOME/bin:"* ]]; then
  export PATH="$CUDA_HOME/bin:$PATH"
fi

if [[ -n "${CUDA_HOME:-}" && -d "$CUDA_HOME/lib64" ]]; then
  case ":${LD_LIBRARY_PATH:-}:" in
    *":$CUDA_HOME/lib64:"*) ;;
    *) export LD_LIBRARY_PATH="$CUDA_HOME/lib64${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" ;;
  esac
fi
