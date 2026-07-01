import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas.ts";

export const ToolCallGroupId = TrimmedNonEmptyString.pipe(Schema.brand("ToolCallGroupId"));
export type ToolCallGroupId = typeof ToolCallGroupId.Type;

export const ToolCallId = TrimmedNonEmptyString.pipe(Schema.brand("ToolCallId"));
export type ToolCallId = typeof ToolCallId.Type;

export const ToolCallGroupPolicy = Schema.Literals(["barrier", "stream"]);
export type ToolCallGroupPolicy = typeof ToolCallGroupPolicy.Type;

export const ToolCallGroupItemStatus = Schema.Literals([
  "pending",
  "running",
  "completed",
  "failed",
  "denied",
  "timed_out",
  "cancelled",
]);
export type ToolCallGroupItemStatus = typeof ToolCallGroupItemStatus.Type;

export const ToolCallGroupTerminalStatus = Schema.Literals([
  "completed",
  "failed",
  "denied",
  "timed_out",
  "cancelled",
]);
export type ToolCallGroupTerminalStatus = typeof ToolCallGroupTerminalStatus.Type;

export const ToolCallGroupMetadata = Schema.Struct({
  toolCallGroupId: Schema.optional(ToolCallGroupId),
  toolCallIndex: Schema.optional(NonNegativeInt),
  toolCallGroupPolicy: Schema.optional(ToolCallGroupPolicy),
  expectedToolCallCount: Schema.optional(NonNegativeInt),
});
export type ToolCallGroupMetadata = typeof ToolCallGroupMetadata.Type;

export const ToolCallGroup = Schema.Struct({
  groupId: ToolCallGroupId,
  threadId: ThreadId,
  turnId: TurnId,
  policy: ToolCallGroupPolicy,
  expectedToolCallIds: Schema.Array(ToolCallId),
  createdAt: IsoDateTime,
  timeoutMs: Schema.optional(NonNegativeInt),
});
export type ToolCallGroup = typeof ToolCallGroup.Type;

export const ToolCallGroupItem = Schema.Struct({
  groupId: ToolCallGroupId,
  toolCallId: ToolCallId,
  index: NonNegativeInt,
  name: TrimmedNonEmptyString,
  status: ToolCallGroupItemStatus,
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Unknown),
});
export type ToolCallGroupItem = typeof ToolCallGroupItem.Type;

export const ToolCallGroupedResultItem = Schema.Struct({
  toolCallId: ToolCallId,
  toolName: TrimmedNonEmptyString,
  status: ToolCallGroupTerminalStatus,
  content: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Unknown),
});
export type ToolCallGroupedResultItem = typeof ToolCallGroupedResultItem.Type;

export const ToolCallGroupedResult = Schema.Struct({
  groupId: ToolCallGroupId,
  results: Schema.Array(ToolCallGroupedResultItem),
});
export type ToolCallGroupedResult = typeof ToolCallGroupedResult.Type;
