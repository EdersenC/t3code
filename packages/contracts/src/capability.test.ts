import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { T3SubagentRunInput } from "./capability.ts";

const decodeSubagentInput = Schema.decodeUnknownSync(T3SubagentRunInput);

describe("T3SubagentRunInput", () => {
  it("accepts prompt-only calls with null legacy profile fields", () => {
    const parsed = decodeSubagentInput({
      subagent_type: null,
      prompt: "Run a harmless verification task.",
    });

    expect(parsed).toEqual({
      subagent_type: null,
      prompt: "Run a harmless verification task.",
    });
  });

  it("accepts custom subagent fanout specs without requiring profile rows", () => {
    const parsed = decodeSubagentInput({
      agents: [
        {
          type: null,
          agentKind: "custom",
          title: "General agent",
          prompt: "Summarize the current task.",
        },
      ],
    });

    expect(parsed.agents?.[0]).toMatchObject({
      type: null,
      agentKind: "custom",
      title: "General agent",
    });
  });
});
