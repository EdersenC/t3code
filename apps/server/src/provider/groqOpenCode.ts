import { DEFAULT_GROQ_MODEL, type GroqSettings } from "@t3tools/contracts";

import { normalizeGroqBaseUrl, resolveGroqApiKey, type GroqModel } from "./groqApi.ts";

export const GROQ_OPENCODE_PROVIDER_ID = "groq";
export const GROQ_OPENCODE_PROVIDER_NAME = "Groq";
export const GROQ_AI_SDK_PACKAGE = "@ai-sdk/groq";

const DEFAULT_GROQ_MODEL_IDS = [
  "meta-llama/llama-4-scout-17b-16e-instruct",
  "llama-3.3-70b-versatile",
  "llama-3.1-8b-instant",
  "openai/gpt-oss-120b",
  "openai/gpt-oss-20b",
] as const;

type GroqOpenCodeModelLimit = {
  readonly context: number;
  readonly output: number;
};

const DEFAULT_GROQ_MODEL_LIMIT: GroqOpenCodeModelLimit = {
  context: 131_072,
  output: 256,
};

const GROQ_OPEN_CODE_OUTPUT_TOKEN_CAP = 256;

const GROQ_OPEN_CODE_MODEL_METADATA: Record<
  string,
  {
    readonly name?: string | undefined;
    readonly family?: string | undefined;
    readonly reasoning?: boolean | undefined;
    readonly tool_call?: boolean | undefined;
    readonly structured_output?: boolean | undefined;
    readonly limit?: GroqOpenCodeModelLimit | undefined;
    readonly open_weights?: boolean | undefined;
  }
> = {
  "allam-2-7b": {
    family: "allam",
    tool_call: false,
    limit: { context: 4_096, output: 256 },
    open_weights: false,
  },
  "llama-3.1-8b-instant": {
    name: "Llama 3.1 8B Instant",
    family: "llama",
    tool_call: true,
    limit: { context: 131_072, output: 256 },
    open_weights: true,
  },
  "llama-3.3-70b-versatile": {
    name: "Llama 3.3 70B Versatile",
    family: "llama",
    tool_call: true,
    limit: { context: 131_072, output: 256 },
    open_weights: true,
  },
  "meta-llama/llama-4-scout-17b-16e-instruct": {
    name: "Llama 4 Scout 17B Instruct",
    family: "llama",
    tool_call: true,
    limit: { context: 131_072, output: 256 },
    open_weights: true,
  },
  "openai/gpt-oss-120b": {
    name: "GPT OSS 120B",
    family: "gpt-oss",
    reasoning: true,
    tool_call: true,
    structured_output: true,
    limit: { context: 131_072, output: 256 },
    open_weights: true,
  },
  "openai/gpt-oss-20b": {
    name: "GPT OSS 20B",
    family: "gpt-oss",
    reasoning: true,
    tool_call: true,
    structured_output: true,
    limit: { context: 131_072, output: 256 },
    open_weights: true,
  },
  "qwen/qwen3-32b": {
    name: "Qwen3 32B",
    family: "qwen",
    reasoning: true,
    tool_call: true,
    limit: { context: 131_072, output: 256 },
    open_weights: true,
  },
  "qwen/qwen3.6-27b": {
    name: "Qwen3.6 27B",
    family: "qwen",
    reasoning: true,
    tool_call: true,
    structured_output: true,
    limit: { context: 131_072, output: 256 },
    open_weights: true,
  },
  "whisper-large-v3": {
    name: "Whisper Large V3",
    family: "whisper",
    tool_call: false,
    limit: { context: 4_096, output: 256 },
    open_weights: true,
  },
  "whisper-large-v3-turbo": {
    name: "Whisper Large V3 Turbo",
    family: "whisper",
    tool_call: false,
    limit: { context: 4_096, output: 256 },
    open_weights: true,
  },
};

