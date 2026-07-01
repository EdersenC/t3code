import { T3SubagentRunError, T3SubagentRunInput, T3SubagentRunResult } from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as T3SubagentRuntime from "../../T3SubagentRuntime.ts";

const dependencies = [T3SubagentRuntime.T3SubagentRuntime];

export const T3SubagentTool = Tool.make("t3_subagent", {
  description:
    "Start a T3-owned subagent thread. Use subagentType 'explore' for read-only discovery, 'implement' for a narrow code change, or 'review' for bug/regression review.",
  parameters: T3SubagentRunInput,
  success: T3SubagentRunResult,
  failure: T3SubagentRunError,
  dependencies,
})
  .annotate(Tool.Title, "Subagent")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);

export const T3SubagentToolkit = Toolkit.make(T3SubagentTool);
