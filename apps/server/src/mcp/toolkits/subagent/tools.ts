import { T3SubagentRunError, T3SubagentRunInput, T3SubagentRunResult } from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as T3SubagentRuntime from "../../T3SubagentRuntime.ts";
import * as ToolCallGroupBarrier from "../../../provider/ToolCallGroupBarrier.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";

const dependencies = [
  T3SubagentRuntime.T3SubagentRuntime,
  ToolCallGroupBarrier.ToolCallGroupBarrier,
  ServerSettingsService,
];

export const T3SubagentTool = Tool.make("t3_subagent", {
  description:
    "Start one or more T3-owned general-purpose Subagent threads. Use prompt/title for one subagent, or agents[] for fanout. Do not use legacy profile fields such as explore, implement, or review.",
  parameters: T3SubagentRunInput,
  success: T3SubagentRunResult,
  failure: T3SubagentRunError,
  dependencies,
})
  .annotate(Tool.Title, "Subagent")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);

export const T3SubagentToolkit = Toolkit.make(T3SubagentTool);
