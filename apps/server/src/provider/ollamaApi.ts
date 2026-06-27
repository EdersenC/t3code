import type { OllamaSettings } from "@t3tools/contracts";

export const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

export type OllamaFetch = typeof fetch;

export interface OllamaToolCall {
  readonly function?: {
    readonly name?: string;
    readonly arguments?: unknown;
  };
}

export interface OllamaMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
  readonly images?: ReadonlyArray<string>;
  readonly tool_name?: string;
  readonly tool_calls?: ReadonlyArray<OllamaToolCall>;
}

export interface OllamaToolDefinition {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
}

export interface OllamaChatResponse {
  readonly model?: string;
  readonly message?: OllamaMessage;
  readonly done?: boolean;
  readonly done_reason?: string;
  readonly prompt_eval_count?: number;
  readonly eval_count?: number;
}

export interface OllamaRunningModel {
  readonly name: string;
  readonly model: string;
  readonly sizeBytes: number | null;
  readonly sizeVramBytes: number | null;
  readonly processor: string | null;
}

export interface OllamaModelMetadata {
  readonly model: string;
  readonly contextWindow: number | null;
}

export class OllamaApiError extends Error {
  readonly operation: string;
  readonly status: number | undefined;
  override readonly cause: unknown;

  constructor(input: {
    readonly operation: string;
    readonly detail: string;
    readonly status?: number | undefined;
    readonly cause?: unknown;
  }) {
    super(input.detail);
    this.name = "OllamaApiError";
    this.operation = input.operation;
    this.status = input.status;
    this.cause = input.cause;
  }
}

interface OllamaRequestOptions {
  readonly fetchFn?: OllamaFetch | undefined;
  readonly timeoutMs?: number | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asFiniteNonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : null;
}

function asFinitePositiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : null;
}

function parseContextWindowFromParameters(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^\s*num_ctx\s+(\d+)\s*$/im.exec(value);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null;
}

function parseContextWindowFromModelInfo(value: unknown): number | null {
  if (!isRecord(value)) return null;

  let best: number | null = null;
  for (const [key, rawValue] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase();
    if (
      !normalizedKey.endsWith(".context_length") &&
      !normalizedKey.endsWith(".context") &&
      !normalizedKey.endsWith(".n_ctx") &&
      normalizedKey !== "context_length" &&
      normalizedKey !== "num_ctx"
    ) {
      continue;
    }

    const parsed = asFinitePositiveInteger(rawValue);
    if (parsed !== null) {
      best = Math.max(best ?? 0, parsed);
    }
  }

  return best;
}

export function normalizeOllamaBaseUrl(baseUrl: string | null | undefined): string {
  const raw = baseUrl?.trim() || DEFAULT_OLLAMA_BASE_URL;
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : "http://" + raw;
  try {
    const url = new URL(withProtocol);
    url.hash = "";
    url.search = "";

    const pathname = url.pathname.replace(/\/+$/, "");
    if (pathname === "/v1" || pathname.endsWith("/v1")) {
      url.pathname = pathname.slice(0, -"/v1".length) || "/";
    } else if (pathname === "/api" || pathname.endsWith("/api")) {
      url.pathname = pathname.slice(0, -"/api".length) || "/";
    }

    return url.toString().replace(/\/+$/, "");
  } catch {
    return DEFAULT_OLLAMA_BASE_URL;
  }
}

async function requestOllamaJson(input: {
  readonly settings: Pick<OllamaSettings, "baseUrl">;
  readonly operation: string;
  readonly path: string;
  readonly method?: "GET" | "POST" | undefined;
  readonly body?: unknown;
  readonly options?: OllamaRequestOptions | undefined;
}): Promise<unknown> {
  const baseUrl = normalizeOllamaBaseUrl(input.settings.baseUrl);
  const fetchFn = input.options?.fetchFn ?? globalThis.fetch;
  const timeoutMs = input.options?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const signal = AbortSignal.timeout(timeoutMs);

  try {
    const headers: Record<string, string> = { accept: "application/json" };
    let body: string | undefined;
    if (input.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(input.body);
    }

    const response = await fetchFn(baseUrl + input.path, {
      method: input.method ?? (body ? "POST" : "GET"),
      headers,
      body,
      signal,
    });

    if (!response.ok) {
      let detail = "Ollama request failed with HTTP " + response.status + ".";
      try {
        const text = (await response.text()).trim();
        if (text) detail = text;
      } catch {
        // Keep the status-only message.
      }
      throw new OllamaApiError({
        operation: input.operation,
        status: response.status,
        detail,
      });
    }

    return await response.json();
  } catch (cause) {
    if (cause instanceof OllamaApiError) {
      throw cause;
    }
    const detail =
      cause instanceof Error && (cause.name === "AbortError" || cause.name === "TimeoutError")
        ? "Ollama request timed out after " + timeoutMs + "ms."
        : cause instanceof Error
          ? cause.message
          : "Ollama request failed.";
    throw new OllamaApiError({ operation: input.operation, detail, cause });
  }
}

