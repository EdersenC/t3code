// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalFetch:off globalFetchInEffect:off runEffectInsideEffect:off
import {
  type LocalModelHubDownload,
  type LocalModelHubDownloadInput,
  type LocalModelHubDownloadResult,
  LocalModelHubError,
  type LocalModelHubModel,
  type LocalModelHubSearchInput,
  type LocalModelHubSearchResult,
  type LocalModelHubSnapshot,
  type LocalModelHubSource,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import * as NodeStreamPromises from "node:stream/promises";
import { expandHomePath } from "../pathExpansion.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";

const HUGGING_FACE_LABEL = "Hugging Face";
const OLLAMA_LABEL = "Ollama";
const DEFAULT_SEARCH_LIMIT = 12;
const MAX_LOG_LINES = 60;
const MAX_DOWNLOAD_RECORDS = 80;

const HUGGING_FACE_DEFAULT_REVISION = "main";

interface ActiveDownload {
  readonly abort: () => void;
  record: LocalModelHubDownload;
}

interface HubPaths {
  readonly modelRoot: string;
  readonly defaultModelRoot: string;
  readonly huggingFaceRoot: string;
  readonly ollamaRoot: string;
}

interface LocalModelSourceAdapter {
  readonly source: LocalModelHubSource;
  readonly label: string;
  readonly rootPath: (paths: HubPaths) => string;
  readonly listLocalModels: (paths: HubPaths) => Promise<ReadonlyArray<LocalModelHubModel>>;
  readonly searchModels: (
    input: LocalModelHubSearchInput,
    paths: HubPaths,
  ) => Promise<LocalModelHubSearchResult>;
}

export interface LocalModelHubService {
  readonly snapshot: Effect.Effect<LocalModelHubSnapshot, LocalModelHubError>;
  readonly search: (
    input: LocalModelHubSearchInput,
  ) => Effect.Effect<LocalModelHubSearchResult, LocalModelHubError>;
  readonly startDownload: (
    input: LocalModelHubDownloadInput,
  ) => Effect.Effect<LocalModelHubDownloadResult, LocalModelHubError>;
  readonly cancelDownload: (input: {
    readonly downloadId: string;
  }) => Effect.Effect<LocalModelHubDownloadResult, LocalModelHubError>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeDetail(cause: unknown): string {
  if (cause instanceof Error && cause.message.trim().length > 0) {
    return cause.message;
  }
  if (typeof cause === "string" && cause.trim().length > 0) {
    return cause;
  }
  return String(cause);
}

function hubError(input: {
  readonly operation: "snapshot" | "search" | "download" | "cancel-download";
  readonly source?: LocalModelHubSource | undefined;
  readonly modelId?: string | undefined;
  readonly detail: string;
  readonly cause?: unknown;
}): LocalModelHubError {
  return new LocalModelHubError(input);
}

function appendLog(record: LocalModelHubDownload, line: string): LocalModelHubDownload {
  const trimmed = line.trim();
  if (trimmed.length === 0) return record;
  return {
    ...record,
    logTail: [...record.logTail, trimmed].slice(-MAX_LOG_LINES),
  };
}

function modelIdPathSegments(modelId: string): ReadonlyArray<string> {
  return modelId
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .map((segment) => {
      const sanitized = segment.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^\.+$/, "-");
      return sanitized.length > 0 ? sanitized : "-";
    });
}

function displayNameFromModelId(modelId: string): string {
  return modelId.split("/").at(-1) || modelId;
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    const stat = await NodeFSP.stat(path);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function directoryHasModelPayload(path: string): Promise<boolean> {
  try {
    const entries = await NodeFSP.readdir(path, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".cache" || entry.name.startsWith(".")) continue;
      if (entry.isFile()) return true;
      if (
        entry.isDirectory() &&
        (await directoryHasModelPayload(NodePath.join(path, entry.name)))
      ) {
        return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

async function removeDirectoryIfEmpty(path: string): Promise<void> {
  try {
    await NodeFSP.rmdir(path);
  } catch {
    // Best-effort cleanup. Parent folders can stay if another download is using them.
  }
}

async function ensureHubDirectories(paths: HubPaths): Promise<void> {
  await Promise.all([
    NodeFSP.mkdir(paths.huggingFaceRoot, { recursive: true }),
    NodeFSP.mkdir(paths.ollamaRoot, { recursive: true }),
  ]);
}

async function listHuggingFaceModels(paths: HubPaths): Promise<ReadonlyArray<LocalModelHubModel>> {
  if (!(await directoryExists(paths.huggingFaceRoot))) return [];
  const models: LocalModelHubModel[] = [];
  const orgEntries = await NodeFSP.readdir(paths.huggingFaceRoot, { withFileTypes: true }).catch(
    () => [],
  );
  for (const orgEntry of orgEntries) {
    if (!orgEntry.isDirectory() || orgEntry.name.startsWith(".")) continue;
    const orgPath = NodePath.join(paths.huggingFaceRoot, orgEntry.name);
    const modelEntries = await NodeFSP.readdir(orgPath, { withFileTypes: true }).catch(() => []);
    for (const modelEntry of modelEntries) {
      if (!modelEntry.isDirectory() || modelEntry.name.startsWith(".")) continue;
      const localPath = NodePath.join(orgPath, modelEntry.name);
      if (!(await directoryHasModelPayload(localPath))) continue;
      const modelId = `${orgEntry.name}/${modelEntry.name}`;
      models.push({
        source: "huggingface",
        modelId,
        displayName: modelEntry.name,
        localPath,
        installed: true,
        format: "unknown",
        metadata: { tags: [], recommendedDownloadPatterns: [] },
      });
    }
  }
  return models.sort((left, right) => left.modelId.localeCompare(right.modelId));
}

interface OllamaTagsResponse {
  readonly models?: ReadonlyArray<{
    readonly name?: unknown;
    readonly model?: unknown;
    readonly size?: unknown;
    readonly modified_at?: unknown;
    readonly details?: {
      readonly family?: unknown;
      readonly parameter_size?: unknown;
      readonly quantization_level?: unknown;
    };
  }>;
}

function resolveOllamaBaseUrl(settings: ServerSettings.ServerSettingsService["Service"]) {
  return settings.getSettings.pipe(
    Effect.map((serverSettings) => serverSettings.providers.ollama.baseUrl.replace(/\/+$/, "")),
  );
}

async function listOllamaModels(baseUrl: string): Promise<ReadonlyArray<LocalModelHubModel>> {
  const response = await fetch(`${baseUrl}/api/tags`);
  if (!response.ok) {
    throw new Error(`Ollama /api/tags returned ${response.status} ${response.statusText}`);
  }
  const payload = (await response.json()) as OllamaTagsResponse;
  return (payload.models ?? [])
    .map((model): LocalModelHubModel | null => {
      const modelId =
        typeof model.name === "string"
          ? model.name
          : typeof model.model === "string"
            ? model.model
            : "";
      if (modelId.length === 0) return null;
      return {
        source: "ollama",
        modelId,
        displayName: displayNameFromModelId(modelId),
        localPath: `ollama:${modelId}`,
        installed: true,
        format: "ollama",
        ...(typeof model.size === "number" ? { sizeBytes: model.size } : {}),
        metadata: {
          tags: modelId.includes(":cloud") || modelId.endsWith("-cloud") ? ["cloud"] : ["local"],
          recommendedDownloadPatterns: [],
          ...(typeof model.details?.parameter_size === "string"
            ? { parameterCount: model.details.parameter_size }
            : {}),
          ...(typeof model.details?.quantization_level === "string"
            ? { quantization: model.details.quantization_level }
            : {}),
          ...(typeof model.details?.family === "string"
            ? { architecture: model.details.family }
            : {}),
          ...(typeof model.modified_at === "string" ? { updatedAt: model.modified_at } : {}),
        },
      };
    })
    .filter((model): model is LocalModelHubModel => model !== null)
    .sort((left, right) => left.modelId.localeCompare(right.modelId));
}

function makePaths(config: ServerConfig.ServerConfig["Service"], configuredRoot: string): HubPaths {
  const defaultModelRoot = NodePath.join(config.stateDir, "models");
  const expanded = configuredRoot.trim().length > 0 ? expandHomePath(configuredRoot.trim()) : "";
  const modelRoot =
    expanded.length === 0
      ? defaultModelRoot
      : NodePath.isAbsolute(expanded)
        ? expanded
        : NodePath.resolve(config.cwd, expanded);
  return {
    modelRoot,
    defaultModelRoot,
    huggingFaceRoot: NodePath.join(modelRoot, "huggingface"),
    ollamaRoot: NodePath.join(modelRoot, "ollama"),
  };
}

function makeHuggingFaceTargetPath(paths: HubPaths, modelId: string): string {
  const targetPath = NodePath.resolve(paths.huggingFaceRoot, ...modelIdPathSegments(modelId));
  const relativePath = NodePath.relative(paths.huggingFaceRoot, targetPath);
  if (relativePath.startsWith("..") || NodePath.isAbsolute(relativePath)) {
    throw new Error(`Model id '${modelId}' resolves outside the Hugging Face source folder.`);
  }
  return targetPath;
}

interface HuggingFaceApiModel {
  readonly id?: unknown;
  readonly modelId?: unknown;
  readonly tags?: unknown;
  readonly downloads?: unknown;
  readonly likes?: unknown;
  readonly lastModified?: unknown;
  readonly pipeline_tag?: unknown;
  readonly usedStorage?: unknown;
  readonly siblings?: unknown;
  readonly safetensors?: unknown;
  readonly config?: {
    readonly architectures?: unknown;
    readonly model_type?: unknown;
    readonly quantization_config?: {
      readonly bits?: unknown;
      readonly quant_method?: unknown;
    };
  };
}

interface HuggingFaceModelFile {
  readonly rfilename?: unknown;
  readonly size?: unknown;
}

function isHuggingFaceModelFile(value: unknown): value is HuggingFaceModelFile {
  return typeof value === "object" && value !== null;
}

interface HuggingFaceModelInfo {
  readonly siblings?: ReadonlyArray<HuggingFaceModelFile>;
}

interface HuggingFaceSnapshotDownloadInput {
  readonly modelId: string;
  readonly targetPath: string;
  readonly revision?: string | undefined;
  readonly includePatterns?: ReadonlyArray<string> | undefined;
  readonly excludePatterns?: ReadonlyArray<string> | undefined;
  readonly token?: string | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly onLog?: (line: string) => void;
}

function huggingFaceHeaders(token: string | undefined): Record<string, string> {
  return token && token.length > 0 ? { Authorization: `Bearer ${token}` } : {};
}

function huggingFaceModelApiUrl(modelId: string): string {
  return `https://huggingface.co/api/models/${modelId
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")}`;
}

function huggingFaceResolveUrl(input: {
  readonly modelId: string;
  readonly revision: string;
  readonly filename: string;
}): string {
  return `https://huggingface.co/${input.modelId
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")}/resolve/${encodeURIComponent(input.revision)}/${input.filename
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")}`;
}

async function writeResponseBodyToFile(response: Response, targetPath: string): Promise<void> {
  if (!response.body) {
    throw new Error("Hugging Face returned an empty response body.");
  }
  await NodeFSP.mkdir(NodePath.dirname(targetPath), { recursive: true });
  await NodeStreamPromises.pipeline(
    NodeStream.Readable.fromWeb(response.body),
    NodeFS.createWriteStream(targetPath),
  );
}

async function fileSize(path: string): Promise<number | null> {
  try {
    const stat = await NodeFSP.stat(path);
    return stat.isFile() ? stat.size : null;
  } catch {
    return null;
  }
}

function normalizeHuggingFaceFilename(filename: string): string {
  return filename
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .map((segment) => {
      const sanitized = segment.replace(/[^a-zA-Z0-9._ -]/g, "-").replace(/^\.+$/, "-");
      return sanitized.length > 0 ? sanitized : "-";
    })
    .join("/");
}

function wildcardPatternToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .trim()
    .replace(/[|\\{}()[\]^$+?.]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

function matchesAnyPattern(filename: string, patterns: ReadonlyArray<string>): boolean {
  return patterns.some((pattern) => wildcardPatternToRegExp(pattern).test(filename));
}

function filterHuggingFaceFiles(
  files: ReadonlyArray<{ readonly filename: string; readonly size?: number | undefined }>,
  input: {
    readonly includePatterns?: ReadonlyArray<string> | undefined;
    readonly excludePatterns?: ReadonlyArray<string> | undefined;
  },
): ReadonlyArray<{ readonly filename: string; readonly size?: number | undefined }> {
  const includePatterns =
    input.includePatterns?.filter((pattern) => pattern.trim().length > 0) ?? [];
  const excludePatterns =
    input.excludePatterns?.filter((pattern) => pattern.trim().length > 0) ?? [];
  return files.filter((file) => {
    if (includePatterns.length > 0 && !matchesAnyPattern(file.filename, includePatterns)) {
      return false;
    }
    if (excludePatterns.length > 0 && matchesAnyPattern(file.filename, excludePatterns)) {
      return false;
    }
    return true;
  });
}

function formatParameterCount(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1).replace(/\.0$/, "")}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(value);
}

function parseSafetensorsMetadata(value: unknown): {
  readonly parameterCount?: string | undefined;
  readonly rawParameterCount?: number | undefined;
} {
  if (value === null || typeof value !== "object") return {};
  const total = (value as { readonly total?: unknown }).total;
  if (typeof total !== "number") return {};
  return { parameterCount: formatParameterCount(total), rawParameterCount: total };
}

function inferFormatFromFilesAndTags(input: {
  readonly files: ReadonlyArray<string>;
  readonly lowerTags: ReadonlyArray<string>;
}): LocalModelHubModel["format"] {
  if (
    input.lowerTags.some((tag) => tag.includes("gguf")) ||
    input.files.some((file) => file.toLowerCase().endsWith(".gguf"))
  ) {
    return "gguf";
  }
  if (
    input.lowerTags.some((tag) => tag.includes("safetensors")) ||
    input.files.some((file) => file.toLowerCase().endsWith(".safetensors"))
  ) {
    return "safetensors";
  }
  return "unknown";
}

function inferQuantization(input: {
  readonly lowerTags: ReadonlyArray<string>;
  readonly filenames: ReadonlyArray<string>;
  readonly config?: HuggingFaceApiModel["config"] | undefined;
}): string | undefined {
  const bits = input.config?.quantization_config?.bits;
  const method = input.config?.quantization_config?.quant_method;
  if (typeof bits === "number") {
    return `${bits}-bit${typeof method === "string" ? ` ${method.toUpperCase()}` : ""}`;
  }
  const candidates = [...input.lowerTags, ...input.filenames.map((name) => name.toLowerCase())];
  const quantPatterns: ReadonlyArray<readonly [RegExp, string]> = [
    [/(?:^|[-_])q2(?:[-_]|$)|2-bit/, "2-bit"],
    [/(?:^|[-_])q3(?:[-_]|$)|3-bit/, "3-bit"],
    [/(?:^|[-_])q4(?:[-_]|$)|4-bit|int4|nf4/, "4-bit"],
    [/(?:^|[-_])q5(?:[-_]|$)|5-bit/, "5-bit"],
    [/(?:^|[-_])q6(?:[-_]|$)|6-bit/, "6-bit"],
    [/(?:^|[-_])q8(?:[-_]|$)|8-bit|int8/, "8-bit"],
    [/fp16|float16|16-bit|bf16/, "16-bit"],
  ];
  for (const [pattern, label] of quantPatterns) {
    if (candidates.some((candidate) => pattern.test(candidate))) return label;
  }
  return undefined;
}

function recommendedDownloadPatterns(input: {
  readonly files: ReadonlyArray<string>;
  readonly lowerTags: ReadonlyArray<string>;
}): ReadonlyArray<string> {
  const patterns = new Set<string>();
  if (
    input.lowerTags.some((tag) => tag.includes("safetensors")) ||
    input.files.some((file) => file.toLowerCase().endsWith(".safetensors"))
  ) {
    patterns.add("*.safetensors");
  }
  if (
    input.lowerTags.some((tag) => tag.includes("gguf")) ||
    input.files.some((file) => file.toLowerCase().endsWith(".gguf"))
  ) {
    patterns.add("*.gguf");
  }
  if (input.lowerTags.some((tag) => tag.includes("awq"))) patterns.add("*awq*");
  if (input.lowerTags.some((tag) => tag.includes("gptq"))) patterns.add("*gptq*");
  if (input.lowerTags.some((tag) => tag.includes("4-bit") || tag.includes("int4"))) {
    patterns.add("*q4*");
    patterns.add("*int4*");
    patterns.add("*4-bit*");
  }
  if (input.lowerTags.some((tag) => tag.includes("8-bit") || tag.includes("int8"))) {
    patterns.add("*q8*");
    patterns.add("*int8*");
    patterns.add("*8-bit*");
  }
  return [...patterns];
}

export async function downloadHuggingFaceModelSnapshot(
  input: HuggingFaceSnapshotDownloadInput,
): Promise<void> {
  const revision = input.revision?.trim() || HUGGING_FACE_DEFAULT_REVISION;
  const infoResponse = await fetch(huggingFaceModelApiUrl(input.modelId), {
    headers: huggingFaceHeaders(input.token),
    signal: input.signal ?? null,
  });
  if (!infoResponse.ok) {
    throw new Error(
      `Hugging Face model metadata returned ${infoResponse.status} ${infoResponse.statusText}.`,
    );
  }
  const info = (await infoResponse.json()) as HuggingFaceModelInfo;
  const allFiles =
    info.siblings
      ?.map((file) => ({
        filename: typeof file.rfilename === "string" ? file.rfilename : "",
        size: typeof file.size === "number" ? file.size : undefined,
      }))
      .filter((file) => file.filename.length > 0 && !file.filename.startsWith("."))
      .sort((left, right) => left.filename.localeCompare(right.filename)) ?? [];
  const files = filterHuggingFaceFiles(allFiles, input);
  if (files.length === 0) {
    throw new Error(
      allFiles.length === 0
        ? "Hugging Face model metadata did not include downloadable files."
        : "No Hugging Face files matched the selected download filters.",
    );
  }
  input.onLog?.(
    `Resolved ${files.length} of ${allFiles.length} file(s) for ${input.modelId}@${revision}.`,
  );
  for (const file of files) {
    const relativePath = normalizeHuggingFaceFilename(file.filename);
    const targetFilePath = NodePath.resolve(input.targetPath, relativePath);
    const targetRelativePath = NodePath.relative(input.targetPath, targetFilePath);
    if (targetRelativePath.startsWith("..") || NodePath.isAbsolute(targetRelativePath)) {
      throw new Error(`Hugging Face file '${file.filename}' resolves outside the target folder.`);
    }
    const existingSize = await fileSize(targetFilePath);
    if (file.size !== undefined && existingSize === file.size) {
      input.onLog?.(`Skipped ${file.filename}; file already exists.`);
      continue;
    }
    input.onLog?.(`Downloading ${file.filename}${file.size ? ` (${file.size} bytes)` : ""}.`);
    const response = await fetch(
      huggingFaceResolveUrl({
        modelId: input.modelId,
        revision,
        filename: file.filename,
      }),
      { headers: huggingFaceHeaders(input.token), signal: input.signal ?? null },
    );
    if (!response.ok) {
      throw new Error(
        `Hugging Face file '${file.filename}' returned ${response.status} ${response.statusText}.`,
      );
    }
    await writeResponseBodyToFile(response, targetFilePath);
  }
}

function mapHuggingFaceApiModel(
  raw: HuggingFaceApiModel,
  paths: HubPaths,
  installedIds: ReadonlySet<string>,
): LocalModelHubModel | null {
  const modelId =
    typeof raw.id === "string" ? raw.id : typeof raw.modelId === "string" ? raw.modelId : "";
  if (modelId.length === 0) return null;
  const tags = Array.isArray(raw.tags)
    ? raw.tags.filter((tag): tag is string => typeof tag === "string")
    : [];
  const lowerTags = tags.map((tag) => tag.toLowerCase());
  const files = Array.isArray(raw.siblings)
    ? raw.siblings
        .filter(isHuggingFaceModelFile)
        .map((file) => (typeof file.rfilename === "string" ? file.rfilename : ""))
        .filter((file): file is string => file.length > 0)
    : [];
  const format = inferFormatFromFilesAndTags({ files, lowerTags });
  const safetensors = parseSafetensorsMetadata(raw.safetensors);
  const quantization = inferQuantization({ lowerTags, filenames: files, config: raw.config });
  const architecture = Array.isArray(raw.config?.architectures)
    ? raw.config.architectures.find((value): value is string => typeof value === "string")
    : typeof raw.config?.model_type === "string"
      ? raw.config.model_type
      : undefined;
  return {
    source: "huggingface",
    modelId,
    displayName: displayNameFromModelId(modelId),
    localPath: makeHuggingFaceTargetPath(paths, modelId),
    installed: installedIds.has(modelId),
    format,
    ...(typeof raw.usedStorage === "number" ? { sizeBytes: raw.usedStorage } : {}),
    metadata: {
      tags,
      ...(typeof raw.usedStorage === "number" ? { totalSizeBytes: raw.usedStorage } : {}),
      ...(files.length > 0 ? { fileCount: files.length } : {}),
      ...(safetensors.parameterCount ? { parameterCount: safetensors.parameterCount } : {}),
      ...(quantization ? { quantization } : {}),
      ...(architecture ? { architecture } : {}),
      recommendedDownloadPatterns: recommendedDownloadPatterns({ files, lowerTags }),
      ...(typeof raw.downloads === "number" ? { downloads: raw.downloads } : {}),
      ...(typeof raw.likes === "number" ? { likes: raw.likes } : {}),
      ...(typeof raw.lastModified === "string" ? { updatedAt: raw.lastModified } : {}),
      ...(typeof raw.pipeline_tag === "string" ? { description: raw.pipeline_tag } : {}),
    },
  };
}

async function fetchHuggingFaceModelDetail(modelId: string): Promise<HuggingFaceApiModel | null> {
  const response = await fetch(huggingFaceModelApiUrl(modelId), {
    headers: huggingFaceHeaders(process.env.HF_TOKEN),
  });
  if (!response.ok) return null;
  return (await response.json()) as HuggingFaceApiModel;
}

function makeDownloadRecord(input: {
  readonly source: LocalModelHubSource;
  readonly modelId: string;
  readonly status?: LocalModelHubDownload["status"];
  readonly targetPath: string;
  readonly detail?: string;
}): LocalModelHubDownload {
  const timestamp = nowIso();
  return {
    downloadId: NodeCrypto.randomUUID(),
    source: input.source,
    modelId: input.modelId,
    status: input.status ?? "running",
    targetPath: input.targetPath,
    startedAt: timestamp,
    ...(input.status === "completed" ? { completedAt: timestamp } : {}),
    ...(input.detail ? { detail: input.detail } : {}),
    logTail: [],
  };
}

function downloadKey(source: LocalModelHubSource, modelId: string): string {
  return `${source}:${modelId}`;
}

function isTerminalDownloadStatus(status: LocalModelHubDownload["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export function makeLocalModelHub(input: {
  readonly config: ServerConfig.ServerConfig["Service"];
  readonly serverSettings: ServerSettings.ServerSettingsService["Service"];
}): LocalModelHubService {
  const { config, serverSettings } = input;
  const downloads = new Map<string, ActiveDownload>();
  const downloadsByKey = new Map<string, string>();

  const pruneDownloadRecords = () => {
    const terminalRecords = [...downloads.entries()].filter(([, active]) =>
      isTerminalDownloadStatus(active.record.status),
    );
    const overflow = terminalRecords.length - MAX_DOWNLOAD_RECORDS;
    if (overflow <= 0) return;
    terminalRecords
      .sort(
        ([, left], [, right]) =>
          new Date(left.record.startedAt).getTime() - new Date(right.record.startedAt).getTime(),
      )
      .slice(0, overflow)
      .forEach(([downloadId, active]) => {
        downloads.delete(downloadId);
        downloadsByKey.delete(downloadKey(active.record.source, active.record.modelId));
      });
  };

  const resolvePaths = serverSettings.getSettings.pipe(
    Effect.map((settings) => makePaths(config, settings.localModelHub.modelRoot)),
  );

  const sourceOrder: ReadonlyArray<LocalModelHubSource> = ["huggingface", "ollama"];

  const sourceAdapters: Record<LocalModelHubSource, LocalModelSourceAdapter> = {
    huggingface: {
      source: "huggingface",
      label: HUGGING_FACE_LABEL,
      rootPath: (paths) => paths.huggingFaceRoot,
      listLocalModels: listHuggingFaceModels,
      searchModels: async (searchInput, paths) => {
        const installed = await listHuggingFaceModels(paths);
        const installedIds = new Set(installed.map((model) => model.modelId));
        const url = new URL("https://huggingface.co/api/models");
        url.searchParams.set("search", searchInput.query);
        url.searchParams.set("limit", String(searchInput.limit ?? DEFAULT_SEARCH_LIMIT));
        url.searchParams.set("sort", "downloads");
        url.searchParams.set("direction", "-1");
        const response = await fetch(url, {
          headers: process.env.HF_TOKEN ? { Authorization: `Bearer ${process.env.HF_TOKEN}` } : {},
        });
        if (!response.ok) {
          throw new Error(`Hugging Face search returned ${response.status} ${response.statusText}`);
        }
        const payload = (await response.json()) as unknown;
        const remoteModels = Array.isArray(payload)
          ? (
              await Promise.all(
                payload.map(async (raw) => {
                  const base = raw as HuggingFaceApiModel;
                  const modelId =
                    typeof base.id === "string"
                      ? base.id
                      : typeof base.modelId === "string"
                        ? base.modelId
                        : "";
                  const detail =
                    modelId.length > 0 ? await fetchHuggingFaceModelDetail(modelId) : null;
                  return mapHuggingFaceApiModel(detail ?? base, paths, installedIds);
                }),
              )
            ).filter((model): model is LocalModelHubModel => model !== null)
          : [];
        return {
          source: searchInput.source,
          query: searchInput.query,
          models: remoteModels,
        };
      },
    },
    ollama: {
      source: "ollama",
      label: OLLAMA_LABEL,
      rootPath: (paths) => paths.ollamaRoot,
      listLocalModels: async () =>
        listOllamaModels(await Effect.runPromise(resolveOllamaBaseUrl(serverSettings))),
      searchModels: async (searchInput) => {
        const localModels = await listOllamaModels(
          await Effect.runPromise(resolveOllamaBaseUrl(serverSettings)),
        );
        const query = searchInput.query.toLowerCase();
        const matched = localModels.filter((model) => model.modelId.toLowerCase().includes(query));
        const exactInstalled = localModels.some((model) => model.modelId === searchInput.query);
        const candidate: LocalModelHubModel[] =
          exactInstalled || searchInput.query.length === 0
            ? []
            : [
                {
                  source: "ollama",
                  modelId: searchInput.query,
                  displayName: displayNameFromModelId(searchInput.query),
                  installed: false,
                  format: "ollama",
                  metadata: { tags: [], recommendedDownloadPatterns: [] },
                },
              ];
        return {
          source: searchInput.source,
          query: searchInput.query,
          models: [...matched, ...candidate].slice(0, searchInput.limit ?? DEFAULT_SEARCH_LIMIT),
        };
      },
    },
  };

  const startHuggingFaceDownload = (input: LocalModelHubDownloadInput, paths: HubPaths) => {
    const targetPath = makeHuggingFaceTargetPath(paths, input.modelId);
    return Effect.tryPromise({
      try: async () => {
        await NodeFSP.mkdir(targetPath, { recursive: true });

        const record = makeDownloadRecord({
          source: "huggingface",
          modelId: input.modelId,
          targetPath,
        });
        const abortController = new AbortController();
        const active: ActiveDownload = {
          record,
          abort: () => abortController.abort(),
        };
        downloads.set(record.downloadId, active);
        downloadsByKey.set(downloadKey(input.source, input.modelId), record.downloadId);
        pruneDownloadRecords();
        void (async () => {
          try {
            await downloadHuggingFaceModelSnapshot({
              modelId: input.modelId,
              targetPath,
              revision: input.revision,
              includePatterns: input.includePatterns,
              excludePatterns: input.excludePatterns,
              token: process.env.HF_TOKEN,
              signal: abortController.signal,
              onLog: (line) => {
                active.record = appendLog(active.record, line);
              },
            });
            if (abortController.signal.aborted) {
              active.record = {
                ...active.record,
                status: "cancelled",
                completedAt: nowIso(),
                detail: "Download cancelled.",
              };
              return;
            }
            active.record = {
              ...active.record,
              status: "completed",
              completedAt: nowIso(),
              detail: "Download completed.",
            };
          } catch (cause) {
            active.record = {
              ...appendLog(active.record, normalizeDetail(cause)),
              status: abortController.signal.aborted ? "cancelled" : "failed",
              completedAt: nowIso(),
              detail: abortController.signal.aborted
                ? "Download cancelled."
                : normalizeDetail(cause),
            };
            if (!(await directoryHasModelPayload(targetPath))) {
              await removeDirectoryIfEmpty(targetPath);
            }
          } finally {
            downloadsByKey.delete(downloadKey(input.source, input.modelId));
            pruneDownloadRecords();
          }
        })();
        return { download: record };
      },
      catch: (cause) =>
        hubError({
          operation: "download",
          source: "huggingface",
          modelId: input.modelId,
          detail: normalizeDetail(cause),
          cause,
        }),
    });
  };

  const startOllamaDownload = (input: LocalModelHubDownloadInput) =>
    Effect.tryPromise({
      try: async () => {
        const baseUrl = await Effect.runPromise(resolveOllamaBaseUrl(serverSettings));
        const record = makeDownloadRecord({
          source: "ollama",
          modelId: input.modelId,
          targetPath: `ollama:${input.modelId}`,
        });
        const abortController = new AbortController();
        const active: ActiveDownload = {
          record,
          abort: () => abortController.abort(),
        };
        downloads.set(record.downloadId, active);
        downloadsByKey.set(downloadKey(input.source, input.modelId), record.downloadId);
        pruneDownloadRecords();
        void (async () => {
          try {
            const response = await fetch(`${baseUrl}/api/pull`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ name: input.modelId, stream: true }),
              signal: abortController.signal,
            });
            if (!response.ok) {
              throw new Error(
                `Ollama /api/pull returned ${response.status} ${response.statusText}`,
              );
            }
            const reader = response.body?.getReader();
            if (!reader) {
              throw new Error("Ollama /api/pull did not return a readable stream.");
            }
            const decoder = new TextDecoder();
            let buffered = "";
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              buffered += decoder.decode(value, { stream: true });
              const lines = buffered.split(/\r?\n/);
              buffered = lines.pop() ?? "";
              for (const line of lines) {
                if (line.trim().length === 0) continue;
                active.record = appendLog(active.record, line);
                try {
                  const event = JSON.parse(line) as {
                    readonly status?: unknown;
                    readonly completed?: unknown;
                    readonly total?: unknown;
                    readonly error?: unknown;
                  };
                  if (typeof event.error === "string") {
                    throw new Error(event.error);
                  }
                  if (typeof event.status === "string") {
                    active.record = { ...active.record, progress: event.status };
                  }
                  if (typeof event.completed === "number" && typeof event.total === "number") {
                    active.record = {
                      ...active.record,
                      progress: `${event.completed}/${event.total} bytes`,
                    };
                  }
                } catch (cause) {
                  if (cause instanceof SyntaxError) continue;
                  throw cause;
                }
              }
            }
            if (buffered.trim().length > 0) {
              const line = buffered.trim();
              active.record = appendLog(active.record, line);
              try {
                const event = JSON.parse(line) as {
                  readonly status?: unknown;
                  readonly completed?: unknown;
                  readonly total?: unknown;
                  readonly error?: unknown;
                };
                if (typeof event.error === "string") {
                  throw new Error(event.error);
                }
                if (typeof event.status === "string") {
                  active.record = { ...active.record, progress: event.status };
                }
                if (typeof event.completed === "number" && typeof event.total === "number") {
                  active.record = {
                    ...active.record,
                    progress: `${event.completed}/${event.total} bytes`,
                  };
                }
              } catch (cause) {
                if (!(cause instanceof SyntaxError)) throw cause;
              }
            }
            active.record = {
              ...active.record,
              status: "completed",
              completedAt: nowIso(),
              detail: "Pull completed.",
            };
          } catch (cause) {
            active.record = {
              ...appendLog(active.record, normalizeDetail(cause)),
              status: abortController.signal.aborted ? "cancelled" : "failed",
              completedAt: nowIso(),
              detail: abortController.signal.aborted ? "Pull cancelled." : normalizeDetail(cause),
            };
          } finally {
            downloadsByKey.delete(downloadKey(input.source, input.modelId));
            pruneDownloadRecords();
          }
        })();
        return { download: record };
      },
      catch: (cause) =>
        hubError({
          operation: "download",
          source: "ollama",
          modelId: input.modelId,
          detail: normalizeDetail(cause),
          cause,
        }),
    });

  const startDownload: LocalModelHubService["startDownload"] = (input) =>
    Effect.gen(function* () {
      const paths = yield* resolvePaths.pipe(
        Effect.mapError((cause) =>
          hubError({
            operation: "download",
            source: input.source,
            modelId: input.modelId,
            detail: normalizeDetail(cause),
            cause,
          }),
        ),
      );
      yield* Effect.tryPromise({
        try: () => ensureHubDirectories(paths),
        catch: (cause) =>
          hubError({
            operation: "download",
            source: input.source,
            modelId: input.modelId,
            detail: normalizeDetail(cause),
            cause,
          }),
      });
      const key = downloadKey(input.source, input.modelId);
      const activeId = downloadsByKey.get(key);
      if (activeId) {
        const active = downloads.get(activeId);
        if (active && (active.record.status === "queued" || active.record.status === "running")) {
          return { download: active.record };
        }
        downloadsByKey.delete(key);
      }
      return yield* input.source === "huggingface"
        ? startHuggingFaceDownload(input, paths)
        : startOllamaDownload(input);
    });

  const cancelDownload: LocalModelHubService["cancelDownload"] = (input) =>
    Effect.try({
      try: () => {
        const active = downloads.get(input.downloadId);
        if (!active) {
          throw new Error(`Unknown download id: ${input.downloadId}`);
        }
        if (active.record.status !== "running" && active.record.status !== "queued") {
          return { download: active.record };
        }
        active.record = {
          ...active.record,
          status: "cancelled",
          completedAt: nowIso(),
          detail: "Download cancelled.",
        };
        active.abort();
        downloadsByKey.delete(downloadKey(active.record.source, active.record.modelId));
        return { download: active.record };
      },
      catch: (cause) =>
        hubError({
          operation: "cancel-download",
          detail: normalizeDetail(cause),
          cause,
        }),
    });

  const snapshot: LocalModelHubService["snapshot"] = Effect.tryPromise({
    try: async () => {
      const paths = await Effect.runPromise(resolvePaths);
      await ensureHubDirectories(paths);
      const sourceSnapshots = await Promise.all(
        sourceOrder.map(async (source) => {
          const adapter = sourceAdapters[source];
          let models: ReadonlyArray<LocalModelHubModel> = [];
          let status: "ready" | "unavailable" = "ready";
          let detail: string | undefined;
          try {
            models = await adapter.listLocalModels(paths);
          } catch (cause) {
            status = "unavailable";
            detail = normalizeDetail(cause);
          }
          return {
            descriptor: {
              source: adapter.source,
              label: adapter.label,
              status,
              rootPath: adapter.rootPath(paths),
              ...(detail ? { detail } : {}),
            },
            models,
          };
        }),
      );
      return {
        modelRoot: paths.modelRoot,
        defaultModelRoot: paths.defaultModelRoot,
        sources: sourceSnapshots.map((entry) => entry.descriptor),
        models: sourceSnapshots.flatMap((entry) => entry.models),
        downloads: [...downloads.values()].map((entry) => entry.record),
      } satisfies LocalModelHubSnapshot;
    },
    catch: (cause) =>
      hubError({
        operation: "snapshot",
        detail: normalizeDetail(cause),
        cause,
      }),
  });

  const search: LocalModelHubService["search"] = (input) =>
    Effect.tryPromise({
      try: async () => {
        const paths = await Effect.runPromise(resolvePaths);
        await ensureHubDirectories(paths);
        return sourceAdapters[input.source].searchModels(input, paths);
      },
      catch: (cause) =>
        hubError({
          operation: "search",
          source: input.source,
          detail: normalizeDetail(cause),
          cause,
        }),
    });

  return {
    snapshot,
    search,
    startDownload,
    cancelDownload,
  };
}
