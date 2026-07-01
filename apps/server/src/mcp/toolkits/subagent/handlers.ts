import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { TurnId, type T3SubagentRunInput } from "@t3tools/contracts";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as T3SubagentRuntime from "../../T3SubagentRuntime.ts";
import * as ToolCallGroupBarrier from "../../../provider/ToolCallGroupBarrier.ts";
import { T3SubagentToolkit } from "./tools.ts";

const runSubagent = (input: T3SubagentRunInput) =>
  T3SubagentRuntime.withRuntime((runtime) => runtime.run(input));

export const T3SubagentToolkitHandlersLive = T3SubagentToolkit.toLayer({
  t3_subagent: (input) =>
    Effect.withFiber((fiber) => {
      const invocation = Context.getUnsafe(
        fiber.context,
        McpInvocationContext.McpInvocationContext,
      );
      if (
        input.toolCallGroupId === undefined ||
        input.toolCallGroupPolicy !== "barrier" ||
        input.toolCallId === undefined ||
        input.expectedToolCallCount === undefined
      ) {
        return runSubagent(input).pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        );
      }
      const groupId = input.toolCallGroupId;
      const toolCallId = input.toolCallId;
      const expectedToolCallCount = input.expectedToolCallCount;
      return Effect.gen(function* () {
        const barrier = yield* ToolCallGroupBarrier.ToolCallGroupBarrier;
        const createdAt = DateTime.formatIso(yield* DateTime.now);
        yield* barrier.openGroup({
          groupId,
          threadId: invocation.threadId,
          turnId: input.parentTurnId ?? TurnId.make(`mcp-tool-group:${groupId}`),
          policy: "barrier",
          expectedCount: expectedToolCallCount,
          createdAt,
        });
        yield* barrier.recordItemStarted({
          groupId,
          toolCallId,
          index: input.toolCallIndex ?? 0,
          name: "t3_subagent",
        });
        const ownResult = yield* runSubagent(input).pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.tapError((error) =>
            barrier.recordTerminalItem({
              groupId,
              toolCallId,
              status: "failed",
              error,
            }),
          ),
        );
        yield* barrier.recordTerminalItem({
          groupId,
          toolCallId,
          status: "completed",
          result: ownResult,
        });
        const groupedResult = yield* barrier.awaitFlush(groupId);
        return {
          ...ownResult,
          groupedResult,
        };
      });
    }),
});
