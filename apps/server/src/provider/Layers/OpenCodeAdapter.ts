import {
  EventId,
  type ModelSelection,
  type OpenCodeSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ThreadTokenUsageSnapshot,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  type ToolLifecycleItemType,
  TurnId,
  type UserInputQuestion,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { OpencodeClient, Part, PermissionRequest, QuestionRequest } from "@opencode-ai/sdk/v2";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { type OpenCodeAdapterShape } from "../Services/OpenCodeAdapter.ts";
import {
  buildOpenCodePermissionRules,
  OpenCodeRuntime,
  OpenCodeRuntimeError,
  openCodeQuestionId,
  openCodeRuntimeErrorDetail,
  parseOpenCodeModelSlug,
  runOpenCodeSdk,
  toOpenCodeFileParts,
  toOpenCodePermissionReply,
  toOpenCodeQuestionAnswers,
  type OpenCodeServerConnection,
} from "../opencodeRuntime.ts";
import * as Option from "effect/Option";

const DEFAULT_PROVIDER = ProviderDriverKind.make("opencode");

interface OpenCodeTurnSnapshot {
  readonly id: TurnId;
  readonly items: Array<unknown>;
}

interface OpenCodeTurnInputSnapshot {
  readonly text: string;
  readonly attachmentCount: number;
  readonly modelSelection?: ModelSelection | undefined;
}

interface OpenCodeTurnOutputSnapshot {
  assistantTextChars: number;
  reasoningTextChars: number;
  completedItemCount: number;
}

type OpenCodeSubscribedEvent =
  Awaited<ReturnType<OpencodeClient["event"]["subscribe"]>> extends {
    readonly stream: AsyncIterable<infer TEvent>;
  }
    ? TEvent
    : never;

interface OpenCodeSessionContext {
  session: ProviderSession;
  readonly client: OpencodeClient;
  readonly server: OpenCodeServerConnection;
  readonly directory: string;
  readonly openCodeSessionId: string;
  readonly pendingPermissions: Map<string, PermissionRequest>;
  readonly pendingQuestions: Map<string, QuestionRequest>;
  readonly messageRoleById: Map<string, "user" | "assistant">;
  readonly partById: Map<string, Part>;
  readonly rawTextByPartId: Map<string, string>;
  readonly emittedTextByPartId: Map<string, string>;
  readonly emittedReasoningTextByPartId: Map<string, string>;
  readonly nextTextByTurnId: Map<TurnId, string>;
  readonly nextReasoningTextById: Map<string, string>;
  readonly completedAssistantPartIds: Set<string>;
  readonly turns: Array<OpenCodeTurnSnapshot>;
  readonly turnInputs: Map<TurnId, OpenCodeTurnInputSnapshot>;
  readonly turnOutputById: Map<TurnId, OpenCodeTurnOutputSnapshot>;
  suppressSubscribedEventsUntilNextTurn: boolean;
  activeTurnId: TurnId | undefined;
  activeAgent: string | undefined;
  activeVariant: string | undefined;
  /**
   * One-shot guard flipped by `stopOpenCodeContext` / `emitUnexpectedExit`.
   * The session lifecycle is owned by `sessionScope`; this Ref exists only
   * so concurrent callers can race the transition safely via `getAndSet`.
   */
  readonly stopped: Ref.Ref<boolean>;
  /**
   * Sole lifecycle handle for the session. Closing this scope:
   *   - aborts the `AbortController` registered as a finalizer
   *     (cancels the in-flight `event.subscribe` fetch),
   *   - interrupts the event-pump and server-exit fibers forked
   *     via `Effect.forkIn(sessionScope)`,
   *   - tears down the OpenCode server process for scope-owned servers.
   */
  readonly sessionScope: Scope.Closeable;
}

export interface OpenCodeErrorDetailInput {
  readonly method: string;
  readonly detail: string;
  readonly threadId?: ThreadId | undefined;
  readonly modelSelection?: ModelSelection | undefined;
  readonly phase?: "load" | "answer" | undefined;
  readonly emptyOutput?: boolean | undefined;
}

export interface OpenCodeTokenUsageEstimateInput {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly modelSelection?: ModelSelection | undefined;
  readonly inputText: string;
  readonly assistantText: string;
  readonly attachmentCount: number;
}

export interface OpenCodeAdapterLiveOptions {
  readonly provider?: ProviderDriverKind;
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
  readonly configContent?:
    | string
    | ((input: {
        readonly modelSelection?: ModelSelection | undefined;
      }) => Effect.Effect<string | undefined>);
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly describeErrorDetail?: (input: OpenCodeErrorDetailInput) => string;
  readonly estimateTokenUsage?: (
    input: OpenCodeTokenUsageEstimateInput,
  ) => Effect.Effect<ThreadTokenUsageSnapshot | undefined>;
  readonly splitInlineThinking?: boolean | undefined;
  readonly failTurnOnStepFailure?: boolean | undefined;
  readonly failTurnOnRetryStatus?: boolean | undefined;
}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

/**
 * Map a tagged OpenCodeRuntimeError produced by {@link runOpenCodeSdk} into
 * the adapter-boundary `ProviderAdapterRequestError`. SDK-method-level call
 * sites pipe through this in `Effect.mapError` so they never build the error
 * shape by hand.
 */
const toRequestError = (
  provider: ProviderDriverKind,
  cause: OpenCodeRuntimeError,
  detail: string = cause.detail,
): ProviderAdapterRequestError =>
  new ProviderAdapterRequestError({
    provider,
    method: cause.operation,
    detail,
    cause: cause.cause,
  });

/**
 * Map a `Cause.squash`-ed failure into a `ProviderAdapterProcessError`. The
 * typed cause is usually an `OpenCodeRuntimeError` (from {@link runOpenCodeSdk}),
 * in which case we preserve its `detail`; otherwise we fall back to
 * {@link openCodeRuntimeErrorDetail} for unknown causes (defects, etc.).
 */
const toProcessError = (
  provider: ProviderDriverKind,
  threadId: ThreadId,
  cause: unknown,
  detail?: string | undefined,
): ProviderAdapterProcessError =>
  new ProviderAdapterProcessError({
    provider,
    threadId,
    detail:
      detail ?? (OpenCodeRuntimeError.is(cause) ? cause.detail : openCodeRuntimeErrorDetail(cause)),
    cause,
  });

type EventBaseInput = {
  readonly threadId: ThreadId;
  readonly turnId?: TurnId | undefined;
  readonly itemId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly createdAt?: string | undefined;
  readonly raw?: unknown;
};

function toToolLifecycleItemType(toolName: string): ToolLifecycleItemType {
  const normalized = toolName.toLowerCase();
  if (normalized.includes("bash") || normalized.includes("command")) {
    return "command_execution";
  }
  if (
    normalized.includes("edit") ||
    normalized.includes("write") ||
    normalized.includes("patch") ||
    normalized.includes("multiedit")
  ) {
    return "file_change";
  }
  if (normalized.includes("web")) {
    return "web_search";
  }
  if (normalized.includes("mcp")) {
    return "mcp_tool_call";
  }
  if (normalized.includes("image")) {
    return "image_view";
  }
  if (
    normalized.includes("task") ||
    normalized.includes("agent") ||
    normalized.includes("subtask")
  ) {
    return "collab_agent_tool_call";
  }
  return "dynamic_tool_call";
}

function mapPermissionToRequestType(
  permission: string,
): "command_execution_approval" | "file_read_approval" | "file_change_approval" | "unknown" {
  switch (permission) {
    case "bash":
      return "command_execution_approval";
    case "read":
      return "file_read_approval";
    case "edit":
      return "file_change_approval";
    default:
      return "unknown";
  }
}

function mapPermissionDecision(reply: "once" | "always" | "reject"): string {
  switch (reply) {
    case "once":
      return "accept";
    case "always":
      return "acceptForSession";
    case "reject":
    default:
      return "decline";
  }
}

function resolveTurnSnapshot(
  context: OpenCodeSessionContext,
  turnId: TurnId,
): OpenCodeTurnSnapshot {
  const existing = context.turns.find((turn) => turn.id === turnId);
  if (existing) {
    return existing;
  }

  const created: OpenCodeTurnSnapshot = { id: turnId, items: [] };
  context.turns.push(created);
  return created;
}

function appendTurnItem(
  context: OpenCodeSessionContext,
  turnId: TurnId | undefined,
  item: unknown,
): void {
  if (!turnId) {
    return;
  }
  resolveTurnSnapshot(context, turnId).items.push(item);
}

function markTurnOutput(
  context: OpenCodeSessionContext,
  turnId: TurnId | undefined,
  patch: Partial<OpenCodeTurnOutputSnapshot>,
): void {
  if (turnId === undefined) {
    return;
  }
  const previous = context.turnOutputById.get(turnId) ?? {
    assistantTextChars: 0,
    reasoningTextChars: 0,
    completedItemCount: 0,
  };
  context.turnOutputById.set(turnId, {
    assistantTextChars: previous.assistantTextChars + (patch.assistantTextChars ?? 0),
    reasoningTextChars: previous.reasoningTextChars + (patch.reasoningTextChars ?? 0),
    completedItemCount: previous.completedItemCount + (patch.completedItemCount ?? 0),
  });
}

function hasTurnOutput(context: OpenCodeSessionContext, turnId: TurnId): boolean {
  const output = context.turnOutputById.get(turnId);
  return output !== undefined && output.assistantTextChars > 0;
}

function isFatalRetryStatusMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("request too large") ||
    lower.includes("tokens per minute") ||
    lower.includes(" tpm") ||
    lower.includes("rate limit") ||
    lower.includes("rate_limit") ||
    lower.includes("too many requests") ||
    lower.includes("429")
  );
}