export function normalizeGroqModelId(model: string | null | undefined): string | null {
  if (typeof model !== "string") return null;
  const trimmed = model.trim();
  if (trimmed.length === 0) return null;
  const prefixed = GROQ_OPENCODE_PROVIDER_ID + "/";
  return trimmed.startsWith(prefixed) ? trimmed.slice(prefixed.length).trim() || null : trimmed;
}

export function toGroqOpenCodeModelSlug(modelId: string | null | undefined): string | null {
  const normalized = normalizeGroqModelId(modelId);
  return normalized ? GROQ_OPENCODE_PROVIDER_ID + "/" + normalized : null;
}

export function groqModelIdsFromCandidates(
  candidates: ReadonlyArray<string | GroqModel | null | undefined>,
): ReadonlyArray<string> {
  const seen = new Set<string>();
  const modelIds: Array<string> = [];
  for (const candidate of candidates) {
    const modelId = normalizeGroqModelId(
      typeof candidate === "object" && candidate !== null ? candidate.id : candidate,
    );
    if (!modelId || seen.has(modelId)) continue;
    seen.add(modelId);
    modelIds.push(modelId);
  }
  return modelIds;
}

function lowerSet(values: ReadonlyArray<string> | undefined): ReadonlySet<string> | undefined {
  if (!values) return undefined;
  return new Set(values.map((value) => value.toLowerCase()));
}

function hasGroqFeature(model: GroqModel, feature: string): boolean | undefined {
  return lowerSet(model.supportedFeatures)?.has(feature.toLowerCase());
}

function hasTextModality(values: ReadonlyArray<string> | undefined): boolean {
  return !values || values.some((value) => value.toLowerCase() === "text");
}

function isKnownGroqOpenCodeNonAgentModel(modelId: string | null | undefined): boolean {
  const normalized = normalizeGroqModelId(modelId);
  return normalized ? GROQ_OPEN_CODE_MODEL_METADATA[normalized]?.tool_call === false : false;
}

export function isGroqOpenCodeConfiguredModel(
  model: string | GroqModel | null | undefined,
): boolean {
  const modelId = normalizeGroqModelId(
    typeof model === "object" && model !== null ? model.id : model,
  );
  return Boolean(modelId) && !isKnownGroqOpenCodeNonAgentModel(modelId);
}

export function groqModelIdsForConfig(input: {
  readonly settings: Pick<GroqSettings, "customModels">;
  readonly discoveredModels?: ReadonlyArray<string | GroqModel> | undefined;
}): ReadonlyArray<string> {
  const modelIds = groqModelIdsFromCandidates([
    ...(input.discoveredModels ?? []).filter((model) => isGroqOpenCodeDiscoveredModel(model)),
    ...input.settings.customModels.filter((model) => isGroqOpenCodeConfiguredModel(model)),
    ...DEFAULT_GROQ_MODEL_IDS,
    DEFAULT_GROQ_MODEL,
  ]);
  return modelIds.length > 0 ? modelIds : [normalizeGroqModelId(DEFAULT_GROQ_MODEL)!];
}

export function isGroqOpenCodeAgentModel(modelId: string | null | undefined): boolean {
  const normalized = normalizeGroqModelId(modelId);
  if (!normalized) return false;
  const metadata = GROQ_OPEN_CODE_MODEL_METADATA[normalized];
  return metadata ? metadata.tool_call !== false : true;
}

export function isGroqOpenCodeDiscoveredModel(
  model: string | GroqModel | null | undefined,
): boolean {
  const modelId = normalizeGroqModelId(
    typeof model === "object" && model !== null ? model.id : model,
  );
  if (!modelId) return false;
  if (typeof model === "object" && model !== null) {
    const supportsTools = hasGroqFeature(model, "tools");
    if (supportsTools !== undefined) {
      return (
        supportsTools &&
        hasTextModality(model.inputModalities) &&
        hasTextModality(model.outputModalities)
      );
    }
  }
  return isGroqOpenCodeAgentModel(modelId);
}

