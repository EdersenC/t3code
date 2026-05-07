# Pi Reasoning Work Log Plan

## Goal

Expose Pi provider reasoning in T3 Code using the existing activity/work-log path as a low-risk first pass. This avoids adding a new transcript item model until the behavior is proven.

Pi already maps `thinking_delta` events to provider runtime `content.delta` events with `streamKind: "reasoning_text"` in `apps/server/src/provider/Layers/PiAdapter.ts`:

```ts
if (assistantEvent.type === "thinking_delta") {
  return [
    {
      ...makeBaseEvent(context, event),
      type: "content.delta",
      payload: {
        streamKind: "reasoning_text",
        delta: assistantEvent.delta,
        contentIndex: assistantEvent.contentIndex,
      },
    },
  ];
}
```

The missing piece is projecting those provider runtime reasoning deltas into orchestration activities in `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts`.

## First-pass behavior

- Pi-only.
- Convert `reasoning_text` and `reasoning_summary_text` deltas into throttled `task.progress` activities.
- Store compact text in `payload.summary` for existing work-log labels.
- Store accumulated full text in `payload.detail` for future expandable UI.
- Flush final accumulated reasoning as `task.completed` on turn completion/failure/interruption/cancellation.
- Do not add new contracts yet.

## Implementation steps

### 1. Detect reasoning deltas

Near the existing assistant delta detection in `ProviderRuntimeIngestion.ts`:

```ts
const assistantDelta =
  event.type === "content.delta" && event.payload.streamKind === "assistant_text"
    ? event.payload.delta
    : undefined;
```

add:

```ts
const reasoningDelta =
  event.type === "content.delta" &&
  event.provider === "pi" &&
  (event.payload.streamKind === "reasoning_text" ||
    event.payload.streamKind === "reasoning_summary_text")
    ? event.payload.delta
    : undefined;
```

Prefer a provider constant/driver id if one exists instead of the string literal `"pi"`.

### 2. Add compact label helper

```ts
function compactReasoningLabel(text: string) {
  const normalized = text.replace(/\s+/g, " ").trim();

  if (normalized.length === 0) {
    return "Reasoning…";
  }

  if (normalized.length <= 160) {
    return normalized;
  }

  return `${normalized.slice(0, 157)}…`;
}
```

### 3. Buffer reasoning by thread/turn/content index

Avoid one work-log entry per token. Use a small accumulator keyed by thread + turn + content index.

```ts
const reasoningBuffers = new Map<string, string>();
const reasoningLastEmitAt = new Map<string, number>();
const REASONING_ACTIVITY_MIN_INTERVAL_MS = 500;

function reasoningBufferKey(input: {
  readonly threadId: ThreadId;
  readonly turnId?: TurnId;
  readonly contentIndex?: number;
}) {
  return `${input.threadId}:${input.turnId ?? "unknown"}:${input.contentIndex ?? 0}`;
}
```

The exact location should match the existing ingestion service state style.

### 4. Dispatch throttled task progress activities

After computing `reasoningDelta`:

```ts
if (reasoningDelta && reasoningDelta.length > 0) {
  const turnId = toTurnId(event.turnId);
  const key = reasoningBufferKey({
    threadId: thread.id,
    ...(turnId ? { turnId } : {}),
    contentIndex: event.payload.contentIndex,
  });

  const nextText = `${reasoningBuffers.get(key) ?? ""}${reasoningDelta}`;
  reasoningBuffers.set(key, nextText);

  const nowMs = Date.parse(now);
  const lastEmitAt = reasoningLastEmitAt.get(key) ?? 0;

  if (nowMs - lastEmitAt >= REASONING_ACTIVITY_MIN_INTERVAL_MS) {
    reasoningLastEmitAt.set(key, nowMs);

    yield *
      orchestrationEngine.dispatch({
        type: "thread.activity.append",
        commandId: providerCommandId(event, "reasoning-progress"),
        threadId: thread.id,
        activity: {
          id: event.eventId,
          tone: "info",
          kind: "task.progress",
          summary: "Reasoning update",
          payload: {
            source: "provider.reasoning",
            streamKind: event.payload.streamKind,
            summary: compactReasoningLabel(nextText),
            detail: nextText,
          },
          turnId: turnId ?? null,
          createdAt: now,
        },
        createdAt: now,
      });
  }
}
```

