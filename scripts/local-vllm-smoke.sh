#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"

source "$REPO_ROOT/scripts/local-ai-env.sh"

MODEL="${VLLM_SMOKE_MODEL:-Qwen/Qwen2.5-Coder-0.5B-Instruct}"
PORT="${VLLM_SMOKE_PORT:-8018}"
MAX_MODEL_LEN="${VLLM_SMOKE_MAX_MODEL_LEN:-2048}"
GPU_MEMORY_UTILIZATION="${VLLM_SMOKE_GPU_MEMORY_UTILIZATION:-0.75}"
TIMEOUT_SECONDS="${VLLM_SMOKE_TIMEOUT_SECONDS:-180}"
LOG="${VLLM_SMOKE_LOG:-$VLLM_CACHE_ROOT/smoke.log}"

rm -f "$LOG"

setsid "$VLLM_CACHE_ROOT/venv/bin/python" -m vllm.entrypoints.openai.api_server \
  --model "$MODEL" \
  --host 127.0.0.1 \
  --port "$PORT" \
  --dtype auto \
  --max-model-len "$MAX_MODEL_LEN" \
  --gpu-memory-utilization "$GPU_MEMORY_UTILIZATION" \
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
