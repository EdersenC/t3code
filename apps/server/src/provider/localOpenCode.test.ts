import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  DEFAULT_LOCAL_CONTEXT_WINDOW,
  DEFAULT_LOCAL_MODEL,
  DEFAULT_LOCAL_OUTPUT_TOKEN_LIMIT,
} from "@t3tools/contracts";

import {
  buildLocalOpenCodeConfig,
  formatLocalOpenCodeFailureDetail,
  localModelIdsFromCandidates,
  localModelIdsForConfig,
  makeLocalTokenUsageSnapshot,
  normalizeLocalModelId,
  normalizeLocalOpenAiCompatibleBaseUrl,
  normalizeLocalVllmBaseUrl,
  toLocalOpenCodeModelSlug,
} from "./localOpenCode.ts";

const decodeJson = Schema.decodeUnknownSync(Schema.UnknownFromJsonString);

type LocalOpenCodeConfig = {
  readonly model: string;
  readonly provider: {
    readonly "local-vllm": {
      readonly npm: string;
      readonly options: { readonly baseURL: string };
      readonly models: Record<
        string,
        {
          readonly name: string;
          readonly limit?: {
            readonly context?: number;
            readonly output?: number;
          };
        }
      >;
    };
  };
};

describe("Local vLLM OpenCode config helpers", () => {
  it("normalizes Local model ids and slugs", () => {
    expect(normalizeLocalModelId("local-vllm/Qwen/Qwen3-8B-AWQ")).toBe("Qwen/Qwen3-8B-AWQ");
    expect(normalizeLocalModelId(" Qwen/Qwen3-8B-AWQ ")).toBe("Qwen/Qwen3-8B-AWQ");
    expect(toLocalOpenCodeModelSlug("Qwen/Qwen3-8B-AWQ")).toBe("local-vllm/Qwen/Qwen3-8B-AWQ");
    expect(
      localModelIdsFromCandidates(["local-vllm/Qwen/Qwen3-8B-AWQ", "Qwen/Qwen3-8B-AWQ", "x"]),
    ).toEqual(["Qwen/Qwen3-8B-AWQ", "x"]);
  });

  it("prefers discovered served models before falling back to defaults", () => {
    expect(
      localModelIdsForConfig({
        settings: { customModels: ["local-vllm/custom/model"] },
        discoveredModels: ["Qwen/Qwen3-8B-AWQ"],
      }),
    ).toEqual(["Qwen/Qwen3-8B-AWQ", "custom/model"]);

    expect(localModelIdsForConfig({ settings: { customModels: [] } })).toContain(
      "Qwen/Qwen2.5-Coder-0.5B-Instruct",
    );
  });

  it("normalizes native and OpenAI-compatible vLLM base URLs", () => {
    expect(normalizeLocalVllmBaseUrl("http://127.0.0.1:8018/v1")).toBe("http://127.0.0.1:8018");
    expect(normalizeLocalVllmBaseUrl("localhost:8018/v1?x=1#hash")).toBe("http://localhost:8018");
    expect(normalizeLocalVllmBaseUrl("http://localhost:8018/api")).toBe("http://localhost:8018");
    expect(normalizeLocalOpenAiCompatibleBaseUrl("http://127.0.0.1:8018/v1")).toBe(
      "http://127.0.0.1:8018/v1",
    );
  });

  it("builds an OpenCode custom provider config for Local vLLM", () => {
    const config = decodeJson(
      buildLocalOpenCodeConfig({
        settings: {
          baseUrl: "http://localhost:8018/v1",
          customModels: [DEFAULT_LOCAL_MODEL],
        },
        modelIds: ["Qwen/Qwen3-8B-AWQ", "Qwen/Qwen2.5-Coder-14B-Instruct-AWQ"],
      }),
    ) as LocalOpenCodeConfig;

    expect(config.model).toBe("local-vllm/Qwen/Qwen3-8B-AWQ");
    expect(config.provider["local-vllm"].npm).toBe("@ai-sdk/openai-compatible");
    expect(config.provider["local-vllm"].options.baseURL).toBe("http://localhost:8018/v1");
    expect(Object.keys(config.provider["local-vllm"].models)).toEqual([
      "Qwen/Qwen3-8B-AWQ",
      "Qwen/Qwen2.5-Coder-14B-Instruct-AWQ",
    ]);
    expect(config.provider["local-vllm"].models["Qwen/Qwen3-8B-AWQ"]?.limit).toEqual({
      context: DEFAULT_LOCAL_CONTEXT_WINDOW,
      output: DEFAULT_LOCAL_OUTPUT_TOKEN_LIMIT,
    });
  });

  it("clamps Local OpenCode model output limits to the configured context", () => {
    const config = decodeJson(
      buildLocalOpenCodeConfig({
        settings: {
          baseUrl: "http://localhost:8018",
          customModels: [],
          contextWindow: 2048,
          outputTokenLimit: 32000,
        },
        modelIds: ["Qwen/Qwen3-8B-AWQ"],
      }),
    ) as LocalOpenCodeConfig;

    expect(config.provider["local-vllm"].models["Qwen/Qwen3-8B-AWQ"]?.limit).toEqual({
      context: 2048,
      output: 2048,
    });
  });

  it("estimates Local token usage with a default context window", () => {
    const usage = makeLocalTokenUsageSnapshot({
      inputText: "hello world",
      assistantText: "answer",
      attachmentCount: 1,
    });

    expect(usage?.maxTokens).toBe(DEFAULT_LOCAL_CONTEXT_WINDOW);
    expect(usage?.usedTokens).toBeGreaterThan(0);
    expect(usage?.inputTokens).toBeGreaterThan(1000);
    expect(usage?.compactsAutomatically).toBe(false);
  });

  it("estimates Local token usage with the configured context window", () => {
    const usage = makeLocalTokenUsageSnapshot({
      inputText: "hello world",
      assistantText: "answer",
      attachmentCount: 0,
      contextWindow: 9000,
    });

    expect(usage?.maxTokens).toBe(9000);
  });

  it("formats actionable Local vLLM failure details", () => {
    expect(
      formatLocalOpenCodeFailureDetail({
        model: "local-vllm/Qwen/Qwen3-8B-AWQ",
        baseUrl: "http://127.0.0.1:8018/v1",
        detail: "fetch failed: ECONNREFUSED 127.0.0.1:8018",
      }),
    ).toContain("Could not reach the local vLLM server at http://127.0.0.1:8018");

    expect(
      formatLocalOpenCodeFailureDetail({
        model: "Qwen/Qwen3-8B-AWQ",
        detail: "cuda out of memory",
      }),
    ).toContain("Free GPU memory");

    expect(
      formatLocalOpenCodeFailureDetail({
        model: "Qwen/Qwen3-8B-AWQ",
        detail: "OpenCode returned empty output.",
        emptyOutput: true,
      }),
    ).toContain("answered with no text");

    expect(
      formatLocalOpenCodeFailureDetail({
        model: "Qwen/Qwen3-8B-AWQ",
        detail:
          '"auto" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set',
      }),
    ).toContain("--tool-call-parser qwen3_xml");

    expect(
      formatLocalOpenCodeFailureDetail({
        model: "Qwen/Qwen3-8B-AWQ",
        detail: "max_tokens=32000 cannot be greater than max_model_len=max_total_tokens=2048",
      }),
    ).toContain("more output tokens than the running vLLM server allows");

    expect(
      formatLocalOpenCodeFailureDetail({
        model: "Qwen/Qwen3-8B-AWQ",
        detail:
          "This model's maximum context length is 4096 tokens. However, you requested 512 output tokens and your prompt contains at least 3585 input tokens, for a total of at least 4097 tokens. Please reduce the length of the input prompt or the number of requested output tokens. (parameter=input_tokens, value=3585)",
      }),
    ).toContain("ran out of context after OpenCode added its prompt and tool instructions");
  });
});