If duplicate activity ids become an issue, derive the activity id from the event id plus a suffix or a monotonically increasing sequence used elsewhere in the ingestion layer.

### 5. Flush final reasoning on turn end

On provider turn terminal events, flush buffered reasoning into a final `task.completed` activity.

```ts
if (
  event.type === "turn.completed" ||
  event.type === "turn.failed" ||
  event.type === "turn.cancelled" ||
  event.type === "turn.interrupted"
) {
  const turnId = toTurnId(event.turnId);

  if (turnId) {
    yield *
      flushReasoningActivity({
        event,
        threadId: thread.id,
        turnId,
        createdAt: now,
        commandTag: "reasoning-final",
      });
  }
}
```

Helper shape:

```ts
function* flushReasoningActivity(input: {
  readonly event: ProviderRuntimeEvent;
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly createdAt: IsoDateTime;
  readonly commandTag: string;
}) {
  const keyPrefix = `${input.threadId}:${input.turnId}:`;

  for (const [key, text] of reasoningBuffers) {
    if (!key.startsWith(keyPrefix)) continue;

    const normalized = text.trim();
    if (!normalized) continue;

    yield* orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: providerCommandId(input.event, input.commandTag),
      threadId: input.threadId,
      activity: {
        id: EventId.make(`${input.event.eventId}:reasoning:${key}`),
        tone: "info",
        kind: "task.completed",
        summary: "Reasoning",
        payload: {
          source: "provider.reasoning",
          summary: compactReasoningLabel(normalized),
          detail: normalized,
        },
        turnId: input.turnId,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });

    reasoningBuffers.delete(key);
    reasoningLastEmitAt.delete(key);
  }
}
```

Adjust branded id construction/imports to match the existing file.

## Tests

Primary file:

```txt
apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts
```

Add tests for:

1. Pi `reasoning_text` delta creates a `task.progress` activity.
2. Activity payload includes `source: "provider.reasoning"`.
3. `payload.summary` contains compacted reasoning text.
4. Non-Pi reasoning deltas are ignored for now.
5. Assistant text streaming still works unchanged.
6. Throttling prevents one activity per tiny delta, if throttling is implemented immediately.
7. Turn terminal event flushes accumulated reasoning as `task.completed`.

Example runtime event shape:

```ts
{
  type: "content.delta",
  provider: "pi",
  eventId: EventId.make("event-reasoning-1"),
  threadId: providerThreadId,
  turnId: providerTurnId,
  createdAt,
  payload: {
    streamKind: "reasoning_text",
    delta: "I need to inspect the project structure first.",
    contentIndex: 0,
  },
}
```

Expected activity assertion shape:

```ts
expect(activity.kind).toBe("task.progress");
expect(activity.summary).toBe("Reasoning update");
expect(activity.payload).toMatchObject({
  source: "provider.reasoning",
  streamKind: "reasoning_text",
  summary: "I need to inspect the project structure first.",
  detail: "I need to inspect the project structure first.",
});
```

## Web UI

No first-pass UI changes should be required. `apps/web/src/session-logic.test.ts` already verifies that work-log task entries use `payload.summary` as the label.

Manual verification should confirm that activities with this shape render in the work log:

```ts
{
  kind: "task.progress",
  payload: {
    summary: "...",
  },
}
```

Later improvements can add expandable reasoning details, first-class reasoning transcript items, or a dedicated `thread.activity.update` command to replace append/throttle behavior.