export async function getOllamaVersion(
  settings: Pick<OllamaSettings, "baseUrl">,
  options?: OllamaRequestOptions,
): Promise<string | null> {
  const response = await requestOllamaJson({
    settings,
    operation: "GET /api/version",
    path: "/api/version",
    options,
  });
  return isRecord(response) && typeof response.version === "string" ? response.version : null;
}

export async function listOllamaModels(
  settings: Pick<OllamaSettings, "baseUrl">,
  options?: OllamaRequestOptions,
): Promise<ReadonlyArray<string>> {
  const response = await requestOllamaJson({
    settings,
    operation: "GET /api/tags",
    path: "/api/tags",
    options,
  });
  if (!isRecord(response) || !Array.isArray(response.models)) {
    return [];
  }

  const models: Array<string> = [];
  for (const entry of response.models) {
    if (!isRecord(entry)) continue;
    const name =
      typeof entry.name === "string" && entry.name.trim().length > 0
        ? entry.name.trim()
        : typeof entry.model === "string" && entry.model.trim().length > 0
          ? entry.model.trim()
          : null;
    if (name) models.push(name);
  }
  return models;
}

export async function listRunningOllamaModels(
  settings: Pick<OllamaSettings, "baseUrl">,
  options?: OllamaRequestOptions,
): Promise<ReadonlyArray<OllamaRunningModel>> {
  const response = await requestOllamaJson({
    settings,
    operation: "GET /api/ps",
    path: "/api/ps",
    options,
  });
  if (!isRecord(response) || !Array.isArray(response.models)) {
    return [];
  }

  const models: Array<OllamaRunningModel> = [];
  for (const entry of response.models) {
    if (!isRecord(entry)) continue;
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    const model = typeof entry.model === "string" ? entry.model.trim() : name;
    if (!name && !model) continue;

    models.push({
      name: name || model,
      model: model || name,
      sizeBytes: asFiniteNonNegativeInteger(entry.size),
      sizeVramBytes: asFiniteNonNegativeInteger(entry.size_vram),
      processor: typeof entry.processor === "string" ? entry.processor.trim() || null : null,
    });
  }
  return models;
}

export async function getOllamaModelMetadata(
  settings: Pick<OllamaSettings, "baseUrl">,
  model: string,
  options?: OllamaRequestOptions,
): Promise<OllamaModelMetadata> {
  const response = await requestOllamaJson({
    settings,
    operation: "POST /api/show",
    path: "/api/show",
    method: "POST",
    body: { model },
    options,
  });

  const contextWindow = isRecord(response)
    ? (parseContextWindowFromModelInfo(response.model_info) ??
      parseContextWindowFromParameters(response.parameters))
    : null;

  return { model, contextWindow };
}

export async function chatOllama(
  settings: Pick<OllamaSettings, "baseUrl">,
  input: {
    readonly model: string;
    readonly messages: ReadonlyArray<OllamaMessage>;
    readonly tools?: ReadonlyArray<OllamaToolDefinition> | undefined;
    readonly options?: Record<string, unknown> | undefined;
  },
  options?: OllamaRequestOptions,
): Promise<OllamaChatResponse> {
  const payload: Record<string, unknown> = {
    model: input.model,
    messages: input.messages,
    stream: false,
  };
  if (input.tools && input.tools.length > 0) payload.tools = input.tools;
  if (input.options !== undefined) payload.options = input.options;

  const response = await requestOllamaJson({
    settings,
    operation: "POST /api/chat",
    path: "/api/chat",
    method: "POST",
    body: payload,
    options,
  });
  return isRecord(response) ? (response as unknown as OllamaChatResponse) : {};
}