function ensureSessionContext(
  sessions: ReadonlyMap<ThreadId, OpenCodeSessionContext>,
  threadId: ThreadId,
  provider: ProviderDriverKind,
): OpenCodeSessionContext {
  const session = sessions.get(threadId);
  if (!session) {
    throw new ProviderAdapterSessionNotFoundError({
      provider,
      threadId,
    });
  }
  // `ensureSessionContext` is a sync gate used from both sync helpers and
  // Effect bodies. `Ref.getUnsafe` is an atomic read of the backing cell —
  // no fiber suspension required, which keeps this callable everywhere.
  if (Ref.getUnsafe(session.stopped)) {
    throw new ProviderAdapterSessionClosedError({
      provider,
      threadId,
    });
  }
  return session;
}

function normalizeQuestionRequest(request: QuestionRequest): ReadonlyArray<UserInputQuestion> {
  return request.questions.map((question, index) => ({
    id: openCodeQuestionId(index, question),
    header: question.header,
    question: question.question,
    options: question.options.map((option) => ({
      label: option.label,
      description: option.description,
    })),
    ...(question.multiple ? { multiSelect: true } : {}),
  }));
}

function resolveTextStreamKind(part: Part | undefined): "assistant_text" | "reasoning_text" {
  return part?.type === "reasoning" ? "reasoning_text" : "assistant_text";
}

const INLINE_THINK_OPEN_TAG = "<think>";
const INLINE_THINK_CLOSE_TAG = "</think>";

export interface InlineThinkingSplit {
  readonly assistantText: string;
  readonly reasoningText: string;
  readonly hasInlineThinking: boolean;
}

function withoutTrailingInlineThinkingOpenTagPrefix(text: string): string {
  const maxSuffixLength = Math.min(INLINE_THINK_OPEN_TAG.length - 1, text.length);
  for (let length = maxSuffixLength; length > 0; length -= 1) {
    const suffix = text.slice(-length).toLowerCase();
    if (INLINE_THINK_OPEN_TAG.startsWith(suffix)) {
      return text.slice(0, -length);
    }
  }
  return text;
}

export function splitInlineThinkingText(text: string): InlineThinkingSplit {
  const lower = text.toLowerCase();
  let cursor = 0;
  let inThinking = false;
  let hasInlineThinking = false;
  let assistantText = "";
  let reasoningText = "";

  while (cursor < text.length) {
    if (!inThinking) {
      const openIndex = lower.indexOf(INLINE_THINK_OPEN_TAG, cursor);
      if (openIndex === -1) {
        assistantText = withoutTrailingInlineThinkingOpenTagPrefix(
          assistantText + text.slice(cursor),
        );
        break;
      }
      assistantText += text.slice(cursor, openIndex);
      cursor = openIndex + INLINE_THINK_OPEN_TAG.length;
      inThinking = true;
      hasInlineThinking = true;
      continue;
    }

    const closeIndex = lower.indexOf(INLINE_THINK_CLOSE_TAG, cursor);
    if (closeIndex === -1) {
      reasoningText += text.slice(cursor);
      break;
    }
    reasoningText += text.slice(cursor, closeIndex);
    cursor = closeIndex + INLINE_THINK_CLOSE_TAG.length;
    inThinking = false;
  }

  return { assistantText, reasoningText, hasInlineThinking };
}

function isInlineThinkingTagPrefix(text: string): boolean {
  const trimmed = text.trimStart().toLowerCase();
  return trimmed.length > 0 && INLINE_THINK_OPEN_TAG.startsWith(trimmed);
}

function textFromPart(part: Part): string | undefined {
  switch (part.type) {
    case "text":
    case "reasoning":
      return part.text;
    default:
      return undefined;
  }
}

function commonPrefixLength(left: string, right: string): number {
  let index = 0;
  while (index < left.length && index < right.length && left[index] === right[index]) {
    index += 1;
  }
  return index;
}

function resolveLatestAssistantText(previousText: string | undefined, nextText: string): string {
  if (previousText && previousText.length > nextText.length && previousText.startsWith(nextText)) {
    return previousText;
  }
  return nextText;
}

export function mergeOpenCodeAssistantText(
  previousText: string | undefined,
  nextText: string,
): {
  readonly latestText: string;
  readonly deltaToEmit: string;
} {
  const latestText = resolveLatestAssistantText(previousText, nextText);
  return {
    latestText,
    deltaToEmit: latestText.slice(commonPrefixLength(previousText ?? "", latestText)),
  };
}

export function appendOpenCodeAssistantTextDelta(
  previousText: string,
  delta: string,
): {
  readonly nextText: string;
  readonly deltaToEmit: string;
} {
  return {
    nextText: previousText + delta,
    deltaToEmit: delta,
  };
}

const isoFromEpochMs = (value: number) =>
  DateTime.make(value).pipe(
    Option.match({
      onNone: () => undefined,
      onSome: DateTime.formatIso,
    }),
  );

function messageRoleForPart(
  context: OpenCodeSessionContext,
  part: Pick<Part, "messageID" | "type">,
): "assistant" | "user" | undefined {
  const known = context.messageRoleById.get(part.messageID);
  if (known) {
    return known;
  }
  return part.type === "tool" ? "assistant" : undefined;
}

function detailFromToolPart(part: Extract<Part, { type: "tool" }>): string | undefined {
  switch (part.state.status) {
    case "completed":
      return part.state.output;
    case "error":
      return part.state.error;
    case "running":
      return part.state.title;
    default:
      return undefined;
  }
}

