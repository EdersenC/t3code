import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { DEFAULT_OLLAMA_MODEL } from "@t3tools/contracts";

import { normalizeOllamaBaseUrl } from "./ollamaApi.ts";
import {
  buildOllamaOpenCodeConfig,
  formatOllamaOpenCodeFailureDetail,
  isOllamaRunningModelCpuOnly,
  isOllamaRunningModelGpuResident,
  makeOllamaTokenUsageSnapshot,
  normalizeOllamaModelId,
  normalizeOllamaOpenAiCompatibleBaseUrl,
  ollamaModelIdsFromCandidates,
  toOllamaOpenCodeModelSlug,
} from "./ollamaOpenCode.ts";

const decodeJson = Schema.decodeUnknownSync(Schema.UnknownFromJsonString);

type OllamaOpenCodeConfig = {
  readonly model: string;
  readonly provider: {
    readonly ollama: {
      readonly npm: string;
      readonly options: { readonly baseURL: string };
      readonly models: Record<string, unknown>;
    };
  };
};

describe("Ollama OpenCode config helpers", () => {
  it("normalizes Ollama model ids and slugs", () => {
    expect(normalizeOllamaModelId("ollama/qwen2.5-coder:7b")).toBe("qwen2.5-coder:7b");
    expect(normalizeOllamaModelId(" llama3.2:3b ")).toBe("llama3.2:3b");
    expect(toOllamaOpenCodeModelSlug("qwen2.5-coder:7b")).toBe("ollama/qwen2.5-coder:7b");
    expect(ollamaModelIdsFromCandidates(["ollama/a", "a", "b", "  "])).toEqual(["a", "b"]);
  });

  it("normalizes native and OpenAI-compatible Ollama base URLs", () => {
    expect(normalizeOllamaBaseUrl("localhost:11434/v1")).toBe("http://localhost:11434");
    expect(normalizeOllamaBaseUrl("http://127.0.0.1:11434/api")).toBe("http://127.0.0.1:11434");
    expect(normalizeOllamaOpenAiCompatibleBaseUrl("http://127.0.0.1:11434/api")).toBe(
      "http://127.0.0.1:11434/v1",
    );
  });

  it("builds an OpenCode custom provider config for Ollama", () => {
    const config = decodeJson(
      buildOllamaOpenCodeConfig({
        settings: {
          baseUrl: "http://localhost:11434/v1",
          customModels: [DEFAULT_OLLAMA_MODEL],
        },
        modelIds: ["qwen2.5-coder:7b", "llama3.2:3b"],
      }),
    ) as OllamaOpenCodeConfig;

    expect(config.model).toBe("ollama/qwen2.5-coder:7b");
    expect(config.provider.ollama.npm).toBe("@ai-sdk/openai-compatible");
    expect(config.provider.ollama.options.baseURL).toBe("http://localhost:11434/v1");
    expect(Object.keys(config.provider.ollama.models)).toEqual(["qwen2.5-coder:7b", "llama3.2:3b"]);
  });
  it("detects Ollama GPU residency from running model metadata", () => {
    expect(
      isOllamaRunningModelGpuResident({
        name: "qwen3:1.7b",
        model: "qwen3:1.7b",
        sizeBytes: 100,
        sizeVramBytes: 100,
        processor: null,
      }),
    ).toBe(true);
    expect(
      isOllamaRunningModelCpuOnly({
        name: "qwen3:1.7b",
        model: "qwen3:1.7b",
        sizeBytes: 100,
        sizeVramBytes: 0,
        processor: null,
      }),
    ).toBe(true);
  });

  it("estimates Ollama token usage with a context window", () => {
    const usage = makeOllamaTokenUsageSnapshot({
      inputText: "hello world",
      assistantText: "answer",
      attachmentCount: 1,
      contextWindow: 40960,
    });

    expect(usage?.maxTokens).toBe(40960);
    expect(usage?.usedTokens).toBeGreaterThan(0);
    expect(usage?.inputTokens).toBeGreaterThan(1000);
    expect(usage?.compactsAutomatically).toBe(false);
  });

  it("formats actionable Ollama failure details", () => {
    expect(
      formatOllamaOpenCodeFailureDetail({
        model: "ollama/missing-model:latest",
        baseUrl: "localhost:11434/v1",
        detail: "model missing-model:latest not found, try pulling it first",
      }),
    ).toContain("ollama pull missing-model:latest");

    expect(
      formatOllamaOpenCodeFailureDetail({
        model: "qwen2.5-coder:7b",
        baseUrl: "http://127.0.0.1:11434",
        detail: "fetch failed: ECONNREFUSED 127.0.0.1:11434",
      }),
    ).toContain("Could not reach the local Ollama server at http://127.0.0.1:11434");

    expect(
      formatOllamaOpenCodeFailureDetail({
        model: "qwen2.5-coder:7b",
        detail: "OpenCode returned empty output.",
        emptyOutput: true,
      }),
    ).toContain("answered with no text");

    expect(
      formatOllamaOpenCodeFailureDetail({
        model: "qwen2.5-coder:7b",
        detail: "no available gpu memory",
      }),
    ).toContain("accept CPU fallback");
  });
});
