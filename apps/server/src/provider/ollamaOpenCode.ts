import {
  DEFAULT_OLLAMA_MODEL,
  type ModelSelection,
  type OllamaSettings,
  type ThreadTokenUsageSnapshot,
} from "@t3tools/contracts";
import {
  getOllamaModelDisplayName,
  getProviderOptionStringSelectionValue,
  isOllamaCloudModelId,
  stripOllamaCloudModelSuffix,
} from "@t3tools/shared/model";

import type { OpenCodeCapabilityRuntime } from "../capabilities/T3CapabilityRegistry.ts";
import { normalizeOllamaBaseUrl, type OllamaRunningModel } from "./ollamaApi.ts";
import { openCodeCapabilityConfigFragment } from "./opencodeCapabilities.ts";

export const OLLAMA_OPENCODE_PROVIDER_ID = "ollama";
export const OLLAMA_OPENCODE_PROVIDER_NAME = "Ollama (local)";
export const OLLAMA_OPENAI_COMPATIBLE_PACKAGE = "@ai-sdk/openai-compatible";
export const OLLAMA_REASONING_EFFORT_OPTION_ID = "reasoningEffort";
export const OLLAMA_REASONING_EFFORT_DEFAULT = "auto";
export const DEFAULT_OLLAMA_CONTEXT_WINDOW = 4096;
const ESTIMATED_TOKENS_PER_IMAGE = 1024;
const OLLAMA_REASONING_EFFORT_VALUES = new Set(["none", "low", "medium", "high"]);

export function normalizeOllamaModelId(model: string | null | undefined): string | null {
  if (typeof model !== "string") return null;
  const trimmed = model.trim();
  if (trimmed.length === 0) return null;
  const prefixed = OLLAMA_OPENCODE_PROVIDER_ID + "/";
  return trimmed.startsWith(prefixed) ? trimmed.slice(prefixed.length).trim() || null : trimmed;
}

export function toOllamaOpenCodeModelSlug(modelId: string | null | undefined): string | null {
  const normalized = normalizeOllamaModelId(modelId);
  return normalized ? OLLAMA_OPENCODE_PROVIDER_ID + "/" + normalized : null;
}

export function ollamaModelIdsFromCandidates(
  candidates: ReadonlyArray<string | null | undefined>,
): ReadonlyArray<string> {
  const seen = new Set<string>();
  const modelIds: Array<string> = [];
  for (const candidate of candidates) {
    const modelId = normalizeOllamaModelId(candidate);
    if (!modelId || seen.has(modelId)) continue;
    seen.add(modelId);
    modelIds.push(modelId);
  }
  return modelIds;
}

export function ollamaModelIdsForConfig(input: {
  readonly settings: Pick<OllamaSettings, "customModels">;
  readonly discoveredModels?: ReadonlyArray<string> | undefined;
}): ReadonlyArray<string> {
  const modelIds = ollamaModelIdsFromCandidates([
    ...(input.discoveredModels ?? []),
    ...input.settings.customModels,
    DEFAULT_OLLAMA_MODEL,
  ]);
  return modelIds.length > 0 ? modelIds : [normalizeOllamaModelId(DEFAULT_OLLAMA_MODEL)!];
}

export function normalizeOllamaOpenAiCompatibleBaseUrl(baseUrl: string | null | undefined): string {
  return normalizeOllamaBaseUrl(baseUrl) + "/v1";
}

export function isOllamaRunningModelGpuResident(model: OllamaRunningModel): boolean {
  const processor = model.processor?.toLowerCase() ?? "";
  if (processor.includes("gpu") || processor.includes("cuda") || processor.includes("metal")) {
    return true;
  }
  return (model.sizeVramBytes ?? 0) > 0;
}

export function isOllamaRunningModelCpuOnly(model: OllamaRunningModel): boolean {
  const processor = model.processor?.toLowerCase() ?? "";
  if (processor.includes("cpu")) return true;
  if (model.sizeVramBytes !== null) return model.sizeVramBytes <= 0;
  return false;
}

function estimateTextTokens(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  return Math.max(1, Math.ceil(trimmed.length / 4));
}