function toolStateCreatedAt(part: Extract<Part, { type: "tool" }>): string | undefined {
  switch (part.state.status) {
    case "running":
      return isoFromEpochMs(part.state.time.start);
    case "completed":
    case "error":
      return isoFromEpochMs(part.state.time.end);
    default:
      return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function detailFromKnownErrorShape(error: unknown, depth = 0): string | undefined {
  if (depth > 4) return undefined;
  if (typeof error === "string") {
    const trimmed = error.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim();
  }
  if (!isRecord(error)) {
    return undefined;
  }

  const direct =
    stringField(error, "message") ??
    stringField(error, "detail") ??
    stringField(error, "error") ??
    stringField(error, "reason") ??
    stringField(error, "statusText");
  if (direct) return direct;

  for (const field of ["data", "body", "response", "cause", "error", "details", "info"]) {
    const nested = detailFromKnownErrorShape(error[field], depth + 1);
    if (nested) return nested;
  }

  return undefined;
}

export function sessionErrorMessage(error: unknown): string {
  return detailFromKnownErrorShape(error) ?? "OpenCode session failed.";
}

function updateProviderSession(
  context: OpenCodeSessionContext,
  patch: Partial<ProviderSession>,
  options?: {
    readonly clearActiveTurnId?: boolean;
    readonly clearLastError?: boolean;
  },
): Effect.Effect<ProviderSession> {
  return Effect.gen(function* () {
    const updatedAt = yield* nowIso;
    const nextSession = {
      ...context.session,
      ...patch,
      updatedAt,
    } as ProviderSession & Record<string, unknown>;
    const mutableSession = nextSession as Record<string, unknown>;
    if (options?.clearActiveTurnId) {
      delete mutableSession.activeTurnId;
    }
    if (options?.clearLastError) {
      delete mutableSession.lastError;
    }
    context.session = nextSession;
    return nextSession;
  });
}

const stopOpenCodeContext = Effect.fn("stopOpenCodeContext")(function* (
  context: OpenCodeSessionContext,
) {
  // Race-safe one-shot: first caller flips the flag, everyone else no-ops.
  if (yield* Ref.getAndSet(context.stopped, true)) {
    return false;
  }

  // Best-effort remote abort. The scope close below tears down the local
  // handles (event-pump fiber, server-exit fiber, event-subscribe fetch),
  // but we still want to tell OpenCode that this session is done.
  yield* runOpenCodeSdk("session.abort", () =>
    context.client.session.abort({ sessionID: context.openCodeSessionId }),
  ).pipe(Effect.ignore({ log: true }));

  // Closing the session scope interrupts every fiber forked into it and
  // runs each finalizer we registered — the `AbortController.abort()` call,
  // the child-process termination, etc.
  yield* Scope.close(context.sessionScope, Exit.void);
  return true;
});

export function makeOpenCodeAdapter(
  openCodeSettings: OpenCodeSettings,
  options?: OpenCodeAdapterLiveOptions,
) {
  return Effect.gen(function* () {
    const provider = options?.provider ?? DEFAULT_PROVIDER;
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make(provider);
    const describeErrorDetail = (input: OpenCodeErrorDetailInput) =>
      options?.describeErrorDetail?.(input) ?? input.detail;
    const mapOpenCodeRequestError = (cause: OpenCodeRuntimeError) =>
      toRequestError(
        provider,
        cause,
        describeErrorDetail({ method: cause.operation, detail: cause.detail }),
      );
    const serverConfig = yield* ServerConfig;
    const openCodeRuntime = yield* OpenCodeRuntime;
    const crypto = yield* Crypto.Crypto;
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
            stream: "native",
          })
        : undefined);
    // Only close loggers we created. If the caller passed one in via
    // `options.nativeEventLogger`, they own its lifecycle.
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;
    const runtimeEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ThreadId, OpenCodeSessionContext>();
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate OpenCode runtime identifier.",
            cause,
          }),
      ),
    );
    const resolveConfigContent = (input: {
      readonly modelSelection?: ModelSelection | undefined;
    }) => {
      const configContent = options?.configContent;
      if (typeof configContent === "function") return configContent(input);
      return Effect.succeed(configContent);
    };

    const buildEventBase = (input: EventBaseInput) =>
      Effect.all({
        eventId: randomUUIDv4.pipe(Effect.map(EventId.make)),
        createdAt: input.createdAt === undefined ? nowIso : Effect.succeed(input.createdAt),
      }).pipe(
        Effect.map(({ eventId, createdAt }) => ({
          eventId,
          provider,
          threadId: input.threadId,
          createdAt,
          ...(input.turnId ? { turnId: input.turnId } : {}),
          ...(input.itemId ? { itemId: RuntimeItemId.make(input.itemId) } : {}),
          ...(input.requestId ? { requestId: RuntimeRequestId.make(input.requestId) } : {}),
          ...(input.raw !== undefined
            ? {
                raw: {
                  source: "opencode.sdk.event" as const,
                  payload: input.raw,
                },
              }
            : {}),
        })),
      );

    // Layer-level finalizer: when the adapter layer shuts down, stop every
    // session. Each session's `Scope.close` tears down its spawned OpenCode
    // server (via the `ChildProcessSpawner` finalizer installed in
    // `startOpenCodeServerProcess`) and interrupts the forked event/exit
    // fibers. Consumers that can't reason about Effect scopes therefore
    // cannot leak OpenCode child processes by forgetting to call `stopAll`.
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const contexts = [...sessions.values()];
        sessions.clear();
        // `ignoreCause` swallows both typed failures (none here) and defects
        // from throwing scope finalizers so a sibling's death can't interrupt
        // the remaining cleanups.
        yield* Effect.forEach(
          contexts,
          (context) => Effect.ignoreCause(stopOpenCodeContext(context)),
          { concurrency: "unbounded", discard: true },
        );
        // Close the logger AFTER session teardown so any final lifecycle
        // events emitted during shutdown still get written. `close` flushes
        // the `Logger.batched` window and closes each per-thread
        // `RotatingFileSink` handle owned by the logger's internal scope.
        if (managedNativeEventLogger !== undefined) {
          yield* managedNativeEventLogger.close();
        }
      }).pipe(Effect.ensuring(Queue.shutdown(runtimeEvents))),
    );

    const emit = (event: ProviderRuntimeEvent) =>
      Queue.offer(runtimeEvents, event).pipe(Effect.asVoid);
    const writeNativeEvent = (
      threadId: ThreadId,
      event: {
        readonly observedAt: string;
        readonly event: Record<string, unknown>;
      },
    ) => (nativeEventLogger ? nativeEventLogger.write(event, threadId) : Effect.void);
    const writeNativeEventBestEffort = (
      threadId: ThreadId,
      event: {
        readonly observedAt: string;
        readonly event: Record<string, unknown>;
      },
    ) => writeNativeEvent(threadId, event).pipe(Effect.catchCause(() => Effect.void));

    const emitEstimatedTokenUsage = Effect.fn("emitEstimatedTokenUsage")(function* (
      context: OpenCodeSessionContext,
      turnId: TurnId,
      raw: unknown,
    ) {
      const estimateTokenUsage = options?.estimateTokenUsage;
      if (!estimateTokenUsage) {
        return;
      }

      const turnInput = context.turnInputs.get(turnId);
      const allInputText = [...context.turnInputs.values()]
        .map((input) => input.text)
        .filter((value) => value.length > 0)
        .join("\n\n");
      const attachmentCount = [...context.turnInputs.values()].reduce(
        (total, input) => total + input.attachmentCount,
        0,
      );
      const assistantText = [...context.emittedTextByPartId.values()]
        .filter((value) => value.length > 0)
        .join("\n\n");
      const usage = yield* estimateTokenUsage({
        threadId: context.session.threadId,
        turnId,
        modelSelection: turnInput?.modelSelection,
        inputText: allInputText,
        assistantText,
        attachmentCount,
      });
      if (!usage) {
        return;
      }

      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId,
          raw,
        })),
        type: "thread.token-usage.updated",
        payload: { usage },
      });
    });

    const emitUnexpectedExit = Effect.fn("emitUnexpectedExit")(function* (
      context: OpenCodeSessionContext,
      message: string,
    ) {
      // Atomic one-shot: two fibers can race here (the event-pump on stream
      // failure and the server-exit watcher). `getAndSet` flips the flag in
      // a single step so the loser observes `true` and returns; a plain
      // `Ref.get` would let both racers slip past and emit duplicates.
      if (yield* Ref.getAndSet(context.stopped, true)) {
        return;
      }
      const turnId = context.activeTurnId;
      sessions.delete(context.session.threadId);
      // Emit lifecycle events BEFORE tearing down the scope. Both call sites
      // run this inside a fiber forked via `Effect.forkIn(context.sessionScope)`;
      // closing that scope triggers the fiber-interrupt finalizer, so any
      // subsequent yield point would unwind and silently drop these emits.
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId,
        })),
        type: "runtime.error",
        payload: {
          message,
          class: "transport_error",
        },
      }).pipe(Effect.ignore);
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId,
        })),
        type: "session.exited",
        payload: {
          reason: message,
          recoverable: false,
          exitKind: "error",
        },
      }).pipe(Effect.ignore);
      // Inline the teardown that `stopOpenCodeContext` would do; we can't
      // delegate to it because our `getAndSet` above already flipped the
      // one-shot guard, so the call would no-op.
      yield* runOpenCodeSdk("session.abort", () =>
        context.client.session.abort({ sessionID: context.openCodeSessionId }),
      ).pipe(Effect.ignore({ log: true }));
      yield* Scope.close(context.sessionScope, Exit.void);
    });

    const clearAssistantTextCaches = (context: OpenCodeSessionContext, partId: string) => {
      context.rawTextByPartId.delete(partId);
      context.emittedTextByPartId.delete(partId);
      context.emittedReasoningTextByPartId.delete(partId);
    };

    /** Emit content.delta and item.completed events for an assistant text part. */
    const emitAssistantTextDelta = Effect.fn("emitAssistantTextDelta")(function* (
      context: OpenCodeSessionContext,
      part: Part,
      turnId: TurnId | undefined,
      raw: unknown,
    ) {
      const text = textFromPart(part);
      if (text === undefined) {
        return;
      }

      if (context.completedAssistantPartIds.has(part.id)) {
        return;
      }

      context.rawTextByPartId.set(part.id, text);
      const createdAt =
        (part.type === "text" || part.type === "reasoning") && part.time !== undefined
          ? isoFromEpochMs(part.time.start)
          : undefined;

      const emitTextDelta = (input: {
        readonly streamKind: "assistant_text" | "reasoning_text";
        readonly delta: string;
      }) =>
        buildEventBase({
          threadId: context.session.threadId,
          turnId,
          itemId: part.id,
          createdAt,
          raw,
        }).pipe(
          Effect.flatMap((base) =>
            emit({
              ...base,
              type: "content.delta",
              payload: input,
            }),
          ),
        );

      if (options?.splitInlineThinking === true && part.type === "text") {
        const split = splitInlineThinkingText(text);
        if (!split.hasInlineThinking && isInlineThinkingTagPrefix(text)) {
          return;
        }

        if (split.hasInlineThinking) {
          const reasoningUpdate = mergeOpenCodeAssistantText(
            context.emittedReasoningTextByPartId.get(part.id),
            split.reasoningText,
          );
          context.emittedReasoningTextByPartId.set(part.id, reasoningUpdate.latestText);
          if (reasoningUpdate.deltaToEmit.length > 0) {
            yield* emitTextDelta({
              streamKind: "reasoning_text",
              delta: reasoningUpdate.deltaToEmit,
            });
          }

          const assistantUpdate = mergeOpenCodeAssistantText(
            context.emittedTextByPartId.get(part.id),
            split.assistantText,
          );
          context.emittedTextByPartId.set(part.id, assistantUpdate.latestText);
          context.partById.set(part.id, {
            ...part,
            text: assistantUpdate.latestText,
          } satisfies Part);
          if (assistantUpdate.deltaToEmit.length > 0) {
            markTurnOutput(context, turnId, {
              assistantTextChars: assistantUpdate.deltaToEmit.length,
            });
            yield* emitTextDelta({
              streamKind: "assistant_text",
              delta: assistantUpdate.deltaToEmit,
            });
          }

          if (part.time?.end !== undefined && !context.completedAssistantPartIds.has(part.id)) {
            context.completedAssistantPartIds.add(part.id);
            yield* emit({
              ...(yield* buildEventBase({
                threadId: context.session.threadId,
                turnId,
                itemId: part.id,
                createdAt: isoFromEpochMs(part.time.end),
                raw,
              })),
              type: "item.completed",
              payload: {
                itemType: "assistant_message",
                status: "completed",
                title: "Assistant message",
                ...(assistantUpdate.latestText.length > 0
                  ? { detail: assistantUpdate.latestText }
                  : {}),
              },
            });
            markTurnOutput(context, turnId, { completedItemCount: 1 });
            clearAssistantTextCaches(context, part.id);
          }
          return;
        }
      }

      const previousText = context.emittedTextByPartId.get(part.id);
      const { latestText, deltaToEmit } = mergeOpenCodeAssistantText(previousText, text);
      context.emittedTextByPartId.set(part.id, latestText);
      if (latestText !== text) {
        context.partById.set(
          part.id,
          (part.type === "text" || part.type === "reasoning"
            ? { ...part, text: latestText }
            : part) satisfies Part,
        );
      }
      if (deltaToEmit.length > 0) {
        if (resolveTextStreamKind(part) === "assistant_text") {
          markTurnOutput(context, turnId, { assistantTextChars: deltaToEmit.length });
        }
        yield* emitTextDelta({
          streamKind: resolveTextStreamKind(part),
          delta: deltaToEmit,
        });
      }

      if (
        part.type === "text" &&
        part.time?.end !== undefined &&
        !context.completedAssistantPartIds.has(part.id)
      ) {
        context.completedAssistantPartIds.add(part.id);
        yield* emit({
          ...(yield* buildEventBase({
            threadId: context.session.threadId,
            turnId,
            itemId: part.id,
            createdAt: isoFromEpochMs(part.time.end),
            raw,
          })),
          type: "item.completed",
          payload: {
            itemType: "assistant_message",
            status: "completed",
            title: "Assistant message",
            ...(latestText.length > 0 ? { detail: latestText } : {}),
          },
        });
        markTurnOutput(context, turnId, { completedItemCount: 1 });
        clearAssistantTextCaches(context, part.id);
      }
    });

    const emitNextTextDelta = Effect.fn("emitNextTextDelta")(function* (
      context: OpenCodeSessionContext,
      input: {
        readonly turnId: TurnId | undefined;
        readonly itemId: string;
        readonly streamKind: "assistant_text" | "reasoning_text";
        readonly delta: string;
        readonly createdAt?: string | undefined;
        readonly raw: unknown;
      },
    ) {
      if (input.delta.length === 0) {
        return;
      }
      if (input.streamKind === "assistant_text") {
        markTurnOutput(context, input.turnId, { assistantTextChars: input.delta.length });
      } else {
        markTurnOutput(context, input.turnId, { reasoningTextChars: input.delta.length });
      }
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId: input.turnId,
          itemId: input.itemId,
          createdAt: input.createdAt,
          raw: input.raw,
        })),
        type: "content.delta",
        payload: {
          streamKind: input.streamKind,
          delta: input.delta,
        },
      });
    });

    const emitNextTextEnded = Effect.fn("emitNextTextEnded")(function* (
      context: OpenCodeSessionContext,
      input: {
        readonly turnId: TurnId | undefined;
        readonly itemId: string;
        readonly text: string;
        readonly createdAt?: string | undefined;
        readonly raw: unknown;
      },
    ) {
      if (input.turnId) {
        const previous = context.nextTextByTurnId.get(input.turnId);
        const { latestText, deltaToEmit } = mergeOpenCodeAssistantText(previous, input.text);
        context.nextTextByTurnId.set(input.turnId, latestText);
        yield* emitNextTextDelta(context, {
          turnId: input.turnId,
          itemId: input.itemId,
          streamKind: "assistant_text",
          delta: deltaToEmit,
          createdAt: input.createdAt,
          raw: input.raw,
        });
      }
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId: input.turnId,
          itemId: input.itemId,
          createdAt: input.createdAt,
          raw: input.raw,
        })),
        type: "item.completed",
        payload: {
          itemType: "assistant_message",
          status: "completed",
          title: "Assistant message",
          ...(input.text.length > 0 ? { detail: input.text } : {}),
        },
      });
      markTurnOutput(context, input.turnId, { completedItemCount: 1 });
    });

    const failActiveTurnAndAbort = Effect.fn("failActiveTurnAndAbort")(function* (
      context: OpenCodeSessionContext,
      input: {
        readonly turnId: TurnId;
        readonly message: string;
        readonly detail: unknown;
        readonly raw: unknown;
      },
    ) {
      context.activeTurnId = undefined;
      context.activeAgent = undefined;
      context.activeVariant = undefined;
      context.suppressSubscribedEventsUntilNextTurn = true;
      yield* updateProviderSession(
        context,
        {
          status: "error",
          lastError: input.message,
        },
        { clearActiveTurnId: true },
      );
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId: input.turnId,
          raw: input.raw,
        })),
        type: "turn.completed",
        payload: {
          state: "failed",
          errorMessage: input.message,
        },
      });
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId: input.turnId,
          raw: input.raw,
        })),
        type: "runtime.error",
        payload: {
          message: input.message,
          class: "provider_error",
          detail: input.detail,
        },
      });
      yield* runOpenCodeSdk("session.abort", () =>
        context.client.session.abort({ sessionID: context.openCodeSessionId }),
      ).pipe(Effect.ignore);
    });

    const handleSubscribedEvent = Effect.fn("handleSubscribedEvent")(function* (
      context: OpenCodeSessionContext,
      event: OpenCodeSubscribedEvent,
    ) {
      const payloadSessionId =
        "properties" in event ? (event.properties as { sessionID?: unknown }).sessionID : undefined;
      if (payloadSessionId !== context.openCodeSessionId) {
        return;
      }

      const turnId = context.activeTurnId;
      yield* writeNativeEventBestEffort(context.session.threadId, {
        observedAt: yield* nowIso,
        event: {
          provider,
          threadId: context.session.threadId,
          providerThreadId: context.openCodeSessionId,
          type: event.type,
          ...(turnId ? { turnId } : {}),
          payload: event,
        },
      });

      if (context.suppressSubscribedEventsUntilNextTurn) {
        return;
      }

      switch (event.type) {
        case "message.updated": {
          context.messageRoleById.set(event.properties.info.id, event.properties.info.role);
          if (event.properties.info.role === "assistant") {
            for (const part of context.partById.values()) {
              if (part.messageID !== event.properties.info.id) {
                continue;
              }
              yield* emitAssistantTextDelta(context, part, turnId, event);
            }
          }
          break;
        }

        case "message.removed": {
          context.messageRoleById.delete(event.properties.messageID);
          break;
        }

        case "message.part.delta": {
          const existingPart = context.partById.get(event.properties.partID);
          if (!existingPart) {
            break;
          }
          const role = messageRoleForPart(context, existingPart);
          if (role !== "assistant") {
            break;
          }
          const delta = event.properties.delta;
          if (delta.length === 0) {
            break;
          }
          const previousRawText =
            context.rawTextByPartId.get(event.properties.partID) ??
            textFromPart(existingPart) ??
            "";
          const nextRawText = previousRawText + delta;
          if (existingPart.type === "text" || existingPart.type === "reasoning") {
            const nextPart = {
              ...existingPart,
              text: nextRawText,
            } satisfies Part;
            context.partById.set(event.properties.partID, nextPart);
            yield* emitAssistantTextDelta(context, nextPart, turnId, event);
          }
          break;
        }

        case "message.part.updated": {
          const part = event.properties.part;
          context.partById.set(part.id, part);
          const messageRole = messageRoleForPart(context, part);

          if (messageRole === "assistant") {
            yield* emitAssistantTextDelta(context, part, turnId, event);
          }

          if (part.type === "tool") {
            const itemType = toToolLifecycleItemType(part.tool);
            const title =
              part.state.status === "running" ? (part.state.title ?? part.tool) : part.tool;
            const detail = detailFromToolPart(part);
            const payload = {
              itemType,
              ...(part.state.status === "error"
                ? { status: "failed" as const }
                : part.state.status === "completed"
                  ? { status: "completed" as const }
                  : { status: "inProgress" as const }),
              ...(title ? { title } : {}),
              ...(detail ? { detail } : {}),
              data: {
                tool: part.tool,
                state: part.state,
              },
            };
            const runtimeEvent: ProviderRuntimeEvent = {
              ...(yield* buildEventBase({
                threadId: context.session.threadId,
                turnId,
                itemId: part.callID,
                createdAt: toolStateCreatedAt(part),
                raw: event,
              })),
              type:
                part.state.status === "pending"
                  ? "item.started"
                  : part.state.status === "completed" || part.state.status === "error"
                    ? "item.completed"
                    : "item.updated",
              payload,
            };
            appendTurnItem(context, turnId, part);
            if (runtimeEvent.type === "item.completed") {
              markTurnOutput(context, turnId, { completedItemCount: 1 });
            }
            yield* emit(runtimeEvent);
          }
          break;
        }

        case "session.next.text.started": {
          if (turnId) {
            context.nextTextByTurnId.set(turnId, "");
          }
          break;
        }

        case "session.next.text.delta": {
          const delta = event.properties.delta;
          if (turnId && delta.length > 0) {
            context.nextTextByTurnId.set(
              turnId,
              (context.nextTextByTurnId.get(turnId) ?? "") + delta,
            );
          }
          yield* emitNextTextDelta(context, {
            turnId,
            itemId: turnId ? `session-next-text:${turnId}` : event.id,
            streamKind: "assistant_text",
            delta,
            createdAt: isoFromEpochMs(event.properties.timestamp),
            raw: event,
          });
          break;
        }

        case "session.next.text.ended": {
          yield* emitNextTextEnded(context, {
            turnId,
            itemId: turnId ? `session-next-text:${turnId}` : event.id,
            text: event.properties.text,
            createdAt: isoFromEpochMs(event.properties.timestamp),
            raw: event,
          });
          if (turnId) {
            context.nextTextByTurnId.delete(turnId);
          }
          break;
        }

        case "session.next.reasoning.started": {
          context.nextReasoningTextById.set(event.properties.reasoningID, "");
          break;
        }

        case "session.next.reasoning.delta": {
          const delta = event.properties.delta;
          if (delta.length > 0) {
            context.nextReasoningTextById.set(
              event.properties.reasoningID,
              (context.nextReasoningTextById.get(event.properties.reasoningID) ?? "") + delta,
            );
          }
          yield* emitNextTextDelta(context, {
            turnId,
            itemId: event.properties.reasoningID,
            streamKind: "reasoning_text",
            delta,
            createdAt: isoFromEpochMs(event.properties.timestamp),
            raw: event,
          });
          break;
        }

        case "session.next.reasoning.ended": {
          const previous = context.nextReasoningTextById.get(event.properties.reasoningID);
          const { deltaToEmit } = mergeOpenCodeAssistantText(previous, event.properties.text);
          yield* emitNextTextDelta(context, {
            turnId,
            itemId: event.properties.reasoningID,
            streamKind: "reasoning_text",
            delta: deltaToEmit,
            createdAt: isoFromEpochMs(event.properties.timestamp),
            raw: event,
          });
          context.nextReasoningTextById.delete(event.properties.reasoningID);
          break;
        }

        case "session.next.step.failed": {
          const rawMessage = sessionErrorMessage(event.properties.error);
          const turnInput = turnId ? context.turnInputs.get(turnId) : undefined;
          const message = describeErrorDetail({
            method: "session.next.step.failed",
            detail: rawMessage,
            threadId: context.session.threadId,
            modelSelection: turnInput?.modelSelection,
            phase: "answer",
          });
          yield* updateProviderSession(context, {
            status: "running",
            activeTurnId: turnId,
            lastError: message,
          });
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              raw: event,
            })),
            type: "runtime.warning",
            payload: {
              message,
              detail: event.properties.error,
            },
          });
          if (options?.failTurnOnStepFailure === true && turnId) {
            yield* failActiveTurnAndAbort(context, {
              turnId,
              message,
              detail: event.properties.error,
              raw: event,
            });
          }
          break;
        }

        case "permission.asked": {
          context.pendingPermissions.set(event.properties.id, event.properties);
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              requestId: event.properties.id,
              raw: event,
            })),
            type: "request.opened",
            payload: {
              requestType: mapPermissionToRequestType(event.properties.permission),
              detail:
                event.properties.patterns.length > 0
                  ? event.properties.patterns.join("\n")
                  : event.properties.permission,
              args: event.properties.metadata,
            },
          });
          break;
        }

        case "permission.replied": {
          context.pendingPermissions.delete(event.properties.requestID);
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              requestId: event.properties.requestID,
              raw: event,
            })),
            type: "request.resolved",
            payload: {
              requestType: "unknown",
              decision: mapPermissionDecision(event.properties.reply),
            },
          });
          break;
        }

        case "question.asked": {
          context.pendingQuestions.set(event.properties.id, event.properties);
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              requestId: event.properties.id,
              raw: event,
            })),
            type: "user-input.requested",
            payload: {
              questions: normalizeQuestionRequest(event.properties),
            },
          });
          break;
        }

        case "question.replied": {
          const request = context.pendingQuestions.get(event.properties.requestID);
          context.pendingQuestions.delete(event.properties.requestID);
          const answers = Object.fromEntries(
            (request?.questions ?? []).map((question, index) => [
              openCodeQuestionId(index, question),
              event.properties.answers[index]?.join(", ") ?? "",
            ]),
          );
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              requestId: event.properties.requestID,
              raw: event,
            })),
            type: "user-input.resolved",
            payload: { answers },
          });
          break;
        }

        case "question.rejected": {
          context.pendingQuestions.delete(event.properties.requestID);
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              requestId: event.properties.requestID,
              raw: event,
            })),
            type: "user-input.resolved",
            payload: { answers: {} },
          });
          break;
        }

        case "session.status": {
          if (event.properties.status.type === "busy") {
            yield* updateProviderSession(context, {
              status: "running",
              activeTurnId: turnId,
            });
          }

          if (event.properties.status.type === "retry") {
            if (
              options?.failTurnOnRetryStatus === true &&
              turnId &&
              isFatalRetryStatusMessage(event.properties.status.message)
            ) {
              const turnInput = context.turnInputs.get(turnId);
              const message = describeErrorDetail({
                method: "session.status.retry",
                detail: event.properties.status.message,
                threadId: context.session.threadId,
                modelSelection: turnInput?.modelSelection,
                phase: "answer",
              });
              yield* emit({
                ...(yield* buildEventBase({
                  threadId: context.session.threadId,
                  turnId,
                  raw: event,
                })),
                type: "runtime.warning",
                payload: {
                  message,
                  detail: event.properties.status,
                },
              });
              yield* failActiveTurnAndAbort(context, {
                turnId,
                message,
                detail: event.properties.status,
                raw: event,
              });
              break;
            }
            yield* emit({
              ...(yield* buildEventBase({
                threadId: context.session.threadId,
                turnId,
                raw: event,
              })),
              type: "runtime.warning",
              payload: {
                message: event.properties.status.message,
                detail: event.properties.status,
              },
            });
            break;
          }

          if (event.properties.status.type === "idle" && turnId) {
            const turnInput = context.turnInputs.get(turnId);
            const lastHarnessError = context.session.lastError?.trim();
            if (
              (lastHarnessError && lastHarnessError.length > 0) ||
              !hasTurnOutput(context, turnId)
            ) {
              const message =
                lastHarnessError && lastHarnessError.length > 0
                  ? lastHarnessError
                  : describeErrorDetail({
                      method: "session.status",
                      detail: "OpenCode returned empty output.",
                      threadId: context.session.threadId,
                      modelSelection: turnInput?.modelSelection,
                      phase: "answer",
                      emptyOutput: true,
                    });
              context.activeTurnId = undefined;
              context.suppressSubscribedEventsUntilNextTurn = true;
              yield* updateProviderSession(
                context,
                {
                  status: "error",
                  lastError: message,
                },
                { clearActiveTurnId: true },
              );
              yield* emit({
                ...(yield* buildEventBase({
                  threadId: context.session.threadId,
                  turnId,
                  raw: event,
                })),
                type: "turn.completed",
                payload: {
                  state: "failed",
                  errorMessage: message,
                },
              });
              yield* emit({
                ...(yield* buildEventBase({
                  threadId: context.session.threadId,
                  turnId,
                  raw: event,
                })),
                type: "runtime.error",
                payload: {
                  message,
                  class: "provider_error",
                  detail: event.properties.status,
                },
              });
              break;
            }
            context.activeTurnId = undefined;
            yield* updateProviderSession(context, { status: "ready" }, { clearActiveTurnId: true });
            yield* emitEstimatedTokenUsage(context, turnId, event);
            yield* emit({
              ...(yield* buildEventBase({
                threadId: context.session.threadId,
                turnId,
                raw: event,
              })),
              type: "turn.completed",
              payload: {
                state: "completed",
              },
            });
          }
          break;
        }

        case "session.error": {
          const rawMessage = sessionErrorMessage(event.properties.error);
          const activeTurnId = context.activeTurnId;
          const turnInput = activeTurnId ? context.turnInputs.get(activeTurnId) : undefined;
          const message = describeErrorDetail({
            method: "session.error",
            detail: rawMessage,
            threadId: context.session.threadId,
            modelSelection: turnInput?.modelSelection,
            phase: "answer",
          });
          context.activeTurnId = undefined;
          context.suppressSubscribedEventsUntilNextTurn = true;
          yield* updateProviderSession(
            context,
            {
              status: "error",
              lastError: message,
            },
            { clearActiveTurnId: true },
          );
          if (activeTurnId) {
            yield* emit({
              ...(yield* buildEventBase({
                threadId: context.session.threadId,
                turnId: activeTurnId,
                raw: event,
              })),
              type: "turn.completed",
              payload: {
                state: "failed",
                errorMessage: message,
              },
            });
          }
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId: activeTurnId,
              raw: event,
            })),
            type: "runtime.error",
            payload: {
              message,
              class: "provider_error",
              detail: event.properties.error,
            },
          });
          break;
        }

        default:
          break;
      }
    });

    const startEventPump = Effect.fn("startEventPump")(function* (context: OpenCodeSessionContext) {
      // One AbortController per session scope. The finalizer fires when
      // the scope closes (explicit stop, unexpected exit, or layer
      // shutdown) and cancels the in-flight `event.subscribe` fetch so
      // the async iterable unwinds cleanly.
      const eventsAbortController = new AbortController();
      yield* Scope.addFinalizer(
        context.sessionScope,
        Effect.sync(() => eventsAbortController.abort()),
      );

      // Fibers forked into `context.sessionScope` are interrupted
      // automatically when the scope closes — no bookkeeping required.
      yield* Effect.flatMap(
        runOpenCodeSdk("event.subscribe", () =>
          context.client.event.subscribe(undefined, {
            signal: eventsAbortController.signal,
          }),
        ),
        (subscription) =>
          Stream.fromAsyncIterable(
            subscription.stream,
            (cause) =>
              new OpenCodeRuntimeError({
                operation: "event.subscribe",
                detail: openCodeRuntimeErrorDetail(cause),
                cause,
              }),
          ).pipe(Stream.runForEach((event) => handleSubscribedEvent(context, event))),
      ).pipe(
        Effect.exit,
        Effect.flatMap((exit) =>
          Effect.gen(function* () {
            // Expected paths: caller aborted the fetch or the session
            // has already been marked stopped. Treat as a clean exit.
            if (eventsAbortController.signal.aborted || (yield* Ref.get(context.stopped))) {
              return;
            }
            if (Exit.isFailure(exit)) {
              yield* emitUnexpectedExit(
                context,
                openCodeRuntimeErrorDetail(Cause.squash(exit.cause)),
              );
            }
          }),
        ),
        Effect.forkIn(context.sessionScope),
      );

      if (!context.server.external && context.server.exitCode !== null) {
        yield* context.server.exitCode.pipe(
          Effect.flatMap((code) =>
            Effect.gen(function* () {
              if (yield* Ref.get(context.stopped)) {
                return;
              }
              yield* emitUnexpectedExit(context, `OpenCode server exited unexpectedly (${code}).`);
            }),
          ),
          Effect.forkIn(context.sessionScope),
        );
      }
    });

    const startSession: OpenCodeAdapterShape["startSession"] = Effect.fn("startSession")(
      function* (input) {
        const binaryPath = openCodeSettings.binaryPath;
        const serverUrl = openCodeSettings.serverUrl;
        const serverPassword = openCodeSettings.serverPassword;
        const directory = input.cwd ?? serverConfig.cwd;
        const existing = sessions.get(input.threadId);
        if (existing) {
          yield* stopOpenCodeContext(existing);
          sessions.delete(input.threadId);
        }

        const started = yield* Effect.gen(function* () {
          const sessionScope = yield* Scope.make();
          const startedExit = yield* Effect.exit(
            Effect.gen(function* () {
              // The runtime binds the server's lifetime to the Scope.Scope
              // we provide below — closing `sessionScope` kills the child
              // process automatically. No manual `server.close()` needed.
              const configContent = yield* resolveConfigContent({
                modelSelection: input.modelSelection,
              });
              const server = yield* openCodeRuntime.connectToOpenCodeServer({
                binaryPath,
                serverUrl,
                ...(options?.environment ? { environment: options.environment } : {}),
                ...(configContent !== undefined ? { configContent } : {}),
              });
              const client = openCodeRuntime.createOpenCodeSdkClient({
                baseUrl: server.url,
                directory,
                ...(server.external && serverPassword ? { serverPassword } : {}),
              });
              const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
              if (mcpSession && !server.external) {
                yield* runOpenCodeSdk("mcp.add", () =>
                  client.mcp.add({
                    name: "t3-code",
                    config: {
                      type: "remote",
                      url: mcpSession.endpoint,
                      headers: {
                        Authorization: mcpSession.authorizationHeader,
                      },
                      oauth: false,
                    },
                  }),
                );
              }
              const openCodeSession = yield* runOpenCodeSdk("session.create", () =>
                client.session.create({
                  title: `T3 Code ${input.threadId}`,
                  permission: buildOpenCodePermissionRules(input.runtimeMode),
                }),
              );
              if (!openCodeSession.data) {
                return yield* new OpenCodeRuntimeError({
                  operation: "session.create",
                  detail: "OpenCode session.create returned no session payload.",
                });
              }
              return {
                sessionScope,
                server,
                client,
                openCodeSession: openCodeSession.data,
              };
            }).pipe(Effect.provideService(Scope.Scope, sessionScope)),
          );
          if (Exit.isFailure(startedExit)) {
            yield* Scope.close(sessionScope, Exit.void).pipe(Effect.ignore);
            const cause = Cause.squash(startedExit.cause);
            const detail = OpenCodeRuntimeError.is(cause)
              ? cause.detail
              : openCodeRuntimeErrorDetail(cause);
            return yield* toProcessError(
              provider,
              input.threadId,
              cause,
              describeErrorDetail({
                method: OpenCodeRuntimeError.is(cause) ? cause.operation : "startSession",
                detail,
                threadId: input.threadId,
                modelSelection: input.modelSelection,
                phase: "load",
              }),
            );
          }
          return startedExit.value;
        });

        // Guard against a concurrent startSession call that may have raced
        // and already inserted a session while we were awaiting async work.
        const raceWinner = sessions.get(input.threadId);
        if (raceWinner) {
          // Another call won the race – clean up the session we just created
          // (including the remote SDK session) and return the existing one.
          yield* runOpenCodeSdk("session.abort", () =>
            started.client.session.abort({
              sessionID: started.openCodeSession.id,
            }),
          ).pipe(Effect.ignore);
          yield* Scope.close(started.sessionScope, Exit.void).pipe(Effect.ignore);
          return raceWinner.session;
        }

        const createdAt = yield* nowIso;
        const session: ProviderSession = {
          provider,
          providerInstanceId: boundInstanceId,
          status: "ready",
          runtimeMode: input.runtimeMode,
          cwd: directory,
          ...(input.modelSelection ? { model: input.modelSelection.model } : {}),
          threadId: input.threadId,
          createdAt,
          updatedAt: createdAt,
        };

        const context: OpenCodeSessionContext = {
          session,
          client: started.client,
          server: started.server,
          directory,
          openCodeSessionId: started.openCodeSession.id,
          pendingPermissions: new Map(),
          pendingQuestions: new Map(),
          partById: new Map(),
          rawTextByPartId: new Map(),
          emittedTextByPartId: new Map(),
          emittedReasoningTextByPartId: new Map(),
          nextTextByTurnId: new Map(),
          nextReasoningTextById: new Map(),
          messageRoleById: new Map(),
          completedAssistantPartIds: new Set(),
          turns: [],
          turnInputs: new Map(),
          turnOutputById: new Map(),
          suppressSubscribedEventsUntilNextTurn: false,
          activeTurnId: undefined,
          activeAgent: undefined,
          activeVariant: undefined,
          stopped: yield* Ref.make(false),
          sessionScope: started.sessionScope,
        };
        sessions.set(input.threadId, context);
        yield* startEventPump(context);

        yield* emit({
          ...(yield* buildEventBase({ threadId: input.threadId })),
          type: "session.started",
          payload: {
            message: "OpenCode session started",
          },
        });
        yield* emit({
          ...(yield* buildEventBase({ threadId: input.threadId })),
          type: "thread.started",
          payload: {
            providerThreadId: started.openCodeSession.id,
          },
        });

        return session;
      },
    );

    const sendTurn: OpenCodeAdapterShape["sendTurn"] = Effect.fn("sendTurn")(function* (input) {
      const context = ensureSessionContext(sessions, input.threadId, provider);
      // A sendTurn while a turn is active is a steer: OpenCode queues the
      // prompt into the busy session and the work continues as one turn, so
      // the active turn id is reused instead of opening a new turn.
      const steeringTurnId = context.activeTurnId;
      const turnId = steeringTurnId ?? TurnId.make(`opencode-turn-${yield* randomUUIDv4}`);
      const modelSelection =
        input.modelSelection ??
        (context.session.model
          ? { instanceId: boundInstanceId, model: context.session.model }
          : undefined);
      if (modelSelection !== undefined && modelSelection.instanceId !== boundInstanceId) {
        return yield* new ProviderAdapterValidationError({
          provider,
          operation: "sendTurn",
          issue: `OpenCode model selection is bound to instance '${modelSelection?.instanceId}', expected '${boundInstanceId}'.`,
        });
      }
      const parsedModel = parseOpenCodeModelSlug(modelSelection?.model);
      if (!parsedModel) {
        return yield* new ProviderAdapterValidationError({
          provider,
          operation: "sendTurn",
          issue: "OpenCode model selection must use the 'provider/model' format.",
        });
      }

      const text = input.input?.trim();
      const fileParts = toOpenCodeFileParts({
        attachments: input.attachments,
        resolveAttachmentPath: (attachment) =>
          resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment,
          }),
      });
      if ((!text || text.length === 0) && fileParts.length === 0) {
        return yield* new ProviderAdapterValidationError({
          provider,
          operation: "sendTurn",
          issue: "OpenCode turns require text input or at least one attachment.",
        });
      }

      const agent = getModelSelectionStringOptionValue(modelSelection, "agent");
      const variant = getModelSelectionStringOptionValue(modelSelection, "variant");
      const previousTurnInput = context.turnInputs.get(turnId);
      context.turnInputs.set(turnId, {
        text: [previousTurnInput?.text, text ?? ""].filter(Boolean).join("\n\n"),
        attachmentCount: (previousTurnInput?.attachmentCount ?? 0) + fileParts.length,
        modelSelection,
      });

      context.activeTurnId = turnId;
      context.activeAgent = agent ?? (input.interactionMode === "plan" ? "plan" : undefined);
      context.activeVariant = variant;
      context.suppressSubscribedEventsUntilNextTurn = false;
      yield* updateProviderSession(
        context,
        {
          status: "running",
          activeTurnId: turnId,
          model: modelSelection?.model ?? context.session.model,
        },
        { clearLastError: true },
      );

      if (steeringTurnId === undefined) {
        yield* emit({
          ...(yield* buildEventBase({ threadId: input.threadId, turnId })),
          type: "turn.started",
          payload: {
            model: modelSelection?.model ?? context.session.model,
            ...(variant ? { effort: variant } : {}),
          },
        });
      }

      yield* runOpenCodeSdk("session.promptAsync", () =>
        context.client.session.promptAsync({
          sessionID: context.openCodeSessionId,
          model: parsedModel,
          ...(context.activeAgent ? { agent: context.activeAgent } : {}),
          ...(context.activeVariant ? { variant: context.activeVariant } : {}),
          parts: [...(text ? [{ type: "text" as const, text }] : []), ...fileParts],
        }),
      ).pipe(
        Effect.mapError((cause) =>
          toRequestError(
            provider,
            cause,
            describeErrorDetail({
              method: cause.operation,
              detail: cause.detail,
              threadId: input.threadId,
              modelSelection,
              phase: "answer",
            }),
          ),
        ),
        // On failure of a fresh turn: clear active-turn state, flip the
        // session back to ready with lastError set, emit turn.aborted, then
        // let the typed error propagate. We don't need to rebuild the error
        // here — `toRequestError` already produced the right shape. A failed
        // steer leaves the still-running original turn untouched.
        Effect.tapError((requestError) =>
          steeringTurnId !== undefined
            ? Effect.void
            : Effect.gen(function* () {
                context.activeTurnId = undefined;
                context.activeAgent = undefined;
                context.activeVariant = undefined;
                context.turnInputs.delete(turnId);
                context.turnOutputById.delete(turnId);
                yield* updateProviderSession(
                  context,
                  {
                    status: "ready",
                    model: modelSelection?.model ?? context.session.model,
                    lastError: requestError.detail,
                  },
                  { clearActiveTurnId: true },
                );
                yield* emit({
                  ...(yield* buildEventBase({
                    threadId: input.threadId,
                    turnId,
                  })),
                  type: "turn.aborted",
                  payload: {
                    reason: requestError.detail,
                  },
                });
              }),
        ),
      );

      return {
        threadId: input.threadId,
        turnId,
      };
    });

    const interruptTurn: OpenCodeAdapterShape["interruptTurn"] = Effect.fn("interruptTurn")(
      function* (threadId, turnId) {
        const context = ensureSessionContext(sessions, threadId, provider);
        yield* runOpenCodeSdk("session.abort", () =>
          context.client.session.abort({ sessionID: context.openCodeSessionId }),
        ).pipe(Effect.mapError(mapOpenCodeRequestError));
        if (turnId ?? context.activeTurnId) {
          yield* emit({
            ...(yield* buildEventBase({
              threadId,
              turnId: turnId ?? context.activeTurnId,
            })),
            type: "turn.aborted",
            payload: {
              reason: "Interrupted by user.",
            },
          });
        }
      },
    );

    const respondToRequest: OpenCodeAdapterShape["respondToRequest"] = Effect.fn(
      "respondToRequest",
    )(function* (threadId, requestId, decision) {
      const context = ensureSessionContext(sessions, threadId, provider);
      if (!context.pendingPermissions.has(requestId)) {
        return yield* new ProviderAdapterRequestError({
          provider,
          method: "permission.reply",
          detail: `Unknown pending permission request: ${requestId}`,
        });
      }

      yield* runOpenCodeSdk("permission.reply", () =>
        context.client.permission.reply({
          requestID: requestId,
          reply: toOpenCodePermissionReply(decision),
        }),
      ).pipe(Effect.mapError(mapOpenCodeRequestError));
    });

    const respondToUserInput: OpenCodeAdapterShape["respondToUserInput"] = Effect.fn(
      "respondToUserInput",
    )(function* (threadId, requestId, answers) {
      const context = ensureSessionContext(sessions, threadId, provider);
      const request = context.pendingQuestions.get(requestId);
      if (!request) {
        return yield* new ProviderAdapterRequestError({
          provider,
          method: "question.reply",
          detail: `Unknown pending user-input request: ${requestId}`,
        });
      }

      yield* runOpenCodeSdk("question.reply", () =>
        context.client.question.reply({
          requestID: requestId,
          answers: toOpenCodeQuestionAnswers(request, answers),
        }),
      ).pipe(Effect.mapError(mapOpenCodeRequestError));
    });

    const stopSession: OpenCodeAdapterShape["stopSession"] = Effect.fn("stopSession")(
      function* (threadId) {
        const context = sessions.get(threadId);
        if (!context) {
          throw new ProviderAdapterSessionNotFoundError({
            provider,
            threadId,
          });
        }
        const stopped = yield* stopOpenCodeContext(context);
        sessions.delete(threadId);
        if (!stopped) {
          return;
        }
        yield* emit({
          ...(yield* buildEventBase({ threadId })),
          type: "session.exited",
          payload: {
            reason: "Session stopped.",
            recoverable: false,
            exitKind: "graceful",
          },
        });
      },
    );

    const listSessions: OpenCodeAdapterShape["listSessions"] = () =>
      Effect.sync(() => [...sessions.values()].map((context) => context.session));

    const hasSession: OpenCodeAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => sessions.has(threadId));

    const readThread: OpenCodeAdapterShape["readThread"] = Effect.fn("readThread")(
      function* (threadId) {
        const context = ensureSessionContext(sessions, threadId, provider);
        const messages = yield* runOpenCodeSdk("session.messages", () =>
          context.client.session.messages({
            sessionID: context.openCodeSessionId,
          }),
        ).pipe(Effect.mapError(mapOpenCodeRequestError));

        const turns: Array<OpenCodeTurnSnapshot> = [];
        for (const entry of messages.data ?? []) {
          if (entry.info.role === "assistant") {
            turns.push({
              id: TurnId.make(entry.info.id),
              items: [entry.info, ...entry.parts],
            });
          }
        }

        return {
          threadId,
          turns,
        };
      },
    );

    const rollbackThread: OpenCodeAdapterShape["rollbackThread"] = Effect.fn("rollbackThread")(
      function* (threadId, numTurns) {
        const context = ensureSessionContext(sessions, threadId, provider);
        const messages = yield* runOpenCodeSdk("session.messages", () =>
          context.client.session.messages({
            sessionID: context.openCodeSessionId,
          }),
        ).pipe(Effect.mapError(mapOpenCodeRequestError));

        const assistantMessages = (messages.data ?? []).filter(
          (entry) => entry.info.role === "assistant",
        );
        const targetIndex = assistantMessages.length - numTurns - 1;
        const target = targetIndex >= 0 ? assistantMessages[targetIndex] : null;
        yield* runOpenCodeSdk("session.revert", () =>
          context.client.session.revert({
            sessionID: context.openCodeSessionId,
            ...(target ? { messageID: target.info.id } : {}),
          }),
        ).pipe(Effect.mapError(mapOpenCodeRequestError));

        return yield* readThread(threadId);
      },
    );

    const stopAll: OpenCodeAdapterShape["stopAll"] = () =>
      Effect.gen(function* () {
        const contexts = [...sessions.values()];
        sessions.clear();
        // `stopOpenCodeContext` is typed as never-failing — SDK aborts are
        // already `Effect.ignore`'d inside it. `ignoreCause` here also
        // swallows defects from throwing finalizers so one bad close can't
        // interrupt the sibling fibers. Same pattern as the layer finalizer.
        yield* Effect.forEach(
          contexts,
          (context) => Effect.ignoreCause(stopOpenCodeContext(context)),
          { concurrency: "unbounded", discard: true },
        );
      });

    return {
      provider,
      capabilities: {
        sessionModelSwitch: "in-session",
      },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      readThread,
      rollbackThread,
      stopAll,
      get streamEvents() {
        return Stream.fromQueue(runtimeEvents);
      },
    } satisfies OpenCodeAdapterShape;
  });
}
