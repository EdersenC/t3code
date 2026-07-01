import { expect, it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeTimersPromises from "node:timers/promises";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  type OrchestrationCommand,
  type OrchestrationThread,
  PreviewTabId,
  ProjectId,
  ProviderInstanceId,
  type ServerSettings,
  type ServerSettingsPatch,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/unstable/ai";
import {
  HttpBody,
  HttpClient,
  HttpRouter,
  HttpServer,
  HttpServerResponse,
} from "effect/unstable/http";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../orchestration/Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";

const environmentId = EnvironmentId.make("environment-mcp-test");
const threadId = ThreadId.make("thread-mcp-test");
const parentTurnId = TurnId.make("turn-mcp-test");
const tabId = PreviewTabId.make("tab-mcp-test");
const invocation = {
  environmentId,
  threadId,
  providerSessionId: "provider-session-mcp-test",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["preview"] as const),
  issuedAt: 1,
  expiresAt: Number.MAX_SAFE_INTEGER,
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  initializePayload: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});
const now = "2026-01-01T00:00:00.000Z";
const parentThread: OrchestrationThread = {
  id: threadId,
  projectId: ProjectId.make("project-mcp-test"),
  title: "Parent MCP thread",
  modelSelection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5",
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "main",
  worktreePath: "/repo",
  latestTurn: {
    turnId: parentTurnId,
    state: "running",
    requestedAt: now,
    startedAt: now,
    completedAt: null,
    assistantMessageId: null,
  },
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  deletedAt: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
};
const TestLayer = McpHttpServer.PreviewToolkitRegistrationLive.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(PreviewAutomationBroker.layer.pipe(Layer.provide(NodeServices.layer))),
);
const fakeHttpServer = HttpServer.HttpServer.of({
  address: { _tag: "TcpAddress", hostname: "127.0.0.1", port: 43123 },
  serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
});
const fakeEnvironment = ServerEnvironment.ServerEnvironment.of({
  getEnvironmentId: Effect.succeed(environmentId),
  getDescriptor: Effect.die("unused"),
});

const makeRegistry = (settings?: Parameters<typeof ServerSettingsService.layerTest>[0]) =>
  McpSessionRegistry.__testing
    .make({
      now: () => 1_000,
    })
    .pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(HttpServer.HttpServer, fakeHttpServer),
          Layer.succeed(ServerEnvironment.ServerEnvironment, fakeEnvironment),
          ServerSettingsService.layerTest(settings ?? {}),
          NodeServices.layer,
        ),
      ),
    );

const waitForMacrotask = Effect.promise(() =>
  NodeTimersPromises.setTimeout(0).then(() => undefined),
);

const applyMutableServerSettingsPatch = (
  current: ServerSettings,
  patch: ServerSettingsPatch,
): ServerSettings => ({
  ...current,
  capabilityRegistry: patch.capabilityRegistry
    ? {
        skillRoots: patch.capabilityRegistry.skillRoots ?? current.capabilityRegistry.skillRoots,
        overrides: patch.capabilityRegistry.overrides ?? current.capabilityRegistry.overrides,
      }
    : current.capabilityRegistry,
});

function makeMutableServerSettingsLayer(initial: ServerSettings = DEFAULT_SERVER_SETTINGS) {
  return Layer.effect(
    ServerSettingsService,
    Effect.gen(function* () {
      const ref = yield* Ref.make<ServerSettings>(initial);
      const changes = yield* PubSub.unbounded<ServerSettings>();
      return ServerSettingsService.of({
        start: Effect.void,
        ready: Effect.void,
        getSettings: Ref.get(ref),
        updateSettings: (patch) =>
          Effect.gen(function* () {
            const next = applyMutableServerSettingsPatch(yield* Ref.get(ref), patch);
            yield* Ref.set(ref, next);
            yield* PubSub.publish(changes, next);
            return next;
          }),
        streamChanges: Stream.fromPubSub(changes),
      });
    }),
  );
}

function makeProjectionLayer(thread: OrchestrationThread | null) {
  return Layer.succeed(ProjectionSnapshotQuery, {
    getThreadDetailById: () => Effect.succeed(thread ? Option.some(thread) : Option.none()),
  } as unknown as ProjectionSnapshotQueryShape);
}