export function makeOllamaTokenUsageSnapshot(input: {
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
      : DEFAULT_OLLAMA_CONTEXT_WINDOW;
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

export function resolveOllamaReasoningEffort(
  modelSelection: Pick<ModelSelection, "options"> | null | undefined,
): string | null {
  const value = getProviderOptionStringSelectionValue(
    modelSelection?.options,
    OLLAMA_REASONING_EFFORT_OPTION_ID,
  );
  if (!value || value === OLLAMA_REASONING_EFFORT_DEFAULT) return null;
  return OLLAMA_REASONING_EFFORT_VALUES.has(value) ? value : null;
}

export function formatOllamaOpenCodeFailureDetail(input: {
  readonly detail: string;
  readonly model?: string | null | undefined;
  readonly baseUrl?: string | null | undefined;
  readonly emptyOutput?: boolean | undefined;
}): string {
  const detail = input.detail.trim() || "The provider did not return an error message.";
  const normalizedModelId = normalizeOllamaModelId(input.model);
  const isCloudModel = isOllamaCloudModelId(normalizedModelId ?? input.model);
  const modelId =
    getOllamaModelDisplayName(normalizedModelId ?? input.model) ??
    (normalizedModelId ? stripOllamaCloudModelSuffix(normalizedModelId) : "the selected model");
  const modelLabel = isCloudModel ? "Ollama Cloud model" : "Ollama model";
  const modelChoiceLabel = isCloudModel ? "cloud model" : "local model";
  const baseUrl = normalizeOllamaBaseUrl(input.baseUrl);
  const lower = detail.toLowerCase();

  if (
    lower.includes("econnrefused") ||
    lower.includes("connection refused") ||
    lower.includes("fetch failed") ||
    lower.includes("failed to fetch") ||
    lower.includes("network error")
  ) {
    return (
      "Could not reach the local Ollama server at " +
      baseUrl +
      ". Start Ollama, check the Ollama base URL in settings, then retry. Details: " +
      detail
    );
  }

  if (
    lower.includes("model") &&
    (lower.includes("not found") || lower.includes("404") || lower.includes("pull model"))
  ) {
    if (isCloudModel) {
      return (
        "Ollama Cloud could not access model '" +
        modelId +
        "'. Check Ollama Cloud auth and model availability, then retry. Details: " +
        detail
      );
    }

    return (
      "Ollama could not load local model '" +
      modelId +
      "'. Run 'ollama pull " +
      modelId +
      "' or choose an installed local model. Details: " +
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
      modelLabel +
      " '" +
      modelId +
      "' did not answer before the request timed out. Try a smaller model or retry after the model finishes loading. Details: " +
      detail
    );
  }

  if (
    lower.includes("no available gpu") ||
    lower.includes("gpu memory") ||
    lower.includes("vram") ||
    lower.includes("cuda out of memory")
  ) {
    return (
      "Ollama could not keep model '" +
      modelId +
      "' on the GPU. Free GPU memory, use a smaller model, or accept CPU fallback in Ollama settings if slower CPU inference is acceptable. Details: " +
      detail
    );
  }

  if (
    lower.includes("out of memory") ||
    lower.includes("cuda") ||
    lower.includes("runner") ||
    lower.includes("failed to load") ||
    lower.includes("load model")
  ) {
    return (
      "Ollama failed while loading or running model '" +
      modelId +
      "'. Free local memory/GPU resources, try a smaller model, or accept CPU fallback in Ollama settings if needed. Details: " +
      detail
    );
  }

  if (
    lower.includes("tool") &&
    (lower.includes("not support") || lower.includes("unsupported") || lower.includes("invalid"))
  ) {
    return (
      modelLabel +
      " '" +
      modelId +
      "' could not handle the tool-call request. Pick a " +
      modelChoiceLabel +
      " with tool-call support. Details: " +
      detail
    );
  }

  if (input.emptyOutput) {
    return (
      modelLabel +
      " '" +
      modelId +
      "' answered with no text. Try again or choose a different " +
      modelChoiceLabel +
      ". Details: " +
      detail
    );
  }

  return modelLabel + " '" + modelId + "' failed while answering. Details: " + detail;
}

export function buildOllamaOpenCodeConfig(input: {
  readonly settings: Pick<OllamaSettings, "baseUrl" | "customModels">;
  readonly modelIds: ReadonlyArray<string>;
  readonly modelSelection?: ModelSelection | undefined;
  readonly capabilityRuntime?: Pick<OpenCodeCapabilityRuntime, "skillPaths" | "skillPermissions">;
}): string {
  const modelIds =
    input.modelIds.length > 0
      ? input.modelIds
      : ollamaModelIdsForConfig({ settings: input.settings });
  const reasoningEffort = resolveOllamaReasoningEffort(input.modelSelection);
  const models = Object.fromEntries(
    modelIds.map((modelId) => [
      modelId,
      {
        name: modelId,
        ...(reasoningEffort
          ? {
              options: {
                reasoningEffort,
              },
            }
          : {}),
      },
    ]),
  );
  const defaultModelSlug = toOllamaOpenCodeModelSlug(modelIds[0] ?? DEFAULT_OLLAMA_MODEL);

  return JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    ...(defaultModelSlug ? { model: defaultModelSlug } : {}),
    ...openCodeCapabilityConfigFragment(input),
    provider: {
      [OLLAMA_OPENCODE_PROVIDER_ID]: {
        npm: OLLAMA_OPENAI_COMPATIBLE_PACKAGE,
        name: OLLAMA_OPENCODE_PROVIDER_NAME,
        options: {
          baseURL: normalizeOllamaOpenAiCompatibleBaseUrl(input.settings.baseUrl),
        },
        models,
      },
    },
  });
}
