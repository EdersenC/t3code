import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { DEFAULT_GROQ_MODEL } from "@t3tools/contracts";
import { DEFAULT_GROQ_BASE_URL } from "@t3tools/contracts/settings";

import { normalizeGroqBaseUrl } from "./groqApi.ts";
import {
  buildGroqOpenCodeConfig,
  formatGroqOpenCodeFailureDetail,
  groqModelIdsFromCandidates,
  groqModelIdsForConfig,
  normalizeGroqModelId,
  toGroqOpenCodeModelSlug,
} from "./groqOpenCode.ts";

const decodeJson = Schema.decodeUnknownSync(Schema.UnknownFromJsonString);

type GroqOpenCodeConfig = {
  readonly model: string;
  readonly small_model: string;
  readonly agent: {
    readonly build: { readonly steps: number };
    readonly plan: { readonly steps: number };
    readonly title: { readonly model: string; readonly steps: number };
    readonly summary: { readonly model: string; readonly steps: number };
    readonly compaction: { readonly model: string; readonly steps: number };
  };
  readonly provider: {
    readonly groq: {
      readonly npm: string;
      readonly options: { readonly baseURL: string; readonly apiKey?: string };
      readonly models: Record<
        string,
        {
          readonly id: string;
          readonly name: string;
          readonly limit: { readonly context: number; readonly output: number };
          readonly reasoning?: boolean;
          readonly structured_output?: boolean;
          readonly tool_call: boolean;
        }
      >;
    };
  };
};

describe("Groq OpenCode config helpers", () => {
  it("normalizes Groq model ids and slugs", () => {
    expect(normalizeGroqModelId("groq/openai/gpt-oss-120b")).toBe("openai/gpt-oss-120b");
    expect(normalizeGroqModelId(" llama-3.3-70b-versatile ")).toBe("llama-3.3-70b-versatile");
    expect(toGroqOpenCodeModelSlug("openai/gpt-oss-120b")).toBe("groq/openai/gpt-oss-120b");
    expect(groqModelIdsFromCandidates(["groq/a", "a", "b", "  "])).toEqual(["a", "b"]);
  });

  it("normalizes Groq base URLs", () => {
    expect(normalizeGroqBaseUrl("api.groq.com/openai/v1/")).toBe("https://api.groq.com/openai/v1");
    expect(normalizeGroqBaseUrl("")).toBe(DEFAULT_GROQ_BASE_URL);
  });

  it("builds an OpenCode custom provider config for Groq", () => {
    const config = decodeJson(
      buildGroqOpenCodeConfig({
        settings: {
          apiKey: "",
          baseUrl: "https://api.groq.com/openai/v1/",
          customModels: [DEFAULT_GROQ_MODEL],
        },
        modelIds: ["openai/gpt-oss-120b", "llama-3.3-70b-versatile"],
        environment: { GROQ_API_KEY: "gsk_test" },
      }),
    ) as GroqOpenCodeConfig;

    expect(config.model).toBe("groq/openai/gpt-oss-120b");
    expect(config.small_model).toBe("groq/llama-3.3-70b-versatile");
    expect(config.agent.build.steps).toBe(2);
    expect(config.agent.plan.steps).toBe(2);
    expect(config.agent.title).toEqual({
      model: "groq/llama-3.3-70b-versatile",
      steps: 1,
    });
    expect(config.provider.groq.npm).toBe("@ai-sdk/groq");
    expect(config.provider.groq.options.baseURL).toBe("https://api.groq.com/openai/v1");
    expect(config.provider.groq.options.apiKey).toBe("gsk_test");
    expect(config.provider.groq.models["openai/gpt-oss-120b"]?.limit).toEqual({
      context: 131072,
      output: 256,
    });
    expect(config.provider.groq.models["openai/gpt-oss-120b"]?.tool_call).toBe(true);
    expect(Object.keys(config.provider.groq.models)).toEqual([
      "openai/gpt-oss-120b",
      "llama-3.3-70b-versatile",
    ]);
  });

  it("keeps OpenCode-compatible Groq models and filters known unsupported agent models", () => {
    expect(
      groqModelIdsForConfig({
        settings: { customModels: ["allam-2-7b"] },
        discoveredModels: [
          { id: "allam-2-7b", ownedBy: "Groq" },
          { id: "whisper-large-v3", ownedBy: "Groq" },
          { id: "llama-3.3-70b-versatile", ownedBy: "Groq" },
        ],
      }),
    ).toEqual([
      "llama-3.3-70b-versatile",
      "meta-llama/llama-4-scout-17b-16e-instruct",
      "llama-3.1-8b-instant",
      "openai/gpt-oss-120b",
      "openai/gpt-oss-20b",
    ]);
  });

  it("uses live Groq model metadata for OpenCode limits and capabilities", () => {
    const config = decodeJson(
      buildGroqOpenCodeConfig({
        settings: {
          apiKey: "",
          baseUrl: "https://api.groq.com/openai/v1/",
          customModels: [],
        },
        modelIds: [
          {
            id: "qwen/qwen3.6-27b",
            name: "Qwen/Qwen3.6 27B",
            ownedBy: "Alibaba Cloud",
            contextWindow: 262144,
            maxCompletionTokens: 32768,
            supportedFeatures: ["tools", "reasoning", "structured_outputs"],
            inputModalities: ["text"],
            outputModalities: ["text"],
          },
        ],
      }),
    ) as GroqOpenCodeConfig;

    expect(config.provider.groq.models["qwen/qwen3.6-27b"]).toMatchObject({
      name: "Qwen/Qwen3.6 27B",
      reasoning: true,
      structured_output: true,
      tool_call: true,
      limit: {
        context: 262144,
        output: 256,
      },
    });
  });

  it("formats actionable Groq failure details", () => {
    expect(
      formatGroqOpenCodeFailureDetail({
        model: "groq/openai/gpt-oss-120b",
        detail: "401 invalid api key",
      }),
    ).toContain("Check the Groq API key");

    expect(
      formatGroqOpenCodeFailureDetail({
        model: "llama-3.3-70b-versatile",
        detail: "model missing-model not found",
      }),
    ).toContain("could not load model");

    expect(
      formatGroqOpenCodeFailureDetail({
        model: "llama-3.3-70b-versatile",
        detail:
          "Request too large for model `llama-3.1-8b-instant` on tokens per minute (TPM): Limit 6000, Requested 42347",
      }),
    ).toContain("reduce context size");

    expect(
      formatGroqOpenCodeFailureDetail({
        model: "allam-2-7b",
        detail: "`tool calling` is not supported with this model",
      }),
    ).toContain("does not support tool calling");

    expect(
      formatGroqOpenCodeFailureDetail({
        model: "llama-3.3-70b-versatile",
        detail: "OpenCode returned empty output.",
        emptyOutput: true,
      }),
    ).toContain("answered with no text");
  });
});
