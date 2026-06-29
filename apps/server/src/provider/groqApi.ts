import type { GroqSettings } from "@t3tools/contracts";
import { DEFAULT_GROQ_BASE_URL } from "@t3tools/contracts/settings";

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

export type GroqFetch = typeof fetch;

export class GroqApiError extends Error {
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
    this.name = "GroqApiError";
    this.operation = input.operation;
    this.status = input.status;
    this.cause = input.cause;
  }
}

export interface GroqModel {
  readonly id: string;
  readonly ownedBy: string | null;
  readonly name?: string | undefined;
  readonly contextWindow?: number | undefined;
  readonly maxCompletionTokens?: number | undefined;
  readonly supportedFeatures?: ReadonlyArray<string> | undefined;
  readonly inputModalities?: ReadonlyArray<string> | undefined;
  readonly outputModalities?: ReadonlyArray<string> | undefined;
}

export interface GroqRequestOptions {
  readonly fetchFn?: GroqFetch | undefined;
  readonly timeoutMs?: number | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finitePositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : undefined;
}

function stringArray(value: unknown): ReadonlyArray<string> | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
  return strings.length > 0 ? strings : undefined;
}

export function normalizeGroqBaseUrl(baseUrl: string | null | undefined): string {
  const raw = baseUrl?.trim() || DEFAULT_GROQ_BASE_URL;
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : "https://" + raw;
  try {
    const url = new URL(withProtocol);
    url.hash = "";
    url.search = "";
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return DEFAULT_GROQ_BASE_URL;
  }
}

export function resolveGroqApiKey(
  settings: Pick<GroqSettings, "apiKey">,
  environment?: NodeJS.ProcessEnv | undefined,
): string {
  return settings.apiKey.trim() || environment?.GROQ_API_KEY?.trim() || "";
}

async function requestGroqJson(input: {
  readonly settings: Pick<GroqSettings, "apiKey" | "baseUrl">;
  readonly operation: string;
  readonly path: string;
  readonly environment?: NodeJS.ProcessEnv | undefined;
  readonly options?: GroqRequestOptions | undefined;
}): Promise<unknown> {
  const apiKey = resolveGroqApiKey(input.settings, input.environment);
  if (!apiKey) {
    throw new GroqApiError({
      operation: input.operation,
      detail: "Missing Groq API key. Add one in provider settings or set GROQ_API_KEY.",
      status: 401,
    });
  }

  const baseUrl = normalizeGroqBaseUrl(input.settings.baseUrl);
  const fetchFn = input.options?.fetchFn ?? globalThis.fetch;
  const timeoutMs = input.options?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const signal = AbortSignal.timeout(timeoutMs);

  try {
    const response = await fetchFn(baseUrl + input.path, {
      headers: {
        accept: "application/json",
        authorization: "Bearer " + apiKey,
      },
      signal,
    });

    if (!response.ok) {
      let detail = "Groq request failed with HTTP " + response.status + ".";
      try {
        const text = (await response.text()).trim();
        if (text) detail = text;
      } catch {
        // Keep the status-only message.
      }
      throw new GroqApiError({
        operation: input.operation,
        status: response.status,
        detail,
      });
    }

    return await response.json();
  } catch (cause) {
    if (cause instanceof GroqApiError) {
      throw cause;
    }
    const detail =
      cause instanceof Error && (cause.name === "AbortError" || cause.name === "TimeoutError")
        ? "Groq request timed out after " + timeoutMs + "ms."
        : cause instanceof Error
          ? cause.message
          : "Groq request failed.";
    throw new GroqApiError({ operation: input.operation, detail, cause });
  }
}

export async function listGroqModels(
  settings: Pick<GroqSettings, "apiKey" | "baseUrl">,
  environment?: NodeJS.ProcessEnv | undefined,
  options?: GroqRequestOptions,
): Promise<ReadonlyArray<GroqModel>> {
  const response = await requestGroqJson({
    settings,
    environment,
    operation: "GET /models",
    path: "/models",
    options,
  });
  if (!isRecord(response) || !Array.isArray(response.data)) {
    return [];
  }

  const models: Array<GroqModel> = [];
  for (const entry of response.data) {
    if (!isRecord(entry)) continue;
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (!id) continue;
    models.push({
      id,
      ownedBy: typeof entry.owned_by === "string" ? entry.owned_by.trim() || null : null,
      ...(typeof entry.name === "string" && entry.name.trim().length > 0
        ? { name: entry.name.trim() }
        : {}),
      ...(finitePositiveNumber(entry.context_window ?? entry.context_length) !== undefined
        ? { contextWindow: finitePositiveNumber(entry.context_window ?? entry.context_length)! }
        : {}),
      ...(finitePositiveNumber(entry.max_completion_tokens ?? entry.max_output_length) !== undefined
        ? {
            maxCompletionTokens: finitePositiveNumber(
              entry.max_completion_tokens ?? entry.max_output_length,
            )!,
          }
        : {}),
      ...(stringArray(entry.supported_features) !== undefined
        ? { supportedFeatures: stringArray(entry.supported_features)! }
        : {}),
      ...(stringArray(entry.input_modalities) !== undefined
        ? { inputModalities: stringArray(entry.input_modalities)! }
        : {}),
      ...(stringArray(entry.output_modalities) !== undefined
        ? { outputModalities: stringArray(entry.output_modalities)! }
        : {}),
    });
  }
  return models;
}
