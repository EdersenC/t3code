import * as NodeAssert from "node:assert/strict";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { beforeEach } from "vite-plus/test";

import {
  EnvironmentId,
  OpenCodeSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import type { OpenCodeAdapterShape } from "../Services/OpenCodeAdapter.ts";
import { T3_HARNESS_SYSTEM_INSTRUCTIONS } from "../T3HarnessInstructions.ts";
import {
  OpenCodeRuntime,
  OpenCodeRuntimeError,
  type OpenCodeRuntimeShape,
} from "../opencodeRuntime.ts";
import {
  appendOpenCodeAssistantTextDelta,
  makeOpenCodeAdapter,
  mergeOpenCodeAssistantText,
  sessionErrorMessage,
  splitInlineThinkingText,
  type OpenCodeAdapterLiveOptions,
} from "./OpenCodeAdapter.ts";

// Test-local service tag so the rest of the file can keep using `yield* OpenCodeAdapter`.
class OpenCodeAdapter extends Context.Service<OpenCodeAdapter, OpenCodeAdapterShape>()(
  "t3/provider/Layers/OpenCodeAdapter.test/OpenCodeAdapter",
) {}

const asThreadId = (value: string): ThreadId => ThreadId.make(value);

type MessageEntry = {
  info: {
    id: string;
    role: "user" | "assistant";
  };
  parts: Array<unknown>;
};

type PendingEventResolver = (result: IteratorResult<unknown>) => void;

const runtimeMock = {
  state: {
    startCalls: [] as string[],
    sessionCreateUrls: [] as string[],
    authHeaders: [] as Array<string | null>,
    abortCalls: [] as string[],
    closeCalls: [] as string[],
    mcpAddCalls: [] as Array<unknown>,
    revertCalls: [] as Array<{ sessionID: string; messageID?: string }>,
    promptCalls: [] as Array<unknown>,
    promptAsyncError: null as Error | null,
    closeError: null as Error | null,
    messages: [] as MessageEntry[],
    subscribedEvents: [] as unknown[],
    holdEventStreamOpen: false,
    dynamicEvents: [] as unknown[],
    eventResolvers: [] as Array<PendingEventResolver>,
    eventStreamClosed: false,
  },
  pushSubscribedEvent(event: unknown) {
    const resolver = this.state.eventResolvers.shift();
    if (resolver) {
      resolver({ value: event, done: false });
      return;
    }
    this.state.dynamicEvents.push(event);
  },
  closeSubscribedEvents() {
    this.state.eventStreamClosed = true;
    for (const resolver of this.state.eventResolvers.splice(0)) {
      resolver({ value: undefined, done: true });
    }
  },
  reset() {
    this.closeSubscribedEvents();
    this.state.startCalls.length = 0;
    this.state.sessionCreateUrls.length = 0;
    this.state.authHeaders.length = 0;
    this.state.abortCalls.length = 0;
    this.state.closeCalls.length = 0;
    this.state.mcpAddCalls.length = 0;
    this.state.revertCalls.length = 0;
    this.state.promptCalls.length = 0;
    this.state.promptAsyncError = null;
    this.state.closeError = null;
    this.state.messages = [];
    this.state.subscribedEvents = [];
    this.state.holdEventStreamOpen = false;
    this.state.dynamicEvents = [];
    this.state.eventResolvers = [];
    this.state.eventStreamClosed = false;
  },
};

const OpenCodeRuntimeTestDouble: OpenCodeRuntimeShape = {
  startOpenCodeServerProcess: ({ binaryPath }) =>
    Effect.gen(function* () {
      runtimeMock.state.startCalls.push(binaryPath);
      const url = "http://127.0.0.1:4301";
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          runtimeMock.state.closeCalls.push(url);
          if (runtimeMock.state.closeError) {
            throw runtimeMock.state.closeError;
          }
        }),
      );
      return {
        url,
        exitCode: Effect.never,
      };
    }),
  connectToOpenCodeServer: ({ serverUrl }) =>
    Effect.gen(function* () {
      const url = serverUrl ?? "http://127.0.0.1:4301";
      // Unconditionally register a scope finalizer for test observability —
      // preserves the `closeCalls` / `closeError` probes that the existing
      // suites rely on. Production code never attaches a finalizer to an
      // external server (it simply returns `Effect.succeed(...)`).
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          runtimeMock.state.closeCalls.push(url);
          if (runtimeMock.state.closeError) {
            throw runtimeMock.state.closeError;
          }
        }),
      );
      return {
        url,
        exitCode: null,
        external: Boolean(serverUrl),
      };
    }),
  runOpenCodeCommand: () => Effect.succeed({ stdout: "", stderr: "", code: 0 }),
  createOpenCodeSdkClient: ({ baseUrl, serverPassword }) =>
    ({
      session: {
        create: async () => {
          runtimeMock.state.sessionCreateUrls.push(baseUrl);
          runtimeMock.state.authHeaders.push(
            serverPassword ? `Basic ${btoa(`opencode:${serverPassword}`)}` : null,
          );
          return { data: { id: `${baseUrl}/session` } };
        },
        abort: async ({ sessionID }: { sessionID: string }) => {
          runtimeMock.state.abortCalls.push(sessionID);
        },
        promptAsync: async (input: unknown) => {
          runtimeMock.state.promptCalls.push(input);
          if (runtimeMock.state.promptAsyncError) {
            throw runtimeMock.state.promptAsyncError;
          }
        },
        messages: async () => ({ data: runtimeMock.state.messages }),
        revert: async ({ sessionID, messageID }: { sessionID: string; messageID?: string }) => {
          runtimeMock.state.revertCalls.push({
            sessionID,
            ...(messageID ? { messageID } : {}),
          });
          if (!messageID) {
            runtimeMock.state.messages = [];
            return;
          }

          const targetIndex = runtimeMock.state.messages.findIndex(
            (entry) => entry.info.id === messageID,
          );
          runtimeMock.state.messages =
            targetIndex >= 0
              ? runtimeMock.state.messages.slice(0, targetIndex + 1)
              : runtimeMock.state.messages;
        },
      },
      event: {
        subscribe: async () => ({
          stream: (async function* () {
            for (const event of runtimeMock.state.subscribedEvents) {
              yield event;
            }
            if (!runtimeMock.state.holdEventStreamOpen) {
              return;
            }
            while (true) {
              const queuedEvent = runtimeMock.state.dynamicEvents.shift();
              if (queuedEvent !== undefined) {
                yield queuedEvent;
                continue;
              }
              if (runtimeMock.state.eventStreamClosed) {
                return;
              }
              const result = await new Promise<IteratorResult<unknown>>((resolve) => {
                runtimeMock.state.eventResolvers.push(resolve);
              });
              if (result.done) {
                return;
              }
              yield result.value;
            }
          })(),
        }),
      },
      mcp: {
        add: async (input: unknown) => {
          runtimeMock.state.mcpAddCalls.push(input);
        },
      },
    }) as unknown as ReturnType<OpenCodeRuntimeShape["createOpenCodeSdkClient"]>,
  loadOpenCodeInventory: () =>
    Effect.fail(
      new OpenCodeRuntimeError({
        operation: "loadOpenCodeInventory",
        detail: "OpenCodeRuntimeTestDouble.loadOpenCodeInventory not used in this test",
        cause: null,
      }),
    ),
};

