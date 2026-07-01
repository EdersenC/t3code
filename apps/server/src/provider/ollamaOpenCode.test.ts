import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { DEFAULT_OLLAMA_MODEL, ProviderInstanceId } from "@t3tools/contracts";

import { normalizeOllamaBaseUrl } from "./ollamaApi.ts";
import {
  buildOllamaOpenCodeConfig,
  formatOllamaOpenCodeFailureDetail,
  isOllamaRunningModelCpuOnly,
  isOllamaRunningModelGpuResident,
  makeOllamaTokenUsageSnapshot,
  normalizeOllamaModelId,
  normalizeOllamaOpenAiCompatibleBaseUrl,
  OLLAMA_REASONING_EFFORT_DEFAULT,
  OLLAMA_REASONING_EFFORT_OPTION_ID,
  ollamaModelIdsFromCandidates,
  resolveOllamaReasoningEffort,
  toOllamaOpenCodeModelSlug,
} from "./ollamaOpenCode.ts";

const decodeJson = Schema.decodeUnknownSync(Schema.UnknownFromJsonString);

type OllamaOpenCodeConfig = {
  readonly model: string;
  readonly skills?: { readonly paths: ReadonlyArray<string> };
  readonly permission?: { readonly skill: Readonly<Record<string, "allow" | "deny">> };
  readonly provider: {
    readonly ollama: {
      readonly npm: string;
      readonly options: { readonly baseURL: string };
      readonly models: Record<
        string,
        {
          readonly name?: string;
          readonly options?: {
            readonly reasoningEffort?: string;
          };
        }
      >;
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

  it("preserves Ollama Cloud colon tags in generated provider config", () => {
    const config = decodeJson(
      buildOllamaOpenCodeConfig({
        settings: {
          baseUrl: "http://localhost:11434/v1",
          customModels: [],
        },
        modelIds: ["gpt-oss:20b-cloud"],
        modelSelection: {
          instanceId: ProviderInstanceId.make("ollama"),
          model: "ollama/gpt-oss:20b-cloud",
        },
      }),
    ) as OllamaOpenCodeConfig;

    expect(config.model).toBe("ollama/gpt-oss:20b-cloud");
    expect(Object.keys(config.provider.ollama.models)).toEqual(["gpt-oss:20b-cloud"]);
  });

  it("adds shared T3 capability runtime config", () => {
    const config = decodeJson(
      buildOllamaOpenCodeConfig({
        settings: {
          baseUrl: "http://localhost:11434/v1",
          customModels: [DEFAULT_OLLAMA_MODEL],
        },
        modelIds: ["qwen2.5-coder:7b"],
        capabilityRuntime: {
          skillPaths: ["/tmp/t3-skills"],
          skillPermissions: {
            "customize-opencode": "allow",
            "legacy-hidden-skill": "deny",
          },
        },
      }),
    ) as OllamaOpenCodeConfig;

    expect(config.skills?.paths).toEqual(["/tmp/t3-skills"]);
    expect(config.permission?.skill).toEqual({
      "customize-opencode": "allow",
      "legacy-hidden-skill": "deny",
    });
  });

  it("adds selected Ollama reasoning effort to generated model options", () => {
    const config = decodeJson(
      buildOllamaOpenCodeConfig({
        settings: {
          baseUrl: "http://localhost:11434/v1",
          customModels: [DEFAULT_OLLAMA_MODEL],
        },
        modelIds: ["qwen3:8b"],
        modelSelection: {
          instanceId: ProviderInstanceId.make("ollama"),
          model: "ollama/qwen3:8b",
          options: [{ id: OLLAMA_REASONING_EFFORT_OPTION_ID, value: "high" }],
        },
      }),
    ) as OllamaOpenCodeConfig;

    expect(config.provider.ollama.models["qwen3:8b"]?.options).toEqual({
      reasoningEffort: "high",
    });
  });

  it("omits default or unknown Ollama reasoning effort overrides", () => {
    expect(
      resolveOllamaReasoningEffort({
        options: [
          { id: OLLAMA_REASONING_EFFORT_OPTION_ID, value: OLLAMA_REASONING_EFFORT_DEFAULT },
        ],
      }),
    ).toBeNull();
    expect(
      resolveOllamaReasoningEffort({
        options: [{ id: OLLAMA_REASONING_EFFORT_OPTION_ID, value: "max" }],
      }),
    ).toBeNull();
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

    expect(
      formatOllamaOpenCodeFailureDetail({
        model: "ollama/gpt-oss-120b-cloud",
        detail: "model gpt-oss-120b-cloud not found",
      }),
    ).toContain("Ollama Cloud could not access model 'gpt-oss-120b'");
  });
});
