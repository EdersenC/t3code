import { T3SubagentRunError, T3SubagentRunInput, T3SubagentRunResult } from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as T3SubagentRuntime from "../../T3SubagentRuntime.ts";

const dependencies = [T3SubagentRuntime.T3SubagentRuntime];

export const T3SubagentTool = Tool.make("t3_subagent", {
  description:
    "Start a T3-owned general-purpose subagent thread with a prompt, optional title, and optional agent. Available agents: ollama-gpt-oss-120b-cloud, ollama-gpt-oss-20b-cloud. Omit agent to inherit the parent session model. The subagent input and full result are queued back to the parent thread when it finishes.",
  parameters: T3SubagentRunInput,
  success: T3SubagentRunResult,
  failure: T3SubagentRunError,
  dependencies,
})
  .annotate(Tool.Title, "Subagent")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);

export const T3SubagentToolkit = Toolkit.make(T3SubagentTool);