function makeEngineLayer(dispatched: Array<OrchestrationCommand>) {
  let sequence = 0;
  return Layer.succeed(OrchestrationEngineService, {
    readEvents: () => Stream.empty,
    dispatch: (command) =>
      Effect.sync(() => {
        dispatched.push(command);
        sequence += 1;
        return { sequence };
      }),
    streamDomainEvents: Stream.empty,
  } satisfies OrchestrationEngineShape);
}

function makeSubagentProductionLayer(dispatched: Array<OrchestrationCommand>) {
  return McpHttpServer.T3SubagentToolkitRegistrationLive.pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "mcp-subagent-test-" })),
    Layer.provideMerge(ServerSettingsService.layerTest({})),
    Layer.provideMerge(makeProjectionLayer(parentThread)),
    Layer.provideMerge(makeEngineLayer(dispatched)),
    Layer.provideMerge(NodeServices.layer),
  );
}

function makeSubagentHttpLayer(input: {
  readonly registry: McpSessionRegistry.McpSessionRegistry["Service"];
  readonly dispatched: Array<OrchestrationCommand>;
}) {
  return McpHttpServer.layer.pipe(
    Layer.provide(Layer.succeed(McpSessionRegistry.McpSessionRegistry, input.registry)),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "mcp-subagent-http-" })),
    Layer.provideMerge(ServerSettingsService.layerTest({})),
    Layer.provideMerge(makeProjectionLayer(parentThread)),
    Layer.provideMerge(makeEngineLayer(input.dispatched)),
    Layer.provideMerge(NodeServices.layer),
  );
}

it("normalizes empty successful notification responses to accepted", () => {
  const notificationResponse = McpHttpServer.normalizeMcpHttpResponse(
    HttpServerResponse.text("", { status: 200, contentType: "application/json" }),
  );
  expect(notificationResponse.status).toBe(202);

  const resultResponse = McpHttpServer.normalizeMcpHttpResponse(
    HttpServerResponse.jsonUnsafe({ jsonrpc: "2.0", id: 1, result: {} }),
  );
  expect(resultResponse.status).toBe(200);
});

it.effect("returns bounded structural preview snapshot failures", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const events = yield* broker.connect({
        clientId: "mcp-failure-client",
        environmentId,
      });
      yield* Stream.runForEach(events, (event) =>
        event.type === "connected"
          ? Effect.void
          : broker.respond({
              clientId: "mcp-failure-client",
              connectionId: event.connectionId,
              requestId: event.request.requestId,
              ok: false,
              error: {
                _tag: "PreviewAutomationExecutionError",
                message: "sensitive renderer failure",
                detail: { consoleOutput: "sensitive browser output" },
              },
            }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const snapshot = yield* server
        .callTool({ name: "preview_snapshot", arguments: {} })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

      expect(snapshot.isError).toBe(true);
      expect(snapshot.content).toEqual([{ type: "text", text: "Preview snapshot failed." }]);
      expect(snapshot.structuredContent).toEqual({
        error: {
          _tag: "PreviewAutomationExecutionError",
          operation: "snapshot",
          failureCount: 1,
        },
      });
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("terminates HTTP MCP sessions with DELETE", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const serverLayer = McpServer.layerHttp({
        name: "MCP termination test",
        version: "1.0.0",
        path: "/mcp",
      });
      yield* HttpRouter.serve(serverLayer, {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.build);
      const httpClient = yield* HttpClient.HttpClient;

      const initializeResponse = yield* httpClient.post("/mcp", {
        headers: { accept: "application/json, text/event-stream" },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"mcp-test","version":"1.0.0"}}}`,
          "application/json",
        ),
      });
      const sessionId = initializeResponse.headers["mcp-session-id"];
      expect(initializeResponse.status).toBe(200);
      expect(sessionId).not.toBeNull();

      const missingSessionResponse = yield* httpClient.del("/mcp");
      expect(missingSessionResponse.status).toBe(400);

      const unknownSessionResponse = yield* httpClient.del("/mcp", {
        headers: { "mcp-session-id": "unknown-session" },
      });
      expect(unknownSessionResponse.status).toBe(404);

      const terminateResponse = yield* httpClient.del("/mcp", {
        headers: { "mcp-session-id": sessionId! },
      });
      expect(terminateResponse.status).toBe(204);

      const reusedSessionResponse = yield* httpClient.post("/mcp", {
        headers: {
          accept: "application/json, text/event-stream",
          "mcp-session-id": sessionId!,
        },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":2,"method":"ping","params":{}}`,
          "application/json",
        ),
      });
      expect(reusedSessionResponse.status).toBe(404);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("registers the T3 subagent toolkit with the production runtime", () => {
  const dispatched: Array<OrchestrationCommand> = [];
  return Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const subagentTool = server.tools.find(({ tool }) => tool.name === "t3_subagent");
      expect(subagentTool?.tool.annotations?.readOnlyHint).toBe(false);
      expect(subagentTool?.tool.annotations?.destructiveHint).toBe(false);

      const result = yield* server
        .callTool({
          name: "t3_subagent",
          arguments: {
            subagentType: "review",
            prompt: "Review the pending change.",
          },
        })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, {
            ...invocation,
            capabilities: new Set([McpInvocationContext.T3_SUBAGENT_MCP_CAPABILITY]),
          }),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

      expect(result.isError).toBe(false);
      expect(result.structuredContent).toMatchObject({
        status: "started",
        parentThreadId: threadId,
        subagentType: "review",
        title: "Review",
      });
      expect(dispatched.map((command) => command.type)).toEqual([
        "thread.create",
        "thread.activity.append",
        "thread.turn.start",
      ]);

      const activityCommand = dispatched[1] as Extract<
        OrchestrationCommand,
        { type: "thread.activity.append" }
      >;
      expect(activityCommand.threadId).toBe(threadId);
      expect(activityCommand.activity.kind).toBe("t3.subagent.started");
      expect(activityCommand.activity.payload).toMatchObject({
        capabilityId: "t3:subagent:review",
        capabilityKind: "subagent",
        capabilitySource: "t3",
        harnessName: "T3 MCP",
        toolName: "t3_subagent",
        subagentType: "review",
        parentThreadId: threadId,
      });

      const turnCommand = dispatched[2] as Extract<
        OrchestrationCommand,
        { type: "thread.turn.start" }
      >;
      expect(turnCommand.message.text).toContain("You are the T3 review subagent.");
      expect(turnCommand.message.text).toContain("Review the pending change.");
    }),
  ).pipe(Effect.provide(makeSubagentProductionLayer(dispatched)));
});

