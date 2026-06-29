import {
  DEFAULT_LOCAL_CONTEXT_WINDOW,
  DEFAULT_LOCAL_MODEL,
  DEFAULT_LOCAL_MODELS,
  DEFAULT_LOCAL_OUTPUT_TOKEN_LIMIT,
  type LocalSettings,
  type ThreadTokenUsageSnapshot,
} from "@t3tools/contracts";

export const LOCAL_OPENCODE_PROVIDER_ID = "local-vllm";
export const LOCAL_OPENCODE_PROVIDER_NAME = "Local vLLM";
export const LOCAL_OPENAI_COMPATIBLE_PACKAGE = "@ai-sdk/openai-compatible";
export const DEFAULT_LOCAL_VLLM_BASE_URL = "http://127.0.0.1:8018";
const ESTIMATED_TOKENS_PER_IMAGE = 1024;

type LocalOpenCodeLimitSettings = Partial<
  Pick<LocalSettings, "contextWindow" | "outputTokenLimit">
>;

export interface LocalOpenCodeModelLimits {
  readonly context: number;
  readonly output: number;
}

export function normalizeLocalModelId(model: string | null | undefined): string | null {
  if (typeof model !== "string") return null;
  const trimmed = model.trim();
  if (trimmed.length === 0) return null;
  const prefixed = LOCAL_OPENCODE_PROVIDER_ID + "/";
  return trimmed.startsWith(prefixed) ? trimmed.slice(prefixed.length).trim() || null : trimmed;
}

export function toLocalOpenCodeModelSlug(modelId: string | null | undefined): string | null {
  const normalized = normalizeLocalModelId(modelId);
  return normalized ? LOCAL_OPENCODE_PROVIDER_ID + "/" + normalized : null;
}

export function localModelIdsFromCandidates(
  candidates: ReadonlyArray<string | null | undefined>,
): ReadonlyArray<string> {
  const seen = new Set<string>();
  const modelIds: Array<string> = [];
  for (const candidate of candidates) {
    const modelId = normalizeLocalModelId(candidate);
    if (!modelId || seen.has(modelId)) continue;
    seen.add(modelId);
    modelIds.push(modelId);
  }
  return modelIds;
}

export function localModelIdsForConfig(input: {
  readonly settings: Pick<LocalSettings, "customModels">;
  readonly discoveredModels?: ReadonlyArray<string> | undefined;
}): ReadonlyArray<string> {
  const discoveredAndCustomModels = localModelIdsFromCandidates([
    ...(input.discoveredModels ?? []),
    ...input.settings.customModels,
  ]);
  if (discoveredAndCustomModels.length > 0) return discoveredAndCustomModels;

  const defaultModels = localModelIdsFromCandidates(DEFAULT_LOCAL_MODELS);
  return defaultModels.length > 0 ? defaultModels : [normalizeLocalModelId(DEFAULT_LOCAL_MODEL)!];
}

export function normalizeLocalVllmBaseUrl(baseUrl: string | null | undefined): string {
  const raw = baseUrl?.trim() || DEFAULT_LOCAL_VLLM_BASE_URL;
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//iu.test(raw) ? raw : "http://" + raw;
  try {
    const url = new URL(withProtocol);
    url.hash = "";
    url.search = "";

    const pathname = url.pathname.replace(/\/+$/u, "");
    if (pathname === "/v1" || pathname.endsWith("/v1")) {
      url.pathname = pathname.slice(0, -"/v1".length) || "/";
    } else if (pathname === "/api" || pathname.endsWith("/api")) {
      url.pathname = pathname.slice(0, -"/api".length) || "/";
    }

    return url.toString().replace(/\/+$/u, "");
  } catch {
    return DEFAULT_LOCAL_VLLM_BASE_URL;
  }
}

export function normalizeLocalOpenAiCompatibleBaseUrl(baseUrl: string | null | undefined): string {
  return normalizeLocalVllmBaseUrl(baseUrl) + "/v1";
}

function finitePositiveInteger(value: number | null | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : fallback;
}

export function resolveLocalOpenCodeModelLimits(
  settings: LocalOpenCodeLimitSettings,
): LocalOpenCodeModelLimits {
  const context = finitePositiveInteger(settings.contextWindow, DEFAULT_LOCAL_CONTEXT_WINDOW);
  const requestedOutput = finitePositiveInteger(
    settings.outputTokenLimit,
    DEFAULT_LOCAL_OUTPUT_TOKEN_LIMIT,
  );
  return {
    context,
    output: Math.min(requestedOutput, context),
  };
}

function estimateTextTokens(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  return Math.max(1, Math.ceil(trimmed.length / 4));
}

export function makeLocalTokenUsageSnapshot(input: {
  readonly inputText: string;
  readonly assistantText: string;
  readonly attachmentCount: number;
  readonly contextWindow?: number | null | undefined;
}): ThreadTokenUsageSnapshot | undefined {
  const inputTokens =
    estimateTextTokens(input.inputText) +
    Math.max(0, input.attachmentCount) * ESTIMATED_TOKENS_PER_IMAGE;
  const outputTokens = estimateTextTokens(input.assistantText);
  const activeTokens = inputTokens + outputTokens;
  if (activeTokens <= 0) return undefined;

  const maxTokens =
    typeof input.contextWindow === "number" &&
    Number.isFinite(input.contextWindow) &&
    input.contextWindow > 0
      ? Math.round(input.contextWindow)
      : DEFAULT_LOCAL_CONTEXT_WINDOW;
  const usedTokens = Math.min(activeTokens, maxTokens);

  return {
    usedTokens,
    totalProcessedTokens: activeTokens,
    maxTokens,
    inputTokens,
    outputTokens,
    lastUsedTokens: usedTokens,
    lastInputTokens: inputTokens,
    lastOutputTokens: outputTokens,
    compactsAutomatically: false,
  };
}

