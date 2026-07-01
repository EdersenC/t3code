import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { EventId, MessageId, ThreadId } from "./baseSchemas.ts";
import { T3SubagentRunInput, T3SubagentRunResult } from "./capability.ts";

const decodeT3SubagentRunInput = Schema.decodeUnknownSync(T3SubagentRunInput);
const decodeT3SubagentRunResult = Schema.decodeUnknownSync(T3SubagentRunResult);

describe("T3 subagent contracts", () => {
  it("decodes prompt-only subagent input", () => {
    expect(
      decodeT3SubagentRunInput({
        prompt: "Do a harmless random check.",
        title: "Random check",
        agent: "ollama-gpt-oss-20b-cloud",
      }),
    ).toEqual({
      prompt: "Do a harmless random check.",
      title: "Random check",
      agent: "ollama-gpt-oss-20b-cloud",
    });
  });

  it("rejects unknown subagent agents", () => {
    expect(() =>
      decodeT3SubagentRunInput({
        prompt: "Do a harmless random check.",
        agent: "made-up-agent",
      }),
    ).toThrow();
  });

  it("rejects legacy profile-only subagent input", () => {
    expect(() =>
      decodeT3SubagentRunInput({
        subagentType: "review",
      }),
    ).toThrow();
  });

  it("includes queue item id in subagent run results", () => {
    expect(
      decodeT3SubagentRunResult({
        status: "started",
        queueItemId: "queue-1",
        parentThreadId: "thread-parent",
        childThreadId: "thread-child",
        childMessageId: "message-child",
        title: "Subagent",
        agent: "ollama-gpt-oss-120b-cloud",
      }),
    ).toEqual({
      status: "started",
      queueItemId: EventId.make("queue-1"),
      parentThreadId: ThreadId.make("thread-parent"),
      childThreadId: ThreadId.make("thread-child"),
      childMessageId: MessageId.make("message-child"),
      title: "Subagent",
      agent: "ollama-gpt-oss-120b-cloud",
    });
  });
});