it.effect("serves T3 subagent calls through authenticated HTTP MCP", () => {
  const dispatched: Array<OrchestrationCommand> = [];
  return Effect.scoped(
    Effect.gen(function* () {
      const registry = yield* makeRegistry();
      yield* HttpRouter.serve(makeSubagentHttpLayer({ registry, dispatched }), {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.build);
      const issued = yield* registry.issue({
        threadId,
        providerInstanceId: ProviderInstanceId.make("codex"),
      });
      const authorization = issued.config.authorizationHeader;
      const endpoint = "/mcp?threadId=thread-mcp-test&providerInstanceId=codex";
      const httpClient = yield* HttpClient.HttpClient;

      const initializeResponse = yield* httpClient.post(endpoint, {
        headers: {
          accept: "application/json, text/event-stream",
          authorization,
        },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"mcp-http-test","version":"1.0.0"}}}`,
          "application/json",
        ),
      });
      expect(initializeResponse.status).toBe(200);
      const sessionId = initializeResponse.headers["mcp-session-id"];
      expect(sessionId).toBeDefined();

      const callResponse = yield* httpClient.post(endpoint, {
        headers: {
          accept: "application/json, text/event-stream",
          authorization,
          "mcp-session-id": sessionId!,
        },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"t3_subagent","arguments":{"subagentType":"review","prompt":"Review the HTTP MCP path."}}}`,
          "application/json",
        ),
      });
      expect(callResponse.status).toBe(200);
      const body = (yield* callResponse.json) as {
        readonly result?: {
          readonly isError?: boolean;
          readonly structuredContent?: Record<string, unknown>;
        };
      };
      expect(body.result?.isError).toBe(false);
      expect(body.result?.structuredContent).toMatchObject({
        status: "started",
        parentThreadId: threadId,
        subagentType: "review",
      });
      expect(dispatched.map((command) => command.type)).toEqual([
        "thread.create",
        "thread.activity.append",
        "thread.turn.start",
      ]);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest));
});