export function formatLocalOpenCodeFailureDetail(input: {
  readonly detail: string;
  readonly model?: string | null | undefined;
  readonly baseUrl?: string | null | undefined;
  readonly emptyOutput?: boolean | undefined;
}): string {
  const detail = input.detail.trim() || "The provider did not return an error message.";
  const modelId = normalizeLocalModelId(input.model) ?? "the selected model";
  const baseUrl = normalizeLocalVllmBaseUrl(input.baseUrl);
  const lower = detail.toLowerCase();

  if (
    lower.includes("econnrefused") ||
    lower.includes("connection refused") ||
    lower.includes("fetch failed") ||
    lower.includes("failed to fetch") ||
    lower.includes("network error")
  ) {
    return (
      "Could not reach the local vLLM server at " +
      baseUrl +
      ". Start vLLM, check the Local provider base URL, then retry. Details: " +
      detail
    );
  }

  if (
    lower.includes("model") &&
    (lower.includes("not found") || lower.includes("404") || lower.includes("not served"))
  ) {
    return (
      "vLLM is not serving model '" +
      modelId +
      "'. Start vLLM with that Hugging Face model or choose the model currently served by the Local endpoint. Details: " +
      detail
    );
  }

  if (
    lower.includes("timed out") ||
    lower.includes("timeout") ||
    lower.includes("aborterror") ||
    lower.includes("timeouterror")
  ) {
    return (
      "Local vLLM model '" +
      modelId +
      "' did not answer before the request timed out. Try a smaller model, lower context, or retry after vLLM finishes loading. Details: " +
      detail
    );
  }

  if (
    lower.includes("no available gpu") ||
    lower.includes("gpu memory") ||
    lower.includes("vram") ||
    lower.includes("cuda out of memory") ||
    lower.includes("outofmemoryerror")
  ) {
    return (
      "Local vLLM could not keep model '" +
      modelId +
      "' on the GPU. Free GPU memory, lower vLLM GPU utilization/context, or use a smaller/quantized model. Details: " +
      detail
    );
  }

  if (
    lower.includes("out of memory") ||
    lower.includes("cuda") ||
    lower.includes("failed to load") ||
    lower.includes("load model")
  ) {
    return (
      "Local vLLM failed while loading or running model '" +
      modelId +
      "'. Check the vLLM server log, free local memory/GPU resources, or use a smaller/quantized model. Details: " +
      detail
    );
  }

  if (
    lower.includes("auto") &&
    lower.includes("tool choice") &&
    lower.includes("enable-auto-tool-choice") &&
    lower.includes("tool-call-parser")
  ) {
    return (
      "Local vLLM model '" +
      modelId +
      "' received OpenCode tool calls, but the vLLM server was not started with tool-call support. Restart vLLM with --enable-auto-tool-choice and --tool-call-parser qwen3_xml for Qwen3 models. Details: " +
      detail
    );
  }

  if (
    lower.includes("max_tokens") &&
    (lower.includes("max_model_len") || lower.includes("max_total_tokens"))
  ) {
    return (
      "Local vLLM model '" +
      modelId +
      "' was asked for more output tokens than the running vLLM server allows. Lower the Local provider output token limit or restart vLLM with a larger --max-model-len. Details: " +
      detail
    );
  }

  if (
    lower.includes("maximum context length") &&
    lower.includes("requested") &&
    lower.includes("output tokens") &&
    lower.includes("prompt contains")
  ) {
    return (
      "Local vLLM model '" +
      modelId +
      "' ran out of context after OpenCode added its prompt and tool instructions. Lower the Local provider output token limit, start vLLM with a larger --max-model-len, or use a shorter/new thread. Details: " +
      detail
    );
  }

  if (
    lower.includes("tool") &&
    (lower.includes("not support") || lower.includes("unsupported") || lower.includes("invalid"))
  ) {
    return (
      "Local vLLM model '" +
      modelId +
      "' could not handle the OpenCode tool-call request. Restart vLLM with a matching --tool-call-parser for the served model, or choose a model/parser combination with tool-call support. Details: " +
      detail
    );
  }

  if (input.emptyOutput) {
    return (
      "Local vLLM model '" +
      modelId +
      "' answered with no text. Try again or choose a different served model. Details: " +
      detail
    );
  }

  return "Local vLLM model '" + modelId + "' failed while answering. Details: " + detail;
}

export function buildLocalOpenCodeConfig(input: {
  readonly settings: Pick<LocalSettings, "baseUrl" | "customModels"> & LocalOpenCodeLimitSettings;
  readonly modelIds: ReadonlyArray<string>;
}): string {
  const modelIds =
    input.modelIds.length > 0
      ? input.modelIds
      : localModelIdsForConfig({ settings: input.settings });
  const limit = resolveLocalOpenCodeModelLimits(input.settings);
  const models = Object.fromEntries(
    modelIds.map((modelId) => [
      modelId,
      {
        name: modelId,
        limit,
      },
    ]),
  );
  const defaultModelSlug = toLocalOpenCodeModelSlug(modelIds[0] ?? DEFAULT_LOCAL_MODEL);

  return JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    ...(defaultModelSlug ? { model: defaultModelSlug } : {}),
    provider: {
      [LOCAL_OPENCODE_PROVIDER_ID]: {
        npm: LOCAL_OPENAI_COMPATIBLE_PACKAGE,
        name: LOCAL_OPENCODE_PROVIDER_NAME,
        options: {
          baseURL: normalizeLocalOpenAiCompatibleBaseUrl(input.settings.baseUrl),
        },
        models,
      },
    },
  });
}