const providerSessionDirectoryTestLayer = Layer.succeed(ProviderSessionDirectory, {
  upsert: () => Effect.void,
  getProvider: () =>
    Effect.die(new Error("ProviderSessionDirectory.getProvider is not used in test")),
  getBinding: () => Effect.succeed(Option.none()),
  listThreadIds: () => Effect.succeed([]),
  listBindings: () => Effect.succeed([]),
});

// The adapter now receives its settings as a plain argument (the old design
// read from `ServerSettingsService` internally). The test-only
// `ServerSettingsService` below is still kept because other dependencies in
// the layer graph reach for it — but the routing values the assertions
// probe (serverUrl, serverPassword) must be threaded directly through the
// decoded `OpenCodeSettings`.
const openCodeAdapterTestSettings = Schema.decodeSync(OpenCodeSettings)({
  binaryPath: "fake-opencode",
  serverUrl: "http://127.0.0.1:9999",
  serverPassword: "secret-password",
});

const makeOpenCodeAdapterTestLayer = (options: OpenCodeAdapterLiveOptions = {}) =>
  Layer.effect(OpenCodeAdapter, makeOpenCodeAdapter(openCodeAdapterTestSettings, options)).pipe(
    Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(
      ServerSettingsService.layerTest({
        providers: {
          opencode: {
            binaryPath: "fake-opencode",
            serverUrl: "http://127.0.0.1:9999",
            serverPassword: "secret-password",
          },
        },
      }),
    ),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  );

const OpenCodeAdapterTestLayer = makeOpenCodeAdapterTestLayer();

beforeEach(() => {
  runtimeMock.reset();
  McpProviderSession.clearAllMcpProviderSessions();
});

const advanceTestClock = (ms: number) =>
  TestClock.adjust(`${ms} millis`).pipe(Effect.andThen(Effect.yieldNow));

