import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  NonNegativeInt,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas.ts";

export const LocalModelHubSource = Schema.Literals(["huggingface", "ollama"]);
export type LocalModelHubSource = typeof LocalModelHubSource.Type;

export const LocalModelHubRuntime = Schema.Literals([
  "vllm",
  "ollama",
  "llamacpp",
  "tgi",
  "sglang",
  "custom",
]);
export type LocalModelHubRuntime = typeof LocalModelHubRuntime.Type;

export const LocalModelHubDownloadStatus = Schema.Literals([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
]);
export type LocalModelHubDownloadStatus = typeof LocalModelHubDownloadStatus.Type;

export const LocalModelHubSourceStatus = Schema.Literals([
  "ready",
  "unavailable",
  "partial",
  "planned",
]);
export type LocalModelHubSourceStatus = typeof LocalModelHubSourceStatus.Type;

export const LocalModelHubModelFormat = Schema.Literals([
  "safetensors",
  "gguf",
  "ollama",
  "unknown",
]);
export type LocalModelHubModelFormat = typeof LocalModelHubModelFormat.Type;

export const LocalModelHubSourceDescriptor = Schema.Struct({
  source: LocalModelHubSource,
  label: TrimmedNonEmptyString,
  status: LocalModelHubSourceStatus,
  rootPath: Schema.optional(TrimmedString),
  detail: Schema.optional(TrimmedString),
});
export type LocalModelHubSourceDescriptor = typeof LocalModelHubSourceDescriptor.Type;

export const LocalModelHubModelMetadata = Schema.Struct({
  parameterCount: Schema.optional(TrimmedString),
  quantization: Schema.optional(TrimmedString),
  architecture: Schema.optional(TrimmedString),
  contextLength: Schema.optional(NonNegativeInt),
  tags: Schema.Array(TrimmedString).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  downloads: Schema.optional(NonNegativeInt),
  likes: Schema.optional(NonNegativeInt),
  updatedAt: Schema.optional(IsoDateTime),
  description: Schema.optional(TrimmedString),
});
export type LocalModelHubModelMetadata = typeof LocalModelHubModelMetadata.Type;

export const LocalModelHubModel = Schema.Struct({
  source: LocalModelHubSource,
  modelId: TrimmedNonEmptyString,
  displayName: TrimmedNonEmptyString,
  localPath: Schema.optional(TrimmedString),
  installed: Schema.Boolean,
  format: LocalModelHubModelFormat,
  sizeBytes: Schema.optional(NonNegativeInt),
  metadata: LocalModelHubModelMetadata.pipe(
    Schema.withDecodingDefault(Effect.succeed({ tags: [] })),
  ),
});
export type LocalModelHubModel = typeof LocalModelHubModel.Type;

export const LocalModelHubSearchInput = Schema.Struct({
  source: LocalModelHubSource,
  query: TrimmedNonEmptyString,
  limit: Schema.optional(NonNegativeInt),
});
export type LocalModelHubSearchInput = typeof LocalModelHubSearchInput.Type;

export const LocalModelHubSearchResult = Schema.Struct({
  source: LocalModelHubSource,
  query: TrimmedNonEmptyString,
  models: Schema.Array(LocalModelHubModel),
});
export type LocalModelHubSearchResult = typeof LocalModelHubSearchResult.Type;

export const LocalModelHubDownloadInput = Schema.Struct({
  source: LocalModelHubSource,
  modelId: TrimmedNonEmptyString,
  revision: Schema.optional(TrimmedString),
});
export type LocalModelHubDownloadInput = typeof LocalModelHubDownloadInput.Type;

export const LocalModelHubCancelDownloadInput = Schema.Struct({
  downloadId: TrimmedNonEmptyString,
});
export type LocalModelHubCancelDownloadInput = typeof LocalModelHubCancelDownloadInput.Type;

export const LocalModelHubDownload = Schema.Struct({
  downloadId: TrimmedNonEmptyString,
  source: LocalModelHubSource,
  modelId: TrimmedNonEmptyString,
  status: LocalModelHubDownloadStatus,
  targetPath: TrimmedString,
  startedAt: IsoDateTime,
  completedAt: Schema.optional(IsoDateTime),
  progress: Schema.optional(TrimmedString),
  detail: Schema.optional(TrimmedString),
  logTail: Schema.Array(TrimmedString).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type LocalModelHubDownload = typeof LocalModelHubDownload.Type;

export const LocalModelHubDownloadResult = Schema.Struct({
  download: LocalModelHubDownload,
});
export type LocalModelHubDownloadResult = typeof LocalModelHubDownloadResult.Type;

export const LocalModelHubSnapshot = Schema.Struct({
  modelRoot: TrimmedNonEmptyString,
  defaultModelRoot: TrimmedNonEmptyString,
  sources: Schema.Array(LocalModelHubSourceDescriptor),
  models: Schema.Array(LocalModelHubModel),
  downloads: Schema.Array(LocalModelHubDownload),
});
export type LocalModelHubSnapshot = typeof LocalModelHubSnapshot.Type;

export const LocalModelHubOperation = Schema.Literals([
  "snapshot",
  "search",
  "download",
  "cancel-download",
]);
export type LocalModelHubOperation = typeof LocalModelHubOperation.Type;

export class LocalModelHubError extends Schema.TaggedErrorClass<LocalModelHubError>()(
  "LocalModelHubError",
  {
    operation: LocalModelHubOperation,
    source: Schema.optional(LocalModelHubSource),
    modelId: Schema.optional(Schema.String),
    detail: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const source = this.source === undefined ? "" : ` for ${this.source}`;
    const model = this.modelId === undefined ? "" : ` model '${this.modelId}'`;
    return `Local model hub ${this.operation} failed${source}${model}. Details: ${this.detail}`;
  }
}
