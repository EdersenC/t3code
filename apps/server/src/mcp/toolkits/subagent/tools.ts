import { T3SubagentRunError, T3SubagentRunInput, T3SubagentRunResult } from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as T3SubagentRuntime from "../../T3SubagentRuntime.ts";
import * as ToolCallGroupBarrier from "../../../provider/ToolCallGroupBarrier.ts";

const dependencies = [
  T3SubagentRuntime.T3SubagentRuntime,
  ToolCallGroupBarrier.ToolCallGroupBarrier,
];

export const T3SubagentTool = Tool.make("t3_subagent", {
  description:
    "Start one or more T3-owned subagent threads. Use legacy subagentType/prompt for one agent, or agents[] for fanout. Supported agent types are explore, implement, and review.",
  parameters: T3SubagentRunInput,
  success: T3SubagentRunResult,
  failure: T3SubagentRunError,
  dependencies,
})
  .annotate(Tool.Title, "Subagent")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);

export const T3SubagentToolkit = Toolkit.make(T3SubagentTool);
