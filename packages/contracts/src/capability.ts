import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { MessageId, ThreadId, TrimmedNonEmptyString, TurnId } from "./baseSchemas.ts";
import { AgentKind } from "./orchestration.ts";
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
  subagentType: Schema.optional(TrimmedNonEmptyString),
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

export const T3SubagentType = Schema.Literals(["explore", "implement", "review"]);
export type T3SubagentType = typeof T3SubagentType.Type;

export const T3SubagentSpec = Schema.Struct({
  type: Schema.optional(T3SubagentType),
  subagentType: Schema.optional(T3SubagentType),
  agentKind: Schema.optional(AgentKind),
  prompt: TrimmedNonEmptyString,
  title: Schema.optional(TrimmedNonEmptyString),
  displayName: Schema.optional(TrimmedNonEmptyString),
  priority: Schema.optional(Schema.Number),
});
export type T3SubagentSpec = typeof T3SubagentSpec.Type;

export const T3SubagentRunInput = Schema.Struct({
  subagentType: Schema.optional(T3SubagentType),
  prompt: Schema.optional(TrimmedNonEmptyString),
  title: Schema.optional(TrimmedNonEmptyString),
  agents: Schema.optional(Schema.Array(T3SubagentSpec)),
  parentThreadId: Schema.optional(ThreadId),
  rootThreadId: Schema.optional(ThreadId),
  spawnGroupId: Schema.optional(TrimmedNonEmptyString),
  parentTurnId: Schema.optional(TurnId),
  spawnedByToolCallId: Schema.optional(TrimmedNonEmptyString),
});
export type T3SubagentRunInput = typeof T3SubagentRunInput.Type;

export const T3SubagentRunErrorCode = Schema.Literals([
  "capability_unavailable",
  "disabled",
  "parent_thread_missing",
  "read_model_unavailable",
  "registry_unavailable",
  "dispatch_failed",
  "invalid_input",
  "limit_exceeded",
]);
export type T3SubagentRunErrorCode = typeof T3SubagentRunErrorCode.Type;

export const T3SubagentRunError = Schema.Struct({
  code: T3SubagentRunErrorCode,
  message: TrimmedNonEmptyString,
});
export type T3SubagentRunError = typeof T3SubagentRunError.Type;

export const T3SubagentRunChildResult = Schema.Struct({
  status: Schema.Literal("started"),
  parentThreadId: ThreadId,
  rootThreadId: ThreadId,
  childThreadId: ThreadId,
  childMessageId: MessageId,
  subagentType: T3SubagentType,
  agentKind: AgentKind,
  title: TrimmedNonEmptyString,
  queueKey: TrimmedNonEmptyString,
});
export type T3SubagentRunChildResult = typeof T3SubagentRunChildResult.Type;

export const T3SubagentRunResult = Schema.Struct({
  status: Schema.Literal("started"),
  parentThreadId: ThreadId,
  rootThreadId: ThreadId,
  spawnGroupId: TrimmedNonEmptyString,
  children: Schema.Array(T3SubagentRunChildResult),
  childThreadId: Schema.optional(ThreadId),
  childMessageId: Schema.optional(MessageId),
  subagentType: Schema.optional(T3SubagentType),
  title: TrimmedNonEmptyString,
});
export type T3SubagentRunResult = typeof T3SubagentRunResult.Type;