function boundedOutputLimit(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_GROQ_MODEL_LIMIT.output;
  }
  return Math.max(1, Math.min(Math.trunc(value), GROQ_OPEN_CODE_OUTPUT_TOKEN_CAP));
}

function modelLimit(
  model: GroqModel | null,
  metadataLimit: GroqOpenCodeModelLimit,
): GroqOpenCodeModelLimit {
  return {
    context:
      typeof model?.contextWindow === "number" && model.contextWindow > 0
        ? model.contextWindow
        : metadataLimit.context,
    output: boundedOutputLimit(model?.maxCompletionTokens ?? metadataLimit.output),
  };
}

export function groqOpenCodeModelEntry(model: string | GroqModel) {
  const modelId = normalizeGroqModelId(typeof model === "object" ? model.id : model) ?? "";
  const groqModel = typeof model === "object" ? model : null;
  const metadata = GROQ_OPEN_CODE_MODEL_METADATA[modelId] ?? {};
  const limit = modelLimit(groqModel, metadata.limit ?? DEFAULT_GROQ_MODEL_LIMIT);
  const supportsTools = groqModel ? hasGroqFeature(groqModel, "tools") : undefined;
  const supportsReasoning = groqModel ? hasGroqFeature(groqModel, "reasoning") : undefined;
  const supportsStructuredOutputs = groqModel
    ? hasGroqFeature(groqModel, "structured_outputs")
    : undefined;
  return {
    id: modelId,
    name: groqModel?.name ?? metadata.name ?? modelId,
    ...(metadata.family ? { family: metadata.family } : {}),
    attachment: false,
    reasoning: supportsReasoning ?? metadata.reasoning ?? false,
    ...((supportsStructuredOutputs ?? metadata.structured_output)
      ? { structured_output: true }
      : {}),
    tool_call: supportsTools ?? metadata.tool_call ?? true,
    temperature: true,
    modalities: {
      input: ["text"],
      output: ["text"],
    },
    open_weights: metadata.open_weights ?? false,
    limit,
  };
}

export function formatGroqOpenCodeFailureDetail(input: {
  readonly detail: string;
  readonly model?: string | null | undefined;
  readonly baseUrl?: string | null | undefined;
  readonly emptyOutput?: boolean | undefined;
}): string {
  const detail = input.detail.trim() || "The provider did not return an error message.";
  const modelId = normalizeGroqModelId(input.model) ?? "the selected model";
  const baseUrl = normalizeGroqBaseUrl(input.baseUrl);
  const lower = detail.toLowerCase();

  if (
    lower.includes("401") ||
    lower.includes("403") ||
    lower.includes("unauthorized") ||
    lower.includes("forbidden") ||
    lower.includes("invalid api key")
  ) {
    return (
      "Groq rejected authentication. Check the Groq API key in settings or GROQ_API_KEY. Details: " +
      detail
    );
  }

  if (
    lower.includes("econnrefused") ||
    lower.includes("connection refused") ||
    lower.includes("fetch failed") ||
    lower.includes("failed to fetch") ||
    lower.includes("network error")
  ) {
    return (
      "Could not reach Groq at " +
      baseUrl +
      ". Check the Groq base URL and network connection. Details: " +
      detail
    );
  }

  if (
    lower.includes("model") &&
    (lower.includes("not found") || lower.includes("404") || lower.includes("does not exist"))
  ) {
    return (
      "Groq could not load model '" +
      modelId +
      "'. Choose a model returned by Groq model discovery or add a valid custom model. Details: " +
      detail
    );
  }

  if (
    lower.includes("rate limit") ||
    lower.includes("rate_limit") ||
    lower.includes("429") ||
    lower.includes("too many requests") ||
    lower.includes("tokens per minute") ||
    lower.includes(" tpm") ||
    lower.includes("request too large")
  ) {
    return (
      "Groq rate-limited or rejected the OpenCode request size for model '" +
      modelId +
      "'. OpenCode coding-agent prompts can exceed Groq on-demand TPM limits. Retry later, choose a higher-TPM Groq model such as meta-llama/llama-4-scout-17b-16e-instruct or llama-3.3-70b-versatile, reduce context size, or upgrade the Groq tier. Details: " +
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
      "Groq model '" +
      modelId +
      "' did not answer before the request timed out. Retry or choose a smaller/faster model. Details: " +
      detail
    );
  }

  if (
    lower.includes("tool") &&
    (lower.includes("not support") ||
      lower.includes("unsupported") ||
      lower.includes("invalid") ||
      lower.includes("tool calling"))
  ) {
    return (
      "Groq model '" +
      modelId +
      "' cannot run the OpenCode coding agent because it does not support tool calling. Pick a Groq model with tool-call support, such as meta-llama/llama-4-scout-17b-16e-instruct, llama-3.3-70b-versatile, openai/gpt-oss-120b, or qwen/qwen3-32b. Details: " +
      detail
    );
  }

  if (input.emptyOutput) {
    return (
      "Groq model '" +
      modelId +
      "' answered with no text. Try again or choose a different model. Details: " +
      detail
    );
  }

  return "Groq model '" + modelId + "' failed while answering. Details: " + detail;
}

