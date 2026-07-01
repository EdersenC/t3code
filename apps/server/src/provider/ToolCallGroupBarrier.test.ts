import { expect, it } from "@effect/vitest";
import { ThreadId, ToolCallGroupId, ToolCallId, TurnId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import * as ToolCallGroupBarrier from "./ToolCallGroupBarrier.ts";

const threadId = ThreadId.make("thread-tool-group");
const turnId = TurnId.make("turn-tool-group");
const groupId = ToolCallGroupId.make("tool-group-1");
const toolA = ToolCallId.make("tool-a");
const toolB = ToolCallId.make("tool-b");
const toolC = ToolCallId.make("tool-c");
const createdAt = "2026-01-01T00:00:00.000Z";

function openThreeToolGroup(barrier: ToolCallGroupBarrier.ToolCallGroupBarrierShape) {
  return barrier.openGroup({
    groupId,
    threadId,
    turnId,
    policy: "barrier",
    expectedToolCallIds: [toolA, toolB, toolC],
    createdAt,
  });
}

it.effect("flushes one grouped result in original order after out-of-order completion", () =>
  Effect.gen(function* () {
    const barrier = yield* ToolCallGroupBarrier.ToolCallGroupBarrier;
    yield* openThreeToolGroup(barrier);

    yield* barrier.recordItemStarted({ groupId, toolCallId: toolA, index: 0, name: "read" });
    yield* barrier.recordItemStarted({ groupId, toolCallId: toolB, index: 1, name: "search" });
    yield* barrier.recordItemStarted({ groupId, toolCallId: toolC, index: 2, name: "inspect" });

    const first = yield* barrier.recordTerminalItem({
      groupId,
      toolCallId: toolB,
      status: "completed",
      result: "b",
    });
    expect(first.flushed).toBe(false);

    yield* barrier.recordTerminalItem({
      groupId,
      toolCallId: toolC,
      status: "completed",
      result: "c",
    });
    const flush = yield* barrier.recordTerminalItem({
      groupId,
      toolCallId: toolA,
      status: "completed",
      result: "a",
    });

    expect(flush.flushed).toBe(true);
    expect(flush.result?.results.map((item) => item.toolCallId)).toEqual([toolA, toolB, toolC]);
    expect(flush.result?.results.map((item) => item.content)).toEqual(["a", "b", "c"]);

    const duplicate = yield* barrier.recordTerminalItem({
      groupId,
      toolCallId: toolA,
      status: "completed",
      result: "second-a",
    });
    expect(duplicate.flushed).toBe(false);
  }).pipe(Effect.provide(ToolCallGroupBarrier.layer)),
);

it.effect("waits for all terminal items when one item fails", () =>
  Effect.gen(function* () {
    const barrier = yield* ToolCallGroupBarrier.ToolCallGroupBarrier;
    yield* openThreeToolGroup(barrier);

    yield* barrier.recordItemStarted({ groupId, toolCallId: toolA, index: 0, name: "read" });
    yield* barrier.recordItemStarted({ groupId, toolCallId: toolB, index: 1, name: "search" });
    yield* barrier.recordItemStarted({ groupId, toolCallId: toolC, index: 2, name: "inspect" });

    const failed = yield* barrier.recordTerminalItem({
      groupId,
      toolCallId: toolB,
      status: "failed",
      error: "boom",
    });
    expect(failed.flushed).toBe(false);

    yield* barrier.recordTerminalItem({
      groupId,
      toolCallId: toolA,
      status: "completed",
      result: "a",
    });
    const flush = yield* barrier.recordTerminalItem({
      groupId,
      toolCallId: toolC,
      status: "completed",
      result: "c",
    });

    expect(flush.flushed).toBe(true);
    expect(flush.result?.results.map((item) => item.status)).toEqual([
      "completed",
      "failed",
      "completed",
    ]);
  }).pipe(Effect.provide(ToolCallGroupBarrier.layer)),
);

it.effect("marks pending items timed out and flushes once", () =>
  Effect.gen(function* () {
    const barrier = yield* ToolCallGroupBarrier.ToolCallGroupBarrier;
    yield* openThreeToolGroup(barrier);
    yield* barrier.recordTerminalItem({
      groupId,
      toolCallId: toolA,
      status: "completed",
      result: "a",
    });

    const flush = yield* barrier.timeoutGroup(groupId, "deadline");

    expect(flush.flushed).toBe(true);
    expect(flush.result?.results.map((item) => item.status)).toEqual([
      "completed",
      "timed_out",
      "timed_out",
    ]);
  }).pipe(Effect.provide(ToolCallGroupBarrier.layer)),
);

it.effect("cancels pending group items", () =>
  Effect.gen(function* () {
    const barrier = yield* ToolCallGroupBarrier.ToolCallGroupBarrier;
    yield* openThreeToolGroup(barrier);

    const flush = yield* barrier.cancelGroup(groupId, "interrupted");

    expect(flush.flushed).toBe(true);
    expect(flush.result?.results.every((item) => item.status === "cancelled")).toBe(true);
  }).pipe(Effect.provide(ToolCallGroupBarrier.layer)),
);

it.effect("awaits the first complete grouped flush", () =>
  Effect.gen(function* () {
    const barrier = yield* ToolCallGroupBarrier.ToolCallGroupBarrier;
    yield* barrier.openGroup({
      groupId,
      threadId,
      turnId,
      policy: "barrier",
      expectedCount: 2,
      createdAt,
    });

    const waiter = yield* barrier.awaitFlush(groupId).pipe(Effect.forkScoped);
    yield* barrier.recordItemStarted({ groupId, toolCallId: toolB, index: 1, name: "second" });
    yield* barrier.recordItemStarted({ groupId, toolCallId: toolA, index: 0, name: "first" });
    yield* barrier.recordTerminalItem({
      groupId,
      toolCallId: toolB,
      status: "completed",
      result: "b",
    });
    yield* barrier.recordTerminalItem({
      groupId,
      toolCallId: toolA,
      status: "completed",
      result: "a",
    });

    const result = yield* Fiber.join(waiter);
    expect(result.results.map((item) => item.toolCallId)).toEqual([toolA, toolB]);
  }).pipe(Effect.provide(ToolCallGroupBarrier.layer)),
);
