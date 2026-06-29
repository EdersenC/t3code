#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"

source "$REPO_ROOT/scripts/local-ai-env.sh"

MODEL="${T3CODE_VLLM_SMOKE_MODEL:-${VLLM_SMOKE_MODEL:-Qwen/Qwen2.5-Coder-0.5B-Instruct}}"
PORT="${T3CODE_VLLM_SMOKE_PORT:-${VLLM_SMOKE_PORT:-8018}}"
MAX_MODEL_LEN="${T3CODE_VLLM_SMOKE_MAX_MODEL_LEN:-${VLLM_SMOKE_MAX_MODEL_LEN:-1024}}"
GPU_MEMORY_UTILIZATION="${T3CODE_VLLM_SMOKE_GPU_MEMORY_UTILIZATION:-${VLLM_SMOKE_GPU_MEMORY_UTILIZATION:-0.60}}"
TIMEOUT_SECONDS="${T3CODE_VLLM_SMOKE_TIMEOUT_SECONDS:-${VLLM_SMOKE_TIMEOUT_SECONDS:-180}}"
LOG="${T3CODE_VLLM_SMOKE_LOG:-${VLLM_SMOKE_LOG:-$VLLM_CACHE_ROOT/smoke.log}}"
EXTRA_ARGS="--enforce-eager"
if [[ -v VLLM_SMOKE_EXTRA_ARGS ]]; then
  EXTRA_ARGS="$VLLM_SMOKE_EXTRA_ARGS"
fi
if [[ -v T3CODE_VLLM_SMOKE_EXTRA_ARGS ]]; then
  EXTRA_ARGS="$T3CODE_VLLM_SMOKE_EXTRA_ARGS"
fi
export VLLM_USE_FLASHINFER_SAMPLER="${VLLM_USE_FLASHINFER_SAMPLER:-0}"

rm -f "$LOG"

read -r -a EXTRA_ARGV <<<"$EXTRA_ARGS"

if [[ ! -x "$T3CODE_VLLM_VENV_PATH/bin/python" ]]; then
  echo "vLLM Python runtime not found at $T3CODE_VLLM_VENV_PATH/bin/python." >&2
  echo "Run: source scripts/local-ai-env.sh && uv venv \"\$T3CODE_VLLM_VENV_PATH\" --python 3.12 && uv pip install --python \"\$T3CODE_VLLM_VENV_PATH/bin/python\" vllm" >&2
  exit 127
fi

setsid "$T3CODE_VLLM_VENV_PATH/bin/python" -m vllm.entrypoints.openai.api_server \
  --model "$MODEL" \
  --host 127.0.0.1 \
  --port "$PORT" \
  --dtype auto \
  --max-model-len "$MAX_MODEL_LEN" \
  --gpu-memory-utilization "$GPU_MEMORY_UTILIZATION" \
  "${EXTRA_ARGV[@]}" \
  >"$LOG" 2>&1 &
SERVER_PID=$!

cleanup() {
  kill -TERM "-$SERVER_PID" >/dev/null 2>&1 || kill "$SERVER_PID" >/dev/null 2>&1 || true
  sleep 1
  kill -KILL "-$SERVER_PID" >/dev/null 2>&1 || kill -KILL "$SERVER_PID" >/dev/null 2>&1 || true
}
trap cleanup EXIT

deadline=$((SECONDS + TIMEOUT_SECONDS))
while ((SECONDS < deadline)); do
  if curl -fsS "http://127.0.0.1:$PORT/v1/models" >/tmp/t3code-vllm-models.json 2>/tmp/t3code-vllm-curl.err; then
    echo "vLLM server ready on port $PORT"
    cat /tmp/t3code-vllm-models.json
    echo
    curl -fsS "http://127.0.0.1:$PORT/v1/chat/completions" \
      -H "Content-Type: application/json" \
      -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"Say hello from local vLLM in one short sentence.\"}],\"max_tokens\":24}"
    echo
    exit 0
  fi

  if ! kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    echo "vLLM server exited before becoming ready. Log tail:" >&2
    tail -n 160 "$LOG" >&2 || true
    exit 1
  fi

  sleep 5
done

echo "vLLM server was not ready after ${TIMEOUT_SECONDS}s. Log tail:" >&2
tail -n 160 "$LOG" >&2 || true
exit 124