it.effect("filters hidden T3 tools from authenticated HTTP MCP tool listings", () => {
  const dispatched: Array<OrchestrationCommand> = [];
  return Effect.scoped(
    Effect.gen(function* () {
      const registry = yield* makeRegistry();
      yield* HttpRouter.serve(makeSubagentHttpLayer({ registry, dispatched }), {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.build);
      const issued = yield* registry.issue({
        threadId,
        providerInstanceId: ProviderInstanceId.make("codex"),
      });
      const endpoint = "/mcp?threadId=thread-mcp-test&providerInstanceId=codex";
      const httpClient = yield* HttpClient.HttpClient;

      const initializeResponse = yield* httpClient.post(endpoint, {
        headers: {
          accept: "application/json, text/event-stream",
          authorization: issued.config.authorizationHeader,
        },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"mcp-list-test","version":"1.0.0"}}}`,
          "application/json",
        ),
      });
      expect(initializeResponse.status).toBe(200);
      const sessionId = initializeResponse.headers["mcp-session-id"];
      expect(sessionId).toBeDefined();

      const enabledListResponse = yield* httpClient.post(endpoint, {
        headers: {
          accept: "application/json, text/event-stream",
          authorization: issued.config.authorizationHeader,
          "mcp-session-id": sessionId!,
        },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}`,
          "application/json",
        ),
      });
      expect(enabledListResponse.status).toBe(200);
      const enabledList = (yield* enabledListResponse.json) as {
        readonly result?: {
          readonly tools?: ReadonlyArray<{ readonly name?: string }>;
        };
      };
      expect(enabledList.result?.tools?.some((tool) => tool.name === "t3_subagent")).toBe(true);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest));
});

it.effect("omits disabled T3 tools from authenticated HTTP MCP tool listings", () => {
  const dispatched: Array<OrchestrationCommand> = [];
  return Effect.scoped(
    Effect.gen(function* () {
      const registry = yield* makeRegistry({
        capabilityRegistry: {
          skillRoots: [],
          overrides: {
            "t3:tool:subagent": {
              enabled: true,
              activation: "hidden",
            },
          },
        },
      });
      yield* HttpRouter.serve(makeSubagentHttpLayer({ registry, dispatched }), {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.build);
      const issued = yield* registry.issue({
        threadId,
        providerInstanceId: ProviderInstanceId.make("codex"),
      });
      const endpoint = "/mcp?threadId=thread-mcp-test&providerInstanceId=codex";
      const httpClient = yield* HttpClient.HttpClient;

      const initializeResponse = yield* httpClient.post(endpoint, {
        headers: {
          accept: "application/json, text/event-stream",
          authorization: issued.config.authorizationHeader,
        },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"mcp-hidden-list-test","version":"1.0.0"}}}`,
          "application/json",
        ),
      });
      expect(initializeResponse.status).toBe(200);
      const sessionId = initializeResponse.headers["mcp-session-id"];
      expect(sessionId).toBeDefined();

      const hiddenListResponse = yield* httpClient.post(endpoint, {
        headers: {
          accept: "application/json, text/event-stream",
          authorization: issued.config.authorizationHeader,
          "mcp-session-id": sessionId!,
        },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}`,
          "application/json",
        ),
      });
      expect(hiddenListResponse.status).toBe(200);
      const hiddenList = (yield* hiddenListResponse.json) as {
        readonly result?: {
          readonly tools?: ReadonlyArray<{ readonly name?: string }>;
        };
      };
      expect(hiddenList.result?.tools?.some((tool) => tool.name === "t3_subagent")).toBe(false);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest));
});