it.layer(OpenCodeAdapterTestLayer)("OpenCodeAdapterLive", (it) => {
  it.effect("reuses a configured OpenCode server URL instead of spawning a local server", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;

      const session = yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId: asThreadId("thread-opencode"),
        runtimeMode: "full-access",
      });

      NodeAssert.equal(session.provider, "opencode");
      NodeAssert.equal(session.threadId, "thread-opencode");
      NodeAssert.deepEqual(runtimeMock.state.startCalls, []);
      NodeAssert.deepEqual(runtimeMock.state.sessionCreateUrls, ["http://127.0.0.1:9999"]);
      NodeAssert.deepEqual(runtimeMock.state.authHeaders, [
        `Basic ${btoa("opencode:secret-password")}`,
      ]);
    }),
  );

  it.effect("registers the T3 MCP server with configured external OpenCode servers", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = ThreadId.make("thread-opencode-external-mcp");

      McpProviderSession.setMcpProviderSession({
        environmentId: EnvironmentId.make("environment-opencode-external-mcp"),
        threadId,
        providerSessionId: "provider-session-opencode-external-mcp",
        providerInstanceId: ProviderInstanceId.make("opencode"),
        endpoint: "http://127.0.0.1:43123/mcp?threadId=thread-opencode-external-mcp",
        authorizationHeader: "Bearer test-token",
      });

      try {
        yield* adapter.startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId,
          runtimeMode: "full-access",
        });

        NodeAssert.deepEqual(runtimeMock.state.mcpAddCalls, [
          {
            name: "t3-code",
            config: {
              type: "remote",
              url: "http://127.0.0.1:43123/mcp?threadId=thread-opencode-external-mcp",
              headers: { Authorization: "Bearer test-token" },
              oauth: false,
            },
          },
        ]);
      } finally {
        yield* adapter.stopSession(threadId).pipe(Effect.ignore);
        McpProviderSession.clearMcpProviderSession(threadId);
      }
    }),
  );

  it.effect("stops a configured-server session without trying to own server lifecycle", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId: asThreadId("thread-opencode"),
        runtimeMode: "full-access",
      });

      yield* adapter.stopSession(asThreadId("thread-opencode"));

      NodeAssert.deepEqual(runtimeMock.state.startCalls, []);
      NodeAssert.deepEqual(
        runtimeMock.state.abortCalls.includes("http://127.0.0.1:9999/session"),
        true,
      );
    }),
  );

  it.effect("emits one session.exited event when stopping a session", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-stop-event");
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      yield* adapter.stopSession(threadId);

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
      NodeAssert.deepEqual(
        events.map((event) => event.type),
        ["session.started", "thread.started", "session.exited"],
      );
    }),
  );

  it.effect("clears session state even when cleanup finalizers throw", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId: asThreadId("thread-stop-all-a"),
        runtimeMode: "full-access",
      });
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId: asThreadId("thread-stop-all-b"),
        runtimeMode: "full-access",
      });

      runtimeMock.state.closeError = new Error("close failed");
      // `stopAll` relies on `stopOpenCodeContext`, which is typed as
      // never-failing. A throwing finalizer surfaces as a defect — `Effect.exit`
      // captures it so the assertions can still run. The key invariant we're
      // validating is "the sessions map and close-call probes reflect cleanup
      // attempts regardless of finalizer outcome".
      yield* Effect.exit(adapter.stopAll());
      const sessions = yield* adapter.listSessions();

      NodeAssert.deepEqual(runtimeMock.state.closeCalls, [
        "http://127.0.0.1:9999",
        "http://127.0.0.1:9999",
      ]);
      NodeAssert.deepEqual(sessions, []);
    }),
  );

  it.effect("completes streamEvents when the adapter scope closes", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make("sequential");
      let scopeClosed = false;

      try {
        const adapterLayer = Layer.effect(
          OpenCodeAdapter,
          makeOpenCodeAdapter(openCodeAdapterTestSettings),
        ).pipe(
          Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
          Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
          Layer.provideMerge(ServerSettingsService.layerTest()),
          Layer.provideMerge(providerSessionDirectoryTestLayer),
          Layer.provideMerge(NodeServices.layer),
        );
        const context = yield* Layer.buildWithScope(adapterLayer, scope);
        const adapter = yield* Effect.service(OpenCodeAdapter).pipe(Effect.provide(context));
        const eventsFiber = yield* adapter.streamEvents.pipe(Stream.runCollect, Effect.forkChild);

        yield* Scope.close(scope, Exit.void);
        scopeClosed = true;

        const exit = yield* Fiber.await(eventsFiber).pipe(Effect.timeout("1 second"));
        NodeAssert.equal(Exit.hasInterrupts(exit), true);
      } finally {
        if (!scopeClosed) {
          yield* Scope.close(scope, Exit.void).pipe(Effect.ignore);
        }
      }
    }),
  );

  it.effect("rolls back session state when sendTurn fails before OpenCode accepts the prompt", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId: asThreadId("thread-send-turn-failure"),
        runtimeMode: "full-access",
      });

      runtimeMock.state.promptAsyncError = new Error("prompt failed");
      const error = yield* adapter
        .sendTurn({
          threadId: asThreadId("thread-send-turn-failure"),
          input: "Fix it",
          modelSelection: {
            instanceId: ProviderInstanceId.make("opencode"),
            model: "openai/gpt-5",
          },
        })
        .pipe(Effect.flip);
      const sessions = yield* adapter.listSessions();

      NodeAssert.equal(error._tag, "ProviderAdapterRequestError");
      if (error._tag !== "ProviderAdapterRequestError") {
        throw new Error("Unexpected error type");
      }
      NodeAssert.equal(error.detail, "prompt failed");
      NodeAssert.equal(
        error.message,
        "Provider adapter request failed (opencode) for session.promptAsync: prompt failed",
      );
      NodeAssert.equal(sessions.length, 1);
      NodeAssert.equal(sessions[0]?.status, "ready");
      NodeAssert.equal(sessions[0]?.activeTurnId, undefined);
      NodeAssert.equal(sessions[0]?.lastError, "prompt failed");
    }),
  );

  it.effect("applies provider-specific error detail when sendTurn request fails", () => {
    const adapterLayer = makeOpenCodeAdapterTestLayer({
      provider: ProviderDriverKind.make("groq"),
      instanceId: ProviderInstanceId.make("groq"),
      describeErrorDetail: ({ detail, modelSelection }) =>
        `Groq model '${modelSelection?.model ?? "unknown"}' failed while answering. Details: ${detail}`,
    });

    return Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-send-turn-groq-failure");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("groq"),
        threadId,
        runtimeMode: "full-access",
      });

      runtimeMock.state.promptAsyncError = new Error("429 rate limit exceeded");
      const error = yield* adapter
        .sendTurn({
          threadId,
          input: "Fix it",
          modelSelection: {
            instanceId: ProviderInstanceId.make("groq"),
            model: "groq/openai/gpt-oss-120b",
          },
        })
        .pipe(Effect.flip);
      const sessions = yield* adapter.listSessions();

      NodeAssert.equal(error._tag, "ProviderAdapterRequestError");
      if (error._tag !== "ProviderAdapterRequestError") {
        throw new Error("Unexpected error type");
      }
      NodeAssert.equal(
        error.detail,
        "Groq model 'groq/openai/gpt-oss-120b' failed while answering. Details: 429 rate limit exceeded",
      );
      NodeAssert.equal(sessions[0]?.lastError, error.detail);
    }).pipe(Effect.provide(adapterLayer));
  });

  it.effect("passes T3 capability preload as promptAsync system text", () => {
    const adapterLayer = makeOpenCodeAdapterTestLayer({
      capabilityRuntime: {
        skillPaths: [],
        skillPermissions: {},
        preloadSystemPrompt: "T3 capability preload:\n- Test: Follow T3 policy.",
      },
    });

    return Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-t3-preload-system");

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "Fix it",
        modelSelection: createModelSelection(ProviderInstanceId.make("opencode"), "openai/gpt-4.1"),
      });

      const prompt = runtimeMock.state.promptCalls.at(-1) as Record<string, unknown> | undefined;
      NodeAssert.equal(
        prompt?.system,
        `${T3_HARNESS_SYSTEM_INSTRUCTIONS}\n\nT3 capability preload:\n- Test: Follow T3 policy.`,
      );
      NodeAssert.equal(Object.hasOwn(prompt ?? {}, "agent"), false);
    }).pipe(Effect.provide(adapterLayer));
  });

  it.effect("fails a turn when OpenCode idles without any model output", () => {
    const adapterLayer = makeOpenCodeAdapterTestLayer({
      provider: ProviderDriverKind.make("groq"),
      instanceId: ProviderInstanceId.make("groq"),
      describeErrorDetail: ({ detail, emptyOutput, modelSelection }) =>
        emptyOutput ? `Groq empty ${modelSelection?.model ?? "unknown"}: ${detail}` : detail,
    });

    return Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-empty-output");
      runtimeMock.state.holdEventStreamOpen = true;
      const streamFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.take(5),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("groq"),
        threadId,
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "Fix it",
        modelSelection: {
          instanceId: ProviderInstanceId.make("groq"),
          model: "groq/openai/gpt-oss-120b",
        },
      });
      yield* Effect.yieldNow;
      runtimeMock.pushSubscribedEvent({
        type: "session.status",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          status: { type: "idle" },
        },
      });
      runtimeMock.closeSubscribedEvents();

      const events = Array.from(yield* Fiber.join(streamFiber).pipe(Effect.timeout("1 second")));
      const turnCompleted = events.find((event) => event.type === "turn.completed");
      const runtimeError = events.find((event) => event.type === "runtime.error");
      const expected = "Groq empty groq/openai/gpt-oss-120b: OpenCode returned empty output.";
      NodeAssert.deepEqual(
        events.map((event) => event.type),
        ["session.started", "thread.started", "turn.started", "turn.completed", "runtime.error"],
      );
      NodeAssert.equal(
        turnCompleted?.type === "turn.completed" ? turnCompleted.payload.state : undefined,
        "failed",
      );
      NodeAssert.equal(
        turnCompleted?.type === "turn.completed" ? turnCompleted.payload.errorMessage : undefined,
        expected,
      );
      NodeAssert.equal(
        runtimeError?.type === "runtime.error" ? runtimeError.payload.message : undefined,
        expected,
      );
      const sessions = yield* adapter.listSessions();
      NodeAssert.equal(sessions[0]?.status, "error");
      NodeAssert.equal(sessions[0]?.lastError, expected);
    }).pipe(
      Effect.ensuring(Effect.sync(() => runtimeMock.closeSubscribedEvents())),
      Effect.provide(adapterLayer),
    );
  });

  it.effect(
    "fails a turn when OpenCode only reports tool bookkeeping without assistant text",
    () => {
      const adapterLayer = makeOpenCodeAdapterTestLayer({
        provider: ProviderDriverKind.make("groq"),
        instanceId: ProviderInstanceId.make("groq"),
        describeErrorDetail: ({ detail, emptyOutput, modelSelection }) =>
          emptyOutput ? `Groq empty ${modelSelection?.model ?? "unknown"}: ${detail}` : detail,
      });

      return Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const threadId = asThreadId("thread-tool-only-empty-output");
        runtimeMock.state.holdEventStreamOpen = true;
        const streamFiber = yield* adapter.streamEvents.pipe(
          Stream.filter((event) => event.threadId === threadId),
          Stream.take(6),
          Stream.runCollect,
          Effect.forkChild,
        );

        yield* adapter.startSession({
          provider: ProviderDriverKind.make("groq"),
          threadId,
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId,
          input: "Fix it",
          modelSelection: {
            instanceId: ProviderInstanceId.make("groq"),
            model: "groq/openai/gpt-oss-120b",
          },
        });
        yield* Effect.yieldNow;
        runtimeMock.pushSubscribedEvent({
          type: "message.part.updated",
          properties: {
            sessionID: "http://127.0.0.1:9999/session",
            part: {
              id: "part-tool-only",
              messageID: "msg-tool-only",
              type: "tool",
              tool: "bash",
              callID: "call-tool-only",
              state: {
                status: "completed",
                output: "tool completed without an assistant answer",
                time: { start: 1, end: 2 },
              },
            },
            time: 2,
          },
        });
        runtimeMock.pushSubscribedEvent({
          type: "session.status",
          properties: {
            sessionID: "http://127.0.0.1:9999/session",
            status: { type: "idle" },
          },
        });
        runtimeMock.closeSubscribedEvents();

        const events = Array.from(yield* Fiber.join(streamFiber).pipe(Effect.timeout("1 second")));
        const turnCompleted = events.find((event) => event.type === "turn.completed");
        const runtimeError = events.find((event) => event.type === "runtime.error");
        const expected = "Groq empty groq/openai/gpt-oss-120b: OpenCode returned empty output.";

        NodeAssert.deepEqual(
          events.map((event) => event.type),
          [
            "session.started",
            "thread.started",
            "turn.started",
            "item.completed",
            "turn.completed",
            "runtime.error",
          ],
        );
        NodeAssert.equal(
          turnCompleted?.type === "turn.completed" ? turnCompleted.payload.state : undefined,
          "failed",
        );
        NodeAssert.equal(
          runtimeError?.type === "runtime.error" ? runtimeError.payload.message : undefined,
          expected,
        );
      }).pipe(
        Effect.ensuring(Effect.sync(() => runtimeMock.closeSubscribedEvents())),
        Effect.provide(adapterLayer),
      );
    },
  );

  it.effect("streams OpenCode session.next text events as assistant output", () => {
    const adapterLayer = makeOpenCodeAdapterTestLayer();

    return Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-next-text-output");
      runtimeMock.state.holdEventStreamOpen = true;
      const streamFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.take(6),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "hello",
        modelSelection: createModelSelection(ProviderInstanceId.make("opencode"), "openai/gpt-4.1"),
      });
      yield* Effect.yieldNow;
      runtimeMock.pushSubscribedEvent({
        id: "evt-next-text-started",
        type: "session.next.text.started",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          timestamp: 1,
        },
      });
      runtimeMock.pushSubscribedEvent({
        id: "evt-next-text-delta",
        type: "session.next.text.delta",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          timestamp: 2,
          delta: "hello from next stream",
        },
      });
      runtimeMock.pushSubscribedEvent({
        id: "evt-next-text-ended",
        type: "session.next.text.ended",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          timestamp: 3,
          text: "hello from next stream",
        },
      });
      runtimeMock.pushSubscribedEvent({
        id: "evt-next-text-idle",
        type: "session.status",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          status: { type: "idle" },
        },
      });
      runtimeMock.closeSubscribedEvents();

      const events = Array.from(yield* Fiber.join(streamFiber).pipe(Effect.timeout("1 second")));
      NodeAssert.deepEqual(
        events.map((event) => event.type),
        [
          "session.started",
          "thread.started",
          "turn.started",
          "content.delta",
          "item.completed",
          "turn.completed",
        ],
      );
      const delta = events.find((event) => event.type === "content.delta");
      NodeAssert.equal(
        delta?.type === "content.delta" ? delta.payload.delta : undefined,
        "hello from next stream",
      );
      const completed = events.find((event) => event.type === "item.completed");
      NodeAssert.equal(
        completed?.type === "item.completed" ? completed.payload.detail : undefined,
        "hello from next stream",
      );
    }).pipe(
      Effect.ensuring(Effect.sync(() => runtimeMock.closeSubscribedEvents())),
      Effect.provide(adapterLayer),
    );
  });

  it.effect("uses an OpenCode step failure as the final empty-output error detail", () => {
    const adapterLayer = makeOpenCodeAdapterTestLayer({
      provider: ProviderDriverKind.make("groq"),
      instanceId: ProviderInstanceId.make("groq"),
      describeErrorDetail: ({ detail, modelSelection }) =>
        `Groq ${modelSelection?.model ?? "unknown"} failed: ${detail}`,
    });

    return Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-next-step-failed");
      runtimeMock.state.holdEventStreamOpen = true;
      const streamFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.take(8),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("groq"),
        threadId,
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "hello",
        modelSelection: {
          instanceId: ProviderInstanceId.make("groq"),
          model: "groq/llama-3.3-70b-versatile",
        },
      });
      yield* Effect.yieldNow;
      runtimeMock.pushSubscribedEvent({
        id: "evt-next-step-failed",
        type: "session.next.step.failed",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          timestamp: 1,
          error: {
            type: "unknown",
            message:
              "Request too large for model `llama-3.3-70b-versatile` on tokens per minute (TPM): Limit 12000, Requested 14231",
          },
        },
      });
      runtimeMock.pushSubscribedEvent({
        id: "evt-next-text-delta-after-failure",
        type: "session.next.text.delta",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          timestamp: 2,
          delta: "synthetic compaction text",
        },
      });
      runtimeMock.pushSubscribedEvent({
        id: "evt-next-text-ended-after-failure",
        type: "session.next.text.ended",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          timestamp: 3,
          text: "synthetic compaction text",
        },
      });
      runtimeMock.pushSubscribedEvent({
        id: "evt-next-step-failed-idle",
        type: "session.status",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          status: { type: "idle" },
        },
      });
      runtimeMock.closeSubscribedEvents();

      const events = Array.from(yield* Fiber.join(streamFiber).pipe(Effect.timeout("1 second")));
      const warning = events.find((event) => event.type === "runtime.warning");
      const runtimeError = events.find((event) => event.type === "runtime.error");
      const expected =
        "Groq groq/llama-3.3-70b-versatile failed: Request too large for model `llama-3.3-70b-versatile` on tokens per minute (TPM): Limit 12000, Requested 14231";

      NodeAssert.deepEqual(
        events.map((event) => event.type),
        [
          "session.started",
          "thread.started",
          "turn.started",
          "runtime.warning",
          "content.delta",
          "item.completed",
          "turn.completed",
          "runtime.error",
        ],
      );
      NodeAssert.equal(
        warning?.type === "runtime.warning" ? warning.payload.message : undefined,
        expected,
      );
      NodeAssert.equal(
        runtimeError?.type === "runtime.error" ? runtimeError.payload.message : undefined,
        expected,
      );
    }).pipe(
      Effect.ensuring(Effect.sync(() => runtimeMock.closeSubscribedEvents())),
      Effect.provide(adapterLayer),
    );
  });

  it.effect("can fail and abort immediately on OpenCode step failure", () => {
    const adapterLayer = makeOpenCodeAdapterTestLayer({
      provider: ProviderDriverKind.make("groq"),
      instanceId: ProviderInstanceId.make("groq"),
      describeErrorDetail: ({ detail, modelSelection }) =>
        `Groq ${modelSelection?.model ?? "unknown"} failed: ${detail}`,
      failTurnOnStepFailure: true,
    });

    return Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-next-step-failed-fast");
      runtimeMock.state.holdEventStreamOpen = true;
      const streamFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.take(6),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("groq"),
        threadId,
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "hello",
        modelSelection: {
          instanceId: ProviderInstanceId.make("groq"),
          model: "groq/qwen/qwen3-32b",
        },
      });
      yield* Effect.yieldNow;
      runtimeMock.pushSubscribedEvent({
        id: "evt-next-step-failed-fast",
        type: "session.next.step.failed",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          timestamp: 1,
          error: {
            type: "rate_limit_error",
            message:
              "Request too large for model `qwen/qwen3-32b` on tokens per minute (TPM): Limit 6000, Requested 8397",
          },
        },
      });
      runtimeMock.pushSubscribedEvent({
        id: "evt-next-step-failed-fast-noise",
        type: "session.next.text.delta",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          timestamp: 2,
          delta: "retry text should not attach to the failed turn",
        },
      });
      runtimeMock.pushSubscribedEvent({
        id: "evt-next-step-failed-fast-retry-noise",
        type: "session.status",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          status: {
            type: "retry",
            message: "retrying after request-size failure",
          },
        },
      });
      runtimeMock.pushSubscribedEvent({
        id: "evt-next-step-failed-fast-ended-noise",
        type: "session.next.text.ended",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          timestamp: 3,
          text: "retry text should not attach to the failed turn",
        },
      });
      runtimeMock.closeSubscribedEvents();

      const events = Array.from(yield* Fiber.join(streamFiber).pipe(Effect.timeout("1 second")));
      const expected =
        "Groq groq/qwen/qwen3-32b failed: Request too large for model `qwen/qwen3-32b` on tokens per minute (TPM): Limit 6000, Requested 8397";

      NodeAssert.deepEqual(
        events.map((event) => event.type),
        [
          "session.started",
          "thread.started",
          "turn.started",
          "runtime.warning",
          "turn.completed",
          "runtime.error",
        ],
      );
      NodeAssert.deepEqual(runtimeMock.state.abortCalls, ["http://127.0.0.1:9999/session"]);
      NodeAssert.equal(
        events[4]?.type === "turn.completed" ? events[4].payload.errorMessage : undefined,
        expected,
      );
      NodeAssert.equal(
        events[5]?.type === "runtime.error" ? events[5].payload.message : undefined,
        expected,
      );
    }).pipe(
      Effect.ensuring(Effect.sync(() => runtimeMock.closeSubscribedEvents())),
      Effect.provide(adapterLayer),
    );
  });

  it.effect("fails and aborts fatal OpenCode retry statuses instead of looping", () => {
    const adapterLayer = makeOpenCodeAdapterTestLayer({
      provider: ProviderDriverKind.make("groq"),
      instanceId: ProviderInstanceId.make("groq"),
      describeErrorDetail: ({ detail, modelSelection }) =>
        `Groq ${modelSelection?.model ?? "unknown"} failed: ${detail}`,
      failTurnOnRetryStatus: true,
    });

    return Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-next-retry-failed-fast");
      runtimeMock.state.holdEventStreamOpen = true;
      const streamFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.take(6),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("groq"),
        threadId,
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "hello",
        modelSelection: {
          instanceId: ProviderInstanceId.make("groq"),
          model: "groq/openai/gpt-oss-120b",
        },
      });
      yield* Effect.yieldNow;
      runtimeMock.pushSubscribedEvent({
        id: "evt-next-retry-fatal",
        type: "session.status",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          status: {
            type: "retry",
            message:
              "Request too large for model `openai/gpt-oss-120b` on tokens per minute (TPM): Limit 8000, Requested 10422",
          },
        },
      });
      runtimeMock.pushSubscribedEvent({
        id: "evt-next-retry-fatal-text-noise",
        type: "session.next.text.delta",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          timestamp: 2,
          delta: "Goal summary retry text should not render",
        },
      });
      runtimeMock.closeSubscribedEvents();

      const events = Array.from(yield* Fiber.join(streamFiber).pipe(Effect.timeout("1 second")));
      const expected =
        "Groq groq/openai/gpt-oss-120b failed: Request too large for model `openai/gpt-oss-120b` on tokens per minute (TPM): Limit 8000, Requested 10422";

      NodeAssert.deepEqual(
        events.map((event) => event.type),
        [
          "session.started",
          "thread.started",
          "turn.started",
          "runtime.warning",
          "turn.completed",
          "runtime.error",
        ],
      );
      NodeAssert.deepEqual(runtimeMock.state.abortCalls, ["http://127.0.0.1:9999/session"]);
      NodeAssert.equal(
        events[4]?.type === "turn.completed" ? events[4].payload.errorMessage : undefined,
        expected,
      );
      NodeAssert.equal(
        events[5]?.type === "runtime.error" ? events[5].payload.message : undefined,
        expected,
      );
    }).pipe(
      Effect.ensuring(Effect.sync(() => runtimeMock.closeSubscribedEvents())),
      Effect.provide(adapterLayer),
    );
  });

  it.effect("steers a running turn instead of opening a new one on mid-turn sendTurn", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-steer");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId,
        input: "run 5 commands",
        modelSelection: {
          instanceId: ProviderInstanceId.make("opencode"),
          model: "openai/gpt-5",
        },
      });

      // Steer: OpenCode queues the prompt into the busy session, so the
      // active turn id is reused instead of opening a new turn.
      const steeredTurn = yield* adapter.sendTurn({
        threadId,
        input: "actually run 15",
        modelSelection: {
          instanceId: ProviderInstanceId.make("opencode"),
          model: "openai/gpt-5",
        },
      });
      NodeAssert.equal(String(steeredTurn.turnId), String(turn.turnId));

      const sessions = yield* adapter.listSessions();
      const session = sessions.find((entry) => entry.threadId === threadId);
      NodeAssert.equal(session?.status, "running");
      NodeAssert.equal(String(session?.activeTurnId), String(turn.turnId));
      NodeAssert.equal(runtimeMock.state.promptCalls.length, 2);
    }),
  );

  it.effect("keeps the running turn when a steer prompt fails", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-steer-failure");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId,
        input: "run 5 commands",
        modelSelection: {
          instanceId: ProviderInstanceId.make("opencode"),
          model: "openai/gpt-5",
        },
      });

      runtimeMock.state.promptAsyncError = new Error("steer failed");
      const error = yield* adapter
        .sendTurn({
          threadId,
          input: "actually run 15",
          modelSelection: {
            instanceId: ProviderInstanceId.make("opencode"),
            model: "openai/gpt-5",
          },
        })
        .pipe(Effect.flip);

      // The original turn keeps running — only the steer prompt failed.
      NodeAssert.equal(error._tag, "ProviderAdapterRequestError");
      const sessions = yield* adapter.listSessions();
      const session = sessions.find((entry) => entry.threadId === threadId);
      NodeAssert.equal(session?.status, "running");
      NodeAssert.equal(String(session?.activeTurnId), String(turn.turnId));
    }),
  );

  it.effect("passes agent and variant options for the adapter's bound custom instance id", () => {
    const instanceId = ProviderInstanceId.make("opencode_zen");
    const adapterLayer = Layer.effect(
      OpenCodeAdapter,
      makeOpenCodeAdapter(openCodeAdapterTestSettings, { instanceId }),
    ).pipe(
      Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(providerSessionDirectoryTestLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId: asThreadId("thread-custom-instance"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: asThreadId("thread-custom-instance"),
        input: "Fix it",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode_zen"),
          "anthropic/claude-sonnet-4-5",
          [
            { id: "agent", value: "github-copilot" },
            { id: "variant", value: "high" },
          ],
        ),
      });

      NodeAssert.deepEqual(runtimeMock.state.promptCalls.at(-1), {
        sessionID: "http://127.0.0.1:9999/session",
        model: {
          providerID: "anthropic",
          modelID: "claude-sonnet-4-5",
        },
        agent: "github-copilot",
        variant: "high",
        system: T3_HARNESS_SYSTEM_INSTRUCTIONS,
        parts: [{ type: "text", text: "Fix it" }],
      });
    }).pipe(Effect.provide(adapterLayer));
  });

  it.effect("uses the bound custom instance id for fallback sendTurn model selection", () => {
    const instanceId = ProviderInstanceId.make("opencode_zen");
    const adapterLayer = Layer.effect(
      OpenCodeAdapter,
      makeOpenCodeAdapter(openCodeAdapterTestSettings, { instanceId }),
    ).pipe(
      Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(providerSessionDirectoryTestLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-custom-instance-fallback-model");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode_zen"),
          "anthropic/claude-sonnet-4-5",
        ),
      });

      yield* adapter.sendTurn({
        threadId,
        input: "Fix it",
      });

      NodeAssert.deepEqual(runtimeMock.state.promptCalls.at(-1), {
        sessionID: "http://127.0.0.1:9999/session",
        model: {
          providerID: "anthropic",
          modelID: "claude-sonnet-4-5",
        },
        system: T3_HARNESS_SYSTEM_INSTRUCTIONS,
        parts: [{ type: "text", text: "Fix it" }],
      });
    }).pipe(Effect.provide(adapterLayer));
  });

  it.effect("rejects sendTurn model selections for another instance id", () => {
    const instanceId = ProviderInstanceId.make("opencode_zen");
    const adapterLayer = Layer.effect(
      OpenCodeAdapter,
      makeOpenCodeAdapter(openCodeAdapterTestSettings, { instanceId }),
    ).pipe(
      Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(providerSessionDirectoryTestLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-custom-instance-wrong-selection");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });

      const error = yield* adapter
        .sendTurn({
          threadId,
          input: "Fix it",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("opencode"),
            "anthropic/claude-sonnet-4-5",
          ),
        })
        .pipe(Effect.flip);

      NodeAssert.equal(error._tag, "ProviderAdapterValidationError");
      if (error._tag !== "ProviderAdapterValidationError") {
        throw new Error("Unexpected error type");
      }
      NodeAssert.equal(
        error.issue,
        "OpenCode model selection is bound to instance 'opencode', expected 'opencode_zen'.",
      );
      NodeAssert.deepEqual(runtimeMock.state.promptCalls, []);
    }).pipe(Effect.provide(adapterLayer));
  });

  it.effect("reverts the full thread when rollback removes every assistant turn", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-rollback-all");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });

      runtimeMock.state.messages = [
        {
          info: { id: "assistant-1", role: "assistant" },
          parts: [],
        },
        {
          info: { id: "assistant-2", role: "assistant" },
          parts: [],
        },
      ];

      const snapshot = yield* adapter.rollbackThread(threadId, 2);

      NodeAssert.deepEqual(runtimeMock.state.revertCalls, [
        { sessionID: "http://127.0.0.1:9999/session" },
      ]);
      NodeAssert.deepEqual(snapshot.turns, []);
    }),
  );

  it.effect("appends raw assistant text deltas and reconciles part update snapshots", () =>
    Effect.sync(() => {
      const firstUpdate = mergeOpenCodeAssistantText(undefined, "Hello");
      const overlapDelta = appendOpenCodeAssistantTextDelta(firstUpdate.latestText, "lo world");
      const secondUpdate = mergeOpenCodeAssistantText(overlapDelta.nextText, "Hellolo world");

      NodeAssert.deepEqual(
        [firstUpdate.deltaToEmit, overlapDelta.deltaToEmit, secondUpdate.deltaToEmit],
        ["Hello", "lo world", ""],
      );
      NodeAssert.equal(secondUpdate.latestText, "Hellolo world");
    }),
  );

  it.effect("splits inline think tags into reasoning and assistant text", () =>
    Effect.sync(() => {
      NodeAssert.deepEqual(splitInlineThinkingText("<think>hidden</think>answer"), {
        assistantText: "answer",
        reasoningText: "hidden",
        hasInlineThinking: true,
      });
    }),
  );

  it.effect("extracts actionable OpenCode session errors from provider response shapes", () =>
    Effect.sync(() => {
      NodeAssert.equal(
        sessionErrorMessage({
          error: {
            message: "model openai/gpt-oss-120b does not exist",
          },
        }),
        "model openai/gpt-oss-120b does not exist",
      );
      NodeAssert.equal(
        sessionErrorMessage({
          data: {
            error: {
              message: "rate limit exceeded",
            },
          },
        }),
        "rate limit exceeded",
      );
      NodeAssert.equal(
        sessionErrorMessage({
          name: "ContextOverflowError",
          data: {
            message:
              "Request too large for model `llama-3.1-8b-instant` on tokens per minute (TPM): Limit 6000, Requested 42347",
          },
        }),
        "Request too large for model `llama-3.1-8b-instant` on tokens per minute (TPM): Limit 6000, Requested 42347",
      );
      NodeAssert.equal(sessionErrorMessage("request timed out"), "request timed out");
      NodeAssert.equal(sessionErrorMessage({}), "OpenCode session failed.");
    }),
  );

  it.effect("streams inline-thinking assistant text as reasoning_text + assistant_text", () =>
    Effect.gen(function* () {
      const adapterLayer = makeOpenCodeAdapterTestLayer({ splitInlineThinking: true });
      const threadId = asThreadId("thread-inline-thinking-stream");
      const events = Array.from(
        yield* Effect.gen(function* () {
          const adapter = yield* OpenCodeAdapter;
          runtimeMock.state.subscribedEvents = [
            {
              type: "message.updated",
              properties: {
                sessionID: "http://127.0.0.1:9999/session",
                info: {
                  id: "msg-inline-thinking",
                  role: "assistant",
                },
              },
            },
            {
              type: "message.part.updated",
              properties: {
                sessionID: "http://127.0.0.1:9999/session",
                part: {
                  id: "part-inline-thinking",
                  messageID: "msg-inline-thinking",
                  type: "text",
                  text: "<think>hidden</think>answer",
                  time: { start: 1, end: 2 },
                },
                time: 2,
              },
            },
          ];

          const streamFiber = yield* adapter.streamEvents.pipe(
            Stream.filter((event) => event.threadId === threadId),
            Stream.take(5),
            Stream.runCollect,
            Effect.forkChild,
          );

          yield* adapter.startSession({
            provider: ProviderDriverKind.make("opencode"),
            threadId,
            runtimeMode: "full-access",
          });

          return yield* Fiber.join(streamFiber).pipe(Effect.timeout("1 second"));
        }).pipe(Effect.provide(adapterLayer)),
      );

      const deltas = events.filter((event) => event.type === "content.delta");
      NodeAssert.deepEqual(
        deltas.map((event) => (event.type === "content.delta" ? event.payload.streamKind : "")),
        ["reasoning_text", "assistant_text"],
      );
      NodeAssert.deepEqual(
        deltas.map((event) => (event.type === "content.delta" ? event.payload.delta : "")),
        ["hidden", "answer"],
      );
      NodeAssert.equal(events.at(-1)?.type, "item.completed");
      const completed = events.at(-1);
      if (completed?.type === "item.completed") {
        NodeAssert.equal(completed.payload.detail, "answer");
      }
    }),
  );

  it.effect("does not strip coincidental prefix overlap from OpenCode part deltas", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-raw-delta");
      const part = {
        id: "part-raw-delta",
        sessionID: "http://127.0.0.1:9999/session",
        messageID: "msg-raw-delta",
        type: "text",
        text: "A B",
        time: { start: 1 },
      };
      runtimeMock.state.subscribedEvents = [
        {
          type: "message.updated",
          properties: {
            sessionID: "http://127.0.0.1:9999/session",
            info: {
              id: "msg-raw-delta",
              role: "assistant",
            },
          },
        },
        {
          type: "message.part.updated",
          properties: {
            sessionID: "http://127.0.0.1:9999/session",
            part,
            time: 1,
          },
        },
        {
          type: "message.part.delta",
          properties: {
            sessionID: "http://127.0.0.1:9999/session",
            messageID: "msg-raw-delta",
            partID: "part-raw-delta",
            field: "text",
            delta: "Bonus",
          },
        },
        {
          type: "message.part.updated",
          properties: {
            sessionID: "http://127.0.0.1:9999/session",
            part: {
              ...part,
              text: "A BBonus",
              time: { start: 1, end: 2 },
            },
            time: 2,
          },
        },
      ];
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.take(5),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
      const deltas = events.filter((event) => event.type === "content.delta");
      NodeAssert.deepEqual(
        deltas.map((event) => (event.type === "content.delta" ? event.payload.delta : "")),
        ["A B", "Bonus"],
      );
      NodeAssert.equal(events.at(-1)?.type, "item.completed");
      const completed = events.at(-1);
      if (completed?.type === "item.completed") {
        NodeAssert.equal(completed.payload.detail, "A BBonus");
      }
    }),
  );

  it.effect("writes provider-native observability records using the session thread id", () =>
    Effect.gen(function* () {
      const nativeEvents: Array<{
        readonly event?: {
          readonly provider?: string;
          readonly threadId?: string;
          readonly providerThreadId?: string;
          readonly type?: string;
        };
      }> = [];
      const nativeThreadIds: Array<string | null> = [];
      runtimeMock.state.subscribedEvents = [
        {
          type: "message.updated",
          properties: {
            info: {
              id: "msg-missing-session",
              role: "assistant",
            },
          },
        },
        {
          type: "message.updated",
          properties: {
            sessionID: "http://127.0.0.1:9999/other-session",
            info: {
              id: "msg-other-session",
              role: "assistant",
            },
          },
        },
        {
          type: "message.updated",
          properties: {
            sessionID: "http://127.0.0.1:9999/session",
            info: {
              id: "msg-native-log",
              role: "assistant",
            },
          },
        },
      ];

      const nativeEventLogger = {
        filePath: "memory://opencode-native-events",
        write: (event: unknown, threadId: ThreadId | null) => {
          nativeEvents.push(event as (typeof nativeEvents)[number]);
          nativeThreadIds.push(threadId ?? null);
          return Effect.void;
        },
        close: () => Effect.void,
      };

      const adapterLayer = Layer.effect(
        OpenCodeAdapter,
        makeOpenCodeAdapter(openCodeAdapterTestSettings, {
          nativeEventLogger,
        }),
      ).pipe(
        Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
        Layer.provideMerge(
          ServerSettingsService.layerTest({
            providers: {
              opencode: {
                binaryPath: "fake-opencode",
                serverUrl: "http://127.0.0.1:9999",
                serverPassword: "secret-password",
              },
            },
          }),
        ),
        Layer.provideMerge(providerSessionDirectoryTestLayer),
        Layer.provideMerge(NodeServices.layer),
      );

      const session = yield* Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const started = yield* adapter.startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId: asThreadId("thread-native-log"),
          runtimeMode: "full-access",
        });
        yield* advanceTestClock(10);
        return started;
      }).pipe(Effect.provide(adapterLayer));

      NodeAssert.equal(session.threadId, "thread-native-log");
      NodeAssert.equal(nativeEvents.length, 1);
      NodeAssert.equal(
        nativeEvents.some((record) => record.event?.provider === "opencode"),
        true,
      );
      NodeAssert.equal(
        nativeEvents.some(
          (record) => record.event?.providerThreadId === "http://127.0.0.1:9999/session",
        ),
        true,
      );
      NodeAssert.equal(
        nativeEvents.some((record) => record.event?.threadId === "thread-native-log"),
        true,
      );
      NodeAssert.equal(
        nativeEvents.some((record) => record.event?.type === "message.updated"),
        true,
      );
      NodeAssert.equal(
        nativeThreadIds.every((threadId) => threadId === "thread-native-log"),
        true,
      );
    }),
  );

  it.effect("keeps the event pump alive when native event logging fails", () =>
    Effect.gen(function* () {
      runtimeMock.state.subscribedEvents = [
        {
          type: "message.updated",
          properties: {
            sessionID: "http://127.0.0.1:9999/session",
            info: {
              id: "msg-native-log-failure",
              role: "assistant",
            },
          },
        },
      ];

      const nativeEventLogger = {
        filePath: "memory://opencode-native-events",
        write: () => Effect.die(new Error("native log write failed")),
        close: () => Effect.void,
      };

      const adapterLayer = Layer.effect(
        OpenCodeAdapter,
        makeOpenCodeAdapter(openCodeAdapterTestSettings, {
          nativeEventLogger,
        }),
      ).pipe(
        Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
        Layer.provideMerge(
          ServerSettingsService.layerTest({
            providers: {
              opencode: {
                binaryPath: "fake-opencode",
                serverUrl: "http://127.0.0.1:9999",
                serverPassword: "secret-password",
              },
            },
          }),
        ),
        Layer.provideMerge(providerSessionDirectoryTestLayer),
        Layer.provideMerge(NodeServices.layer),
      );

      // Capture closeCalls *inside* the provided layer scope: the adapter's
      // layer finalizer now tears down any live sessions when the layer
      // closes (which is exactly what we want for leak prevention), so
      // inspecting closeCalls after `Effect.provide` completes would observe
      // the teardown — not the behavior under test. We care that the event
      // pump kept the session alive while logging was failing.
      const { sessions, closeCallsDuringRun } = yield* Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        yield* adapter.startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId: asThreadId("thread-native-log-failure"),
          runtimeMode: "full-access",
        });
        yield* advanceTestClock(10);
        return {
          sessions: yield* adapter.listSessions(),
          closeCallsDuringRun: [...runtimeMock.state.closeCalls],
        };
      }).pipe(Effect.provide(adapterLayer));

      NodeAssert.equal(sessions.length, 1);
      NodeAssert.equal(sessions[0]?.threadId, "thread-native-log-failure");
      NodeAssert.deepEqual(closeCallsDuringRun, []);
    }),
  );
});