export function buildGroqOpenCodeConfig(input: {
  readonly settings: Pick<GroqSettings, "apiKey" | "baseUrl" | "customModels">;
  readonly modelIds: ReadonlyArray<string | GroqModel>;
  readonly environment?: NodeJS.ProcessEnv | undefined;
}): string {
  const modelById = new Map<string, GroqModel>();
  for (const candidate of input.modelIds) {
    if (typeof candidate === "object" && candidate !== null) {
      const modelId = normalizeGroqModelId(candidate.id);
      if (modelId) modelById.set(modelId, candidate);
    }
  }
  const modelIds =
    input.modelIds.length > 0
      ? groqModelIdsFromCandidates(input.modelIds)
      : groqModelIdsForConfig({ settings: input.settings });
  const models = Object.fromEntries(
    modelIds.map((modelId) => [modelId, groqOpenCodeModelEntry(modelById.get(modelId) ?? modelId)]),
  );
  const apiKey = resolveGroqApiKey(input.settings, input.environment);
  const defaultModelSlug = toGroqOpenCodeModelSlug(modelIds[0] ?? DEFAULT_GROQ_MODEL);
  const smallModelSlug = toGroqOpenCodeModelSlug(
    modelIds.find(
      (modelId) => normalizeGroqModelId(modelId) === "meta-llama/llama-4-scout-17b-16e-instruct",
    ) ??
      modelIds.find((modelId) => normalizeGroqModelId(modelId) === "llama-3.3-70b-versatile") ??
      modelIds.find((modelId) => normalizeGroqModelId(modelId) === "llama-3.1-8b-instant") ??
      modelIds.find((modelId) => isGroqOpenCodeAgentModel(modelId)) ??
      modelIds[0] ??
      DEFAULT_GROQ_MODEL,
  );

  return JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    ...(defaultModelSlug ? { model: defaultModelSlug } : {}),
    ...(smallModelSlug ? { small_model: smallModelSlug } : {}),
    agent: {
      build: {
        steps: 2,
      },
      plan: {
        steps: 2,
      },
      title: {
        ...(smallModelSlug ? { model: smallModelSlug } : {}),
        steps: 1,
      },
      summary: {
        ...(smallModelSlug ? { model: smallModelSlug } : {}),
        steps: 1,
      },
      compaction: {
        ...(smallModelSlug ? { model: smallModelSlug } : {}),
        steps: 1,
      },
    },
    provider: {
      [GROQ_OPENCODE_PROVIDER_ID]: {
        npm: GROQ_AI_SDK_PACKAGE,
        name: GROQ_OPENCODE_PROVIDER_NAME,
        env: ["GROQ_API_KEY"],
        options: {
          baseURL: normalizeGroqBaseUrl(input.settings.baseUrl),
          ...(apiKey ? { apiKey } : {}),
        },
        models,
      },
    },
  });
}
