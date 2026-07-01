import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as T3SubagentRuntime from "../../T3SubagentRuntime.ts";
import { T3SubagentToolkit } from "./tools.ts";

export const T3SubagentToolkitHandlersLive = T3SubagentToolkit.toLayer({
  t3_subagent: (input) =>
    Effect.withFiber((fiber) => {
      const invocation = Context.getUnsafe(
        fiber.context,
        McpInvocationContext.McpInvocationContext,
      );
      return T3SubagentRuntime.withRuntime((runtime) => runtime.run(input)).pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
      );
    }),
});
