import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { EventId, MessageId, ThreadId, TrimmedNonEmptyString, TurnId } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

export const T3CapabilityKind = Schema.Literals(["skill", "slash-command", "subagent", "tool"]);
export type T3CapabilityKind = typeof T3CapabilityKind.Type;

export const T3CapabilityActivation = Schema.Literals([
  "preload",
  "on-demand",
  "command",
  "hidden",
]);
export type T3CapabilityActivation = typeof T3CapabilityActivation.Type;

export const T3CapabilitySource = Schema.Literals(["t3", "provider-native", "harness-native"]);
export type T3CapabilitySource = typeof T3CapabilitySource.Type;

export const T3CapabilityId = TrimmedNonEmptyString;
export type T3CapabilityId = typeof T3CapabilityId.Type;

export const T3CapabilityOverride = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  activation: Schema.optionalKey(T3CapabilityActivation),
});
export type T3CapabilityOverride = typeof T3CapabilityOverride.Type;

export const T3CapabilityRegistrySettings = Schema.Struct({
  skillRoots: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  overrides: Schema.Record(T3CapabilityId, T3CapabilityOverride).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
});
export type T3CapabilityRegistrySettings = typeof T3CapabilityRegistrySettings.Type;

export const T3CapabilityRegistrySettingsPatch = Schema.Struct({
  skillRoots: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
  overrides: Schema.optionalKey(Schema.Record(T3CapabilityId, T3CapabilityOverride)),
});
export type T3CapabilityRegistrySettingsPatch = typeof T3CapabilityRegistrySettingsPatch.Type;

export const T3CapabilitySnapshotEntry = Schema.Struct({
  id: T3CapabilityId,
  name: TrimmedNonEmptyString,
  kind: T3CapabilityKind,
  activation: T3CapabilityActivation,
  source: T3CapabilitySource,
  enabled: Schema.Boolean,
  readonly: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  displayName: Schema.optional(TrimmedNonEmptyString),
  description: Schema.optional(TrimmedNonEmptyString),
  shortDescription: Schema.optional(TrimmedNonEmptyString),
  path: Schema.optional(TrimmedNonEmptyString),
  sourceDetail: Schema.optional(TrimmedNonEmptyString),
  commandName: Schema.optional(TrimmedNonEmptyString),
  toolName: Schema.optional(TrimmedNonEmptyString),
  providerInstanceId: Schema.optional(ProviderInstanceId),
  provider: Schema.optional(ProviderDriverKind),
  providerDisplayName: Schema.optional(TrimmedNonEmptyString),
  harnessName: Schema.optional(TrimmedNonEmptyString),
});
export type T3CapabilitySnapshotEntry = typeof T3CapabilitySnapshotEntry.Type;

export const T3CapabilitySnapshot = Schema.Struct({
  capabilities: Schema.Array(T3CapabilitySnapshotEntry).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
export type T3CapabilitySnapshot = typeof T3CapabilitySnapshot.Type;

export const EMPTY_T3_CAPABILITY_SNAPSHOT: T3CapabilitySnapshot = { capabilities: [] };

export const T3CapabilityEventProvenance = Schema.Struct({
  capabilityId: Schema.optional(T3CapabilityId),
  capabilityKind: Schema.optional(T3CapabilityKind),
  capabilitySource: Schema.optional(T3CapabilitySource),
  providerInstanceId: Schema.optional(ProviderInstanceId),
  harnessName: Schema.optional(TrimmedNonEmptyString),
});
export type T3CapabilityEventProvenance = typeof T3CapabilityEventProvenance.Type;

export const T3SubagentAgent = Schema.Literals([
  "ollama-gpt-oss-120b-cloud",
  "ollama-gpt-oss-20b-cloud",
]);
export type T3SubagentAgent = typeof T3SubagentAgent.Type;

export const T3SubagentRunInput = Schema.Struct({
  prompt: TrimmedNonEmptyString,
  title: Schema.optional(TrimmedNonEmptyString),
  agent: Schema.optional(T3SubagentAgent),
});
export type T3SubagentRunInput = typeof T3SubagentRunInput.Type;

export const T3SubagentRunErrorCode = Schema.Literals([
  "capability_unavailable",
  "disabled",
  "parent_thread_missing",
  "read_model_unavailable",
  "registry_unavailable",
  "dispatch_failed",
]);
export type T3SubagentRunErrorCode = typeof T3SubagentRunErrorCode.Type;

export const T3SubagentRunError = Schema.Struct({
  code: T3SubagentRunErrorCode,
  message: TrimmedNonEmptyString,
});
export type T3SubagentRunError = typeof T3SubagentRunError.Type;

export const T3SubagentRunResult = Schema.Struct({
  status: Schema.Literal("started"),
  queueItemId: EventId,
  parentThreadId: ThreadId,
  childThreadId: ThreadId,
  childMessageId: MessageId,
  title: TrimmedNonEmptyString,
  agent: Schema.optional(T3SubagentAgent),
});
export type T3SubagentRunResult = typeof T3SubagentRunResult.Type;

export const T3SubagentStartedActivityPayload = Schema.Struct({
  queueItemId: EventId,
  status: Schema.Literal("started"),
  capabilityId: T3CapabilityId,
  capabilityKind: Schema.Literal("tool"),
  capabilitySource: Schema.Literal("t3"),
  harnessName: TrimmedNonEmptyString,
  toolName: TrimmedNonEmptyString,
  parentThreadId: ThreadId,
  parentTurnId: Schema.NullOr(TurnId),
  childThreadId: ThreadId,
  childMessageId: MessageId,
  title: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString,
  promptPreview: TrimmedNonEmptyString,
  agent: Schema.optional(T3SubagentAgent),
});
export type T3SubagentStartedActivityPayload = typeof T3SubagentStartedActivityPayload.Type;

export const T3SubagentCompletedActivityPayload = Schema.Struct({
  queueItemId: EventId,
  status: Schema.Literals(["completed", "failed"]),
  capabilityId: T3CapabilityId,
  capabilityKind: Schema.Literal("tool"),
  capabilitySource: Schema.Literal("t3"),
  harnessName: TrimmedNonEmptyString,
  toolName: TrimmedNonEmptyString,
  parentThreadId: ThreadId,
  childThreadId: ThreadId,
  childTurnId: Schema.NullOr(TurnId),
  childAssistantMessageId: Schema.NullOr(MessageId),
  title: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString,
  promptPreview: TrimmedNonEmptyString,
  resultPreview: TrimmedNonEmptyString,
  resultText: Schema.String,
  delivered: Schema.Literal(false),
  agent: Schema.optional(T3SubagentAgent),
});
export type T3SubagentCompletedActivityPayload = typeof T3SubagentCompletedActivityPayload.Type;

export const T3SubagentDeliveredActivityPayload = Schema.Struct({
  queueItemId: EventId,
  status: Schema.Literal("delivered"),
  capabilityId: T3CapabilityId,
  capabilityKind: Schema.Literal("tool"),
  capabilitySource: Schema.Literal("t3"),
  harnessName: TrimmedNonEmptyString,
  toolName: TrimmedNonEmptyString,
  parentThreadId: ThreadId,
  childThreadId: ThreadId,
  deliveryMessageId: MessageId,
  title: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString,
  promptPreview: TrimmedNonEmptyString,
  agent: Schema.optional(T3SubagentAgent),
});
export type T3SubagentDeliveredActivityPayload = typeof T3SubagentDeliveredActivityPayload.Type;
