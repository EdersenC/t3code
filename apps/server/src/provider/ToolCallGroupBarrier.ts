import type {
  ThreadId,
  ToolCallGroupedResult,
  ToolCallGroupId,
  ToolCallGroupItem,
  ToolCallGroupPolicy,
  ToolCallGroupTerminalStatus,
  ToolCallId,
  TurnId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

type BarrierItem = ToolCallGroupItem;
type BarrierGroups = Map<ToolCallGroupId, BarrierGroupState>;

interface BarrierGroupState {
  readonly groupId: ToolCallGroupId;
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly policy: ToolCallGroupPolicy;
  readonly expectedToolCallIds: ReadonlyArray<ToolCallId>;
  readonly expectedCount: number;
  readonly createdAt: string;
  readonly timeoutMs?: number;
  readonly flushed: boolean;
  readonly items: ReadonlyMap<ToolCallId, BarrierItem>;
  readonly flushDeferred: Deferred.Deferred<ToolCallGroupedResult, never>;
}

export interface OpenToolCallGroupInput {
  readonly groupId: ToolCallGroupId;
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly policy: ToolCallGroupPolicy;
  readonly expectedToolCallIds?: ReadonlyArray<ToolCallId>;
  readonly expectedCount?: number;
  readonly createdAt: string;
  readonly timeoutMs?: number;
}

export interface RecordToolCallGroupItemStartedInput {
  readonly groupId: ToolCallGroupId;
  readonly toolCallId: ToolCallId;
  readonly index: number;
  readonly name: string;
}

export interface RecordToolCallGroupTerminalInput {
  readonly groupId: ToolCallGroupId;
  readonly toolCallId: ToolCallId;
  readonly status: ToolCallGroupTerminalStatus;
  readonly result?: unknown;
  readonly error?: unknown;
}

export interface ToolCallGroupBarrierOutcome {
  readonly groupId: ToolCallGroupId;
  readonly flushed: boolean;
  readonly result?: ToolCallGroupedResult;
}

interface ToolCallGroupBarrierUpdateResult {
  readonly outcome: ToolCallGroupBarrierOutcome;
  readonly flushDeferred?: Deferred.Deferred<ToolCallGroupedResult, never>;
}

export interface ToolCallGroupBarrierShape {
  readonly openGroup: (input: OpenToolCallGroupInput) => Effect.Effect<BarrierGroupState>;
  readonly recordItemStarted: (
    input: RecordToolCallGroupItemStartedInput,
  ) => Effect.Effect<ToolCallGroupBarrierOutcome>;
  readonly recordTerminalItem: (
    input: RecordToolCallGroupTerminalInput,
  ) => Effect.Effect<ToolCallGroupBarrierOutcome>;
  readonly timeoutGroup: (
    groupId: ToolCallGroupId,
    reason?: string,
  ) => Effect.Effect<ToolCallGroupBarrierOutcome>;
  readonly cancelGroup: (
    groupId: ToolCallGroupId,
    reason?: string,
  ) => Effect.Effect<ToolCallGroupBarrierOutcome>;
  readonly awaitFlush: (groupId: ToolCallGroupId) => Effect.Effect<ToolCallGroupedResult>;
  readonly getGroup: (groupId: ToolCallGroupId) => Effect.Effect<BarrierGroupState | undefined>;
}

export class ToolCallGroupBarrier extends Context.Service<
  ToolCallGroupBarrier,
  ToolCallGroupBarrierShape
>()("t3/provider/ToolCallGroupBarrier") {}

const terminalStatuses = new Set<ToolCallGroupTerminalStatus>([
  "completed",
  "failed",
  "denied",
  "timed_out",
  "cancelled",
]);

function isTerminalItem(item: BarrierItem): boolean {
  return terminalStatuses.has(item.status as ToolCallGroupTerminalStatus);
}

function itemForExpectedId(
  state: BarrierGroupState,
  toolCallId: ToolCallId,
  index: number,
): BarrierItem {
  return (
    state.items.get(toolCallId) ?? {
      groupId: state.groupId,
      toolCallId,
      index,
      name: String(toolCallId),
      status: "pending",
    }
  );
}

function orderedItems(state: BarrierGroupState): ReadonlyArray<BarrierItem> {
  const expectedIds =
    state.expectedToolCallIds.length > 0
      ? state.expectedToolCallIds
      : Array.from(state.items.values())
          .toSorted(
            (left, right) =>
              left.index - right.index || left.toolCallId.localeCompare(right.toolCallId),
          )
          .map((item) => item.toolCallId);
  return expectedIds.map((toolCallId, index) => itemForExpectedId(state, toolCallId, index));
}

function buildFlushResult(state: BarrierGroupState): ToolCallGroupedResult | undefined {
  if (state.policy !== "barrier" || state.flushed) {
    return undefined;
  }
  const items = orderedItems(state);
  if (
    items.length === 0 ||
    items.length < state.expectedCount ||
    items.some((item) => !isTerminalItem(item))
  ) {
    return undefined;
  }
  return {
    groupId: state.groupId,
    results: items.map((item) => ({
      toolCallId: item.toolCallId,
      toolName: item.name,
      status: item.status as ToolCallGroupTerminalStatus,
      ...(item.result !== undefined ? { content: item.result } : {}),
      ...(item.error !== undefined ? { error: item.error } : {}),
    })),
  };
}

function markTimedOutOrCancelled(
  state: BarrierGroupState,
  status: "timed_out" | "cancelled",
  reason?: string,
): BarrierGroupState {
  const nextItems = new Map(state.items);
  state.expectedToolCallIds.forEach((toolCallId, index) => {
    const existing = itemForExpectedId(state, toolCallId, index);
    if (isTerminalItem(existing)) {
      nextItems.set(toolCallId, existing);
      return;
    }
    nextItems.set(toolCallId, {
      ...existing,
      status,
      ...(reason !== undefined ? { error: reason } : {}),
    });
  });
  return { ...state, items: nextItems };
}

function updateStateWithFlush(
  state: BarrierGroupState,
): readonly [BarrierGroupState, ToolCallGroupBarrierOutcome] {
  const result = buildFlushResult(state);
  if (!result) {
    return [state, { groupId: state.groupId, flushed: false }];
  }
  return [
    { ...state, flushed: true },
    { groupId: state.groupId, flushed: true, result },
  ];
}

const make = Effect.gen(function* () {
  const groupsRef = yield* Ref.make<BarrierGroups>(new Map());

  const updateGroup = (
    groupId: ToolCallGroupId,
    update: (state: BarrierGroupState) => BarrierGroupState,
  ) =>
    Ref.modify(groupsRef, (groups): readonly [ToolCallGroupBarrierUpdateResult, BarrierGroups] => {
      const current = groups.get(groupId);
      if (!current) {
        return [
          { outcome: { groupId, flushed: false } satisfies ToolCallGroupBarrierOutcome },
          groups,
        ] as const;
      }
      const [next, outcome] = updateStateWithFlush(update(current));
      const nextGroups = new Map(groups);
      nextGroups.set(groupId, next);
      const result: ToolCallGroupBarrierUpdateResult =
        outcome.flushed && outcome.result !== undefined
          ? { outcome, flushDeferred: next.flushDeferred }
          : { outcome };
      return [result, nextGroups] as const;
    }).pipe(
      Effect.flatMap((result) =>
        result.flushDeferred && result.outcome.result
          ? Deferred.succeed(result.flushDeferred, result.outcome.result).pipe(
              Effect.as(result.outcome),
            )
          : Effect.succeed(result.outcome),
      ),
    );

  const openGroup: ToolCallGroupBarrierShape["openGroup"] = (input) =>
    Effect.gen(function* () {
      const flushDeferred = yield* Deferred.make<ToolCallGroupedResult, never>();
      return yield* Ref.modify(groupsRef, (groups) => {
        const existing = groups.get(input.groupId);
        if (existing) {
          return [existing, groups] as const;
        }
        const state: BarrierGroupState = {
          groupId: input.groupId,
          threadId: input.threadId,
          turnId: input.turnId,
          policy: input.policy,
          expectedToolCallIds: input.expectedToolCallIds ?? [],
          expectedCount: input.expectedCount ?? input.expectedToolCallIds?.length ?? 0,
          createdAt: input.createdAt,
          ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
          flushed: false,
          items: new Map(
            (input.expectedToolCallIds ?? []).map((toolCallId, index) => [
              toolCallId,
              {
                groupId: input.groupId,
                toolCallId,
                index,
                name: String(toolCallId),
                status: "pending" as const,
              },
            ]),
          ),
          flushDeferred,
        };
        const nextGroups = new Map(groups);
        nextGroups.set(input.groupId, state);
        return [state, nextGroups] as const;
      });
    });

  const recordItemStarted: ToolCallGroupBarrierShape["recordItemStarted"] = (input) =>
    updateGroup(input.groupId, (state) => {
      const nextItems = new Map(state.items);
      const existing = itemForExpectedId(state, input.toolCallId, input.index);
      if (isTerminalItem(existing)) {
        return state;
      }
      nextItems.set(input.toolCallId, {
        ...existing,
        index: input.index,
        name: input.name,
        status: "running",
      });
      return { ...state, items: nextItems };
    });

  const recordTerminalItem: ToolCallGroupBarrierShape["recordTerminalItem"] = (input) =>
    updateGroup(input.groupId, (state) => {
      const expectedIndex = state.expectedToolCallIds.findIndex(
        (toolCallId) => toolCallId === input.toolCallId,
      );
      if (state.expectedToolCallIds.length > 0 && expectedIndex < 0) {
        return state;
      }
      const nextItems = new Map(state.items);
      const existing = itemForExpectedId(
        state,
        input.toolCallId,
        expectedIndex >= 0 ? expectedIndex : state.items.size,
      );
      if (isTerminalItem(existing)) {
        return state;
      }
      nextItems.set(input.toolCallId, {
        ...existing,
        status: input.status,
        ...(input.result !== undefined ? { result: input.result } : {}),
        ...(input.error !== undefined ? { error: input.error } : {}),
      });
      return { ...state, items: nextItems };
    });

  const timeoutGroup: ToolCallGroupBarrierShape["timeoutGroup"] = (groupId, reason) =>
    updateGroup(groupId, (state) => markTimedOutOrCancelled(state, "timed_out", reason));

  const cancelGroup: ToolCallGroupBarrierShape["cancelGroup"] = (groupId, reason) =>
    updateGroup(groupId, (state) => markTimedOutOrCancelled(state, "cancelled", reason));

  const awaitFlush: ToolCallGroupBarrierShape["awaitFlush"] = (groupId) =>
    getGroup(groupId).pipe(
      Effect.flatMap((state) =>
        state
          ? Deferred.await(state.flushDeferred)
          : Effect.die(new Error(`Unknown tool group ${groupId}`)),
      ),
    );

  const getGroup: ToolCallGroupBarrierShape["getGroup"] = (groupId) =>
    Ref.get(groupsRef).pipe(Effect.map((groups) => groups.get(groupId)));

  return {
    openGroup,
    recordItemStarted,
    recordTerminalItem,
    timeoutGroup,
    cancelGroup,
    awaitFlush,
    getGroup,
  } satisfies ToolCallGroupBarrierShape;
});

export const layer = Layer.effect(ToolCallGroupBarrier, make);
