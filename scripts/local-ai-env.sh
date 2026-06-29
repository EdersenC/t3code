#!/usr/bin/env bash
# Source this file before running local model servers so model and compiler
# caches stay in the configured AI cache instead of the default home directory.

local_ai_env_fail() {
  echo "local-ai-env: $*" >&2
}

if [[ -z "${AI_CACHE:-}" ]]; then
  if [[ -d /mnt/s && -w /mnt/s ]]; then
    export AI_CACHE="/mnt/s/ai-cache"
  else
    export AI_CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/t3code/ai"
  fi
else
  export AI_CACHE
fi

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

for local_ai_env_dir in \
  "$HF_HOME" \
  "$HF_HUB_CACHE" \
  "$HF_DATASETS_CACHE" \
  "$VLLM_CACHE_ROOT" \
  "$T3CODE_VLLM_VENV_ROOT" \
  "$TORCH_HOME" \
  "$TRITON_CACHE_DIR" \
  "$TMPDIR"; do
  if ! mkdir -p "$local_ai_env_dir"; then
    local_ai_env_fail "failed to create directory: $local_ai_env_dir"
    return 1 2>/dev/null || exit 1
  fi
done

if [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
  export PATH="$HOME/.local/bin:$PATH"
fi

if [[ -d "$T3CODE_VLLM_VENV_PATH/bin" && ":$PATH:" != *":$T3CODE_VLLM_VENV_PATH/bin:"* ]]; then
  export PATH="$T3CODE_VLLM_VENV_PATH/bin:$PATH"
fi

if [[ -z "${CUDA_HOME:-}" ]]; then
  for cuda_home in "$T3CODE_VLLM_VENV_PATH"/lib/python*/site-packages/nvidia/cu*; do
    if [[ -x "$cuda_home/bin/nvcc" ]]; then
      export CUDA_HOME="$cuda_home"
      export CUDA_PATH="$CUDA_HOME"
      break
    fi
  done
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

unset local_ai_env_dir cuda_home
unset -f local_ai_env_fail
