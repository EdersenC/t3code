import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ProviderRuntimeEvent } from "./providerRuntime.ts";

const decodeRuntimeEvent = Schema.decodeUnknownSync(ProviderRuntimeEvent);

describe("ProviderRuntimeEvent", () => {
  it("accepts fork-provided driver kinds as branded slugs", () => {
    const parsed = decodeRuntimeEvent({
      type: "session.started",
      eventId: "event-ollama-session",
      provider: "ollama",
      providerInstanceId: "ollama_local",
      createdAt: "2026-02-28T00:00:00.000Z",
      threadId: "thread-1",
      payload: {
        message: "started",
      },
    });

    expect(parsed.provider).toBe("ollama");
    expect(parsed.providerInstanceId).toBe("ollama_local");
  });

  it("decodes optional capability provenance on item lifecycle events", () => {
    const parsed = decodeRuntimeEvent({
      type: "item.started",
      eventId: "event-capability-provenance",
      provider: "opencode",
      providerInstanceId: "opencode",
      createdAt: "2026-02-28T00:00:00.000Z",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      payload: {
        itemType: "collab_agent_tool_call",
        status: "inProgress",
        title: "Task",
        capabilityId: "harness:opencode:subagent:task",
        capabilityKind: "subagent",
        capabilitySource: "harness-native",
        providerInstanceId: "opencode",
        harnessName: "OpenCode",
      },
    });

    expect(parsed.type).toBe("item.started");
    if (parsed.type !== "item.started") {
      throw new Error("expected item.started");
    }
    expect(parsed.payload.capabilityKind).toBe("subagent");
    expect(parsed.payload.capabilitySource).toBe("harness-native");
    expect(parsed.payload.harnessName).toBe("OpenCode");
  });

  it("decodes optional tool-call group metadata on item lifecycle events", () => {
    const parsed = decodeRuntimeEvent({
      type: "item.started",
      eventId: "event-tool-group-item",
      provider: "opencode",
      providerInstanceId: "opencode",
      createdAt: "2026-02-28T00:00:00.000Z",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      payload: {
        itemType: "mcp_tool_call",
        status: "inProgress",
        title: "Read package.json",
        toolCallId: "tool-call-1",
        toolCallGroupId: "tool-group-1",
        toolCallIndex: 0,
        toolCallGroupPolicy: "barrier",
        expectedToolCallCount: 3,
      },
    });

    expect(parsed.type).toBe("item.started");
    if (parsed.type !== "item.started") {
      throw new Error("expected item.started");
    }
    expect(parsed.payload.toolCallGroupId).toBe("tool-group-1");
    expect(parsed.payload.toolCallIndex).toBe(0);
    expect(parsed.payload.toolCallGroupPolicy).toBe("barrier");
    expect(parsed.payload.expectedToolCallCount).toBe(3);
  });

  it("decodes grouped tool-call lifecycle events", () => {
    const started = decodeRuntimeEvent({
      type: "tool.group.started",
      eventId: "event-tool-group-started",
      provider: "opencode",
      createdAt: "2026-02-28T00:00:00.000Z",
      threadId: "thread-1",
      turnId: "turn-1",
      payload: {
        groupId: "tool-group-1",
        policy: "barrier",
        expectedToolCallIds: ["tool-a", "tool-b", "tool-c"],
        expectedCount: 3,
        title: "Repository inspection",
        trace: {
          projectId: "project-1",
          rootThreadId: "thread-root",
          threadId: "thread-1",
          turnId: "turn-1",
          toolCallGroupId: "tool-group-1",
          groupPolicy: "barrier",
          status: "started",
          correlationId: "event-tool-group-started",
          timestamp: "2026-02-28T00:00:00.000Z",
        },
      },
    });
    expect(started.type).toBe("tool.group.started");
    if (started.type !== "tool.group.started") {
      throw new Error("expected tool.group.started");
    }
    expect(started.payload.trace?.rootThreadId).toBe("thread-root");

    const completed = decodeRuntimeEvent({
      type: "tool.group.completed",
      eventId: "event-tool-group-completed",
      provider: "opencode",
      createdAt: "2026-02-28T00:00:01.000Z",
      threadId: "thread-1",
      turnId: "turn-1",
      payload: {
        groupId: "tool-group-1",
        policy: "barrier",
        result: {
          groupId: "tool-group-1",
          results: [
            {
              toolCallId: "tool-a",
              toolName: "read",
              status: "completed",
              content: "package",
            },
          ],
        },
      },
    });
    expect(completed.type).toBe("tool.group.completed");
    if (completed.type !== "tool.group.completed") {
      throw new Error("expected tool.group.completed");
    }
    expect(completed.payload.result?.results[0]?.toolCallId).toBe("tool-a");
  });

  it("decodes turn.plan.updated for plan rendering", () => {
    const parsed = decodeRuntimeEvent({
      type: "turn.plan.updated",
      eventId: "event-1",
      provider: "claudeAgent",
      sessionId: "runtime-session-1",
      createdAt: "2026-02-28T00:00:00.000Z",
      threadId: "thread-1",
      turnId: "turn-1",
      payload: {
        explanation: "Implement schema updates",
        plan: [
          { step: "Define event union", status: "completed" },
          { step: "Wire adapter mapping", status: "inProgress" },
        ],
      },
    });

    expect(parsed.type).toBe("turn.plan.updated");
    if (parsed.type !== "turn.plan.updated") {
      throw new Error("expected turn.plan.updated");
    }
    expect(parsed.payload.plan).toHaveLength(2);
    expect(parsed.payload.plan[1]?.status).toBe("inProgress");
  });

  it("decodes proposed-plan completion events", () => {
    const parsed = decodeRuntimeEvent({
      type: "turn.proposed.completed",
      eventId: "event-proposed-plan-1",
      provider: "codex",
      createdAt: "2026-02-28T00:00:00.000Z",
      threadId: "thread-1",
      turnId: "turn-1",
      payload: {
        planMarkdown: "# Ship it",
      },
    });

    expect(parsed.type).toBe("turn.proposed.completed");
    if (parsed.type !== "turn.proposed.completed") {
      throw new Error("expected turn.proposed.completed");
    }
    expect(parsed.payload.planMarkdown).toBe("# Ship it");
  });

  it("decodes user-input.requested with structured questions", () => {
    const parsed = decodeRuntimeEvent({
      type: "user-input.requested",
      eventId: "event-2",
      provider: "claudeAgent",
      sessionId: "runtime-session-2",
      createdAt: "2026-02-28T00:00:01.000Z",
      threadId: "thread-2",
      requestId: "request-1",
      payload: {
        questions: [
          {
            id: "sandbox_mode",
            header: "Sandbox",
            question: "Which mode should be used?",
            options: [
              {
                label: "workspace-write",
                description: "Allow edits in workspace only",
              },
              {
                label: "danger-full-access",
                description: "Allow unrestricted access",
              },
            ],
          },
        ],
      },
    });

    expect(parsed.type).toBe("user-input.requested");
    if (parsed.type !== "user-input.requested") {
      throw new Error("expected user-input.requested");
    }
    expect(parsed.payload.questions[0]?.id).toBe("sandbox_mode");
    expect(parsed.payload.questions[0]?.options).toHaveLength(2);
  });

  it("decodes user-input.resolved with answer map", () => {
    const parsed = decodeRuntimeEvent({
      type: "user-input.resolved",
      eventId: "event-3",
      provider: "claudeAgent",
      sessionId: "runtime-session-2",
      createdAt: "2026-02-28T00:00:02.000Z",
      threadId: "thread-2",
      requestId: "request-1",
      payload: {
        answers: {
          sandbox_mode: "workspace-write",
        },
      },
    });

    expect(parsed.type).toBe("user-input.resolved");
    if (parsed.type !== "user-input.resolved") {
      throw new Error("expected user-input.resolved");
    }
    expect(parsed.payload.answers.sandbox_mode).toBe("workspace-write");
  });

  it("rejects legacy message.delta type", () => {
    expect(() =>
      decodeRuntimeEvent({
        type: "message.delta",
        eventId: "event-4",
        provider: "codex",
        sessionId: "runtime-session-3",
        createdAt: "2026-02-28T00:00:03.000Z",
        payload: { delta: "legacy" },
      }),
    ).toThrow();
  });

  it("rejects empty branded canonical ids", () => {
    expect(() =>
      decodeRuntimeEvent({
        type: "runtime.error",
        eventId: "event-5",
        provider: "codex",
        sessionId: "runtime-session-3",
        createdAt: "2026-02-28T00:00:03.000Z",
        threadId: "   ",
        payload: { message: "boom" },
      }),
    ).toThrow();
  });

  it("decodes normalized thread token usage snapshots", () => {
    const parsed = decodeRuntimeEvent({
      type: "thread.token-usage.updated",
      eventId: "event-token-usage-1",
      provider: "claudeAgent",
      createdAt: "2026-02-28T00:00:04.000Z",
      threadId: "thread-1",
      payload: {
        usage: {
          usedTokens: 31251,
          maxTokens: 200000,
          toolUses: 25,
          durationMs: 43567,
        },
      },
    });

    expect(parsed.type).toBe("thread.token-usage.updated");
    if (parsed.type !== "thread.token-usage.updated") {
      throw new Error("expected thread.token-usage.updated");
    }
    expect(parsed.payload.usage.maxTokens).toBe(200000);
    expect(parsed.payload.usage.usedTokens).toBe(31251);
  });
});