it.effect("notifies MCP clients when T3 tool visibility changes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const settings = yield* ServerSettingsService;
      yield* Effect.yieldNow;

      expect(Option.isNone(yield* Queue.poll(server.notificationsQueue))).toBe(true);

      yield* settings.updateSettings({
        capabilityRegistry: {
          overrides: {
            [McpInvocationContext.T3_SUBAGENT_MCP_CAPABILITY]: {
              enabled: true,
              activation: "hidden",
            },
          },
        },
      });
      yield* waitForMacrotask;
      expect(Option.getOrThrow(yield* Queue.poll(server.notificationsQueue)).tag).toBe(
        "notifications/tools/list_changed",
      );

      yield* settings.updateSettings({
        capabilityRegistry: {
          overrides: {
            [McpInvocationContext.T3_SUBAGENT_MCP_CAPABILITY]: {
              enabled: false,
              activation: "hidden",
            },
          },
        },
      });
      yield* waitForMacrotask;
      expect(Option.isNone(yield* Queue.poll(server.notificationsQueue))).toBe(true);

      yield* settings.updateSettings({
        capabilityRegistry: {
          overrides: {
            [McpInvocationContext.T3_SUBAGENT_MCP_CAPABILITY]: {
              enabled: true,
              activation: "on-demand",
            },
          },
        },
      });
      yield* waitForMacrotask;
      expect(Option.getOrThrow(yield* Queue.poll(server.notificationsQueue)).tag).toBe(
        "notifications/tools/list_changed",
      );
    }),
  ).pipe(
    Effect.provide(
      McpHttpServer.T3ToolCatalogNotificationLive.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provideMerge(makeMutableServerSettingsLayer()),
      ),
    ),
  ),
);

it.effect("registers annotated tools and preserves authenticated request context", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const events = yield* broker.connect({
        clientId: "mcp-test-client",
        environmentId,
      });
      yield* Stream.runForEach(events, (event) =>
        event.type === "connected"
          ? Effect.void
          : broker.respond({
              clientId: "mcp-test-client",
              connectionId: event.connectionId,
              requestId: event.request.requestId,
              ok: true,
              result:
                event.request.operation === "snapshot"
                  ? {
                      url: "http://example.test/",
                      title: "Example",
                      loading: false,
                      visibleText: "Example",
                      interactiveElements: [],
                      accessibilityTree: {},
                      consoleEntries: [],
                      networkEntries: [],
                      actionTimeline: [],
                      screenshot: {
                        mimeType: "image/png",
                        data: Buffer.from("png").toString("base64"),
                        width: 10,
                        height: 5,
                      },
                    }
                  : event.request.operation === "press"
                    ? undefined
                    : {
                        available: true,
                        visible: true,
                        tabId,
                        url: "http://example.test/",
                        title: "Example",
                        loading: false,
                      },
            }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const statusTool = server.tools.find(({ tool }) => tool.name === "preview_status");
      expect(statusTool?.tool.annotations?.readOnlyHint).toBe(true);
      expect(statusTool?.tool.annotations?.idempotentHint).toBe(true);
      expect(statusTool?.tool.annotations?.destructiveHint).toBe(false);

      const snapshotTool = server.tools.find(({ tool }) => tool.name === "preview_snapshot");
      expect(snapshotTool?.tool.annotations?.readOnlyHint).toBe(true);
      expect(snapshotTool?.tool.annotations?.idempotentHint).toBe(true);
      expect(snapshotTool?.tool.annotations?.openWorldHint).toBe(true);

      const clickTool = server.tools.find(({ tool }) => tool.name === "preview_click");
      expect(clickTool?.tool.annotations?.readOnlyHint).toBe(false);
      expect(clickTool?.tool.annotations?.destructiveHint).toBe(true);
      expect(clickTool?.tool.annotations?.openWorldHint).toBe(true);

      const navigateTool = server.tools.find(({ tool }) => tool.name === "preview_navigate");
      expect(navigateTool?.tool.annotations?.destructiveHint).toBe(false);
      expect(navigateTool?.tool.annotations?.openWorldHint).toBe(true);

      const status = yield* server
        .callTool({ name: "preview_status", arguments: {} })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(status.isError).toBe(false);
      expect(status.structuredContent).toMatchObject({
        available: true,
        tabId,
      });

      const malformed = yield* server
        .callTool({ name: "preview_click", arguments: { selector: "" } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(malformed.isError).toBe(true);

      const snapshot = yield* server
        .callTool({ name: "preview_snapshot", arguments: {} })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(snapshot.isError).toBe(false);
      expect(snapshot.content.some((content) => content.type === "image")).toBe(true);
      expect(snapshot.structuredContent).toMatchObject({
        screenshot: { mimeType: "image/png", width: 10, height: 5 },
      });

      const press = yield* server
        .callTool({ name: "preview_press", arguments: { key: "Enter" } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(press.isError).toBe(false);
      expect(press.structuredContent).toBeNull();
      expect(press.content).toEqual([{ type: "text", text: "null" }]);
    }),
  ).pipe(Effect.provide(TestLayer)),
);
