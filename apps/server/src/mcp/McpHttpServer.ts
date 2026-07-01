import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import type * as Types from "effect/Types";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { McpSchema, McpServer, Tool } from "effect/unstable/ai";
import { HttpBody, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import packageJson from "../../package.json" with { type: "json" };
import { ServerSettingsService } from "../serverSettings.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";
import * as T3SubagentRuntime from "./T3SubagentRuntime.ts";
import {
  PreviewSnapshotToolkitHandlersLive,
  PreviewStandardToolkitHandlersLive,
} from "./toolkits/preview/handlers.ts";
import {
  PreviewSnapshotTool,
  PreviewSnapshotToolkit,
  PreviewStandardToolkit,
} from "./toolkits/preview/tools.ts";
import { T3SubagentToolkitHandlersLive } from "./toolkits/subagent/handlers.ts";
import { T3SubagentToolkit } from "./toolkits/subagent/tools.ts";

const unauthorized = HttpServerResponse.jsonUnsafe(
  {
    error: "invalid_mcp_credential",
    message: "A valid T3 MCP bearer credential and thread context are required.",
  },
  {
    status: 401,
    headers: {
      "cache-control": "no-store",
      "www-authenticate": "Bearer",
    },
  },
);

type AuthenticatedHttpEffect = Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  Types.unhandled,
  McpInvocationContext.McpInvocationContext
>;

type McpAuthMiddleware = (
  httpEffect: AuthenticatedHttpEffect,
) => Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  Types.unhandled,
  HttpServerRequest.HttpServerRequest
>;

export const normalizeMcpHttpResponse = (
  response: HttpServerResponse.HttpServerResponse,
): HttpServerResponse.HttpServerResponse => {
  const bodyIsEmpty =
    response.body._tag === "Empty" ||
    (response.body._tag === "Uint8Array" && response.body.contentLength === 0) ||
    (response.body._tag === "Raw" && response.body.contentLength === 0);
  return response.status === 200 && bodyIsEmpty
    ? HttpServerResponse.setStatus(response, 202)
    : response;
};

const t3ToolCapabilityByName: ReadonlyMap<string, McpInvocationContext.McpCapability> = new Map([
  ["t3_subagent", McpInvocationContext.T3_SUBAGENT_MCP_CAPABILITY],
]);

function filterMcpToolCatalogResponse(
  response: HttpServerResponse.HttpServerResponse,
  invocation: McpInvocationContext.McpInvocationScope,
): HttpServerResponse.HttpServerResponse {
  if (response.status !== 200 || response.body._tag !== "Uint8Array") return response;

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(response.body.body).toString("utf8"));
  } catch {
    return response;
  }

  if (
    typeof payload !== "object" ||
    payload === null ||
    !("result" in payload) ||
    typeof payload.result !== "object" ||
    payload.result === null ||
    !("tools" in payload.result) ||
    !Array.isArray(payload.result.tools)
  ) {
    return response;
  }

  const payloadWithTools = payload as {
    readonly result: { readonly tools: ReadonlyArray<unknown>; readonly [key: string]: unknown };
    readonly [key: string]: unknown;
  };

  const filteredTools = payloadWithTools.result.tools.filter((tool: unknown) => {
    if (
      typeof tool !== "object" ||
      tool === null ||
      !("name" in tool) ||
      typeof tool.name !== "string"
    ) {
      return true;
    }
    const capability = t3ToolCapabilityByName.get(tool.name);
    return capability === undefined || invocation.capabilities.has(capability);
  });

  if (filteredTools.length === payloadWithTools.result.tools.length) return response;

  return HttpServerResponse.setBody(
    response,
    HttpBody.jsonUnsafe({
      ...payloadWithTools,
      result: {
        ...payloadWithTools.result,
        tools: filteredTools,
      },
    }),
  );
}

const makeMcpAuthMiddleware = McpSessionRegistry.McpSessionRegistry.pipe(
  Effect.map(
    (registry): McpAuthMiddleware =>
      Effect.fn("McpHttpServer.authenticateRequest")(function* (httpEffect) {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const authorization = request.headers.authorization;
        const token =
          authorization?.startsWith("Bearer ") === true
            ? authorization.slice("Bearer ".length).trim()
            : "";
        const contextRequest = parseMcpInvocationContextRequest(request);
        if (!contextRequest) return unauthorized;
        const invocation = yield* registry.resolve(token, contextRequest);
        if (!invocation) return unauthorized;
        return yield* httpEffect.pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.map(normalizeMcpHttpResponse),
          Effect.map((response) => filterMcpToolCatalogResponse(response, invocation)),
        );
      }),
  ),
  Effect.withSpan("McpHttpServer.makeAuthMiddleware"),
);

const McpAuthMiddlewareLive = HttpRouter.middleware<{
  provides: McpInvocationContext.McpInvocationContext;
}>()(makeMcpAuthMiddleware).layer;

function parseMcpInvocationContextRequest(
  request: HttpServerRequest.HttpServerRequest,
): McpInvocationContext.McpInvocationContextRequest | undefined {
  const rawUrl = request.url;
  let url: URL;
  try {
    url = new URL(rawUrl, `http://${request.headers.host ?? "127.0.0.1"}`);
  } catch {
    return undefined;
  }
  const rawThreadId =
    url.searchParams.get("threadId") ?? request.headers["x-t3-thread-id"] ?? undefined;
  const rawProviderInstanceId =
    url.searchParams.get("providerInstanceId") ??
    request.headers["x-t3-provider-instance-id"] ??
    undefined;
  if (!rawThreadId || !rawProviderInstanceId) return undefined;
  return {
    threadId: ThreadId.make(rawThreadId),
    providerInstanceId: ProviderInstanceId.make(rawProviderInstanceId),
  };
}

const previewSnapshotFailure = <E>(cause: Cause.Cause<E>) => {
  if (Cause.hasInterrupts(cause) || cause.reasons.some(Cause.isDieReason)) {
    return Effect.failCause(cause).pipe(Effect.orDie);
  }
  const failures = cause.reasons.filter(Cause.isFailReason);
  const firstFailure = failures[0]?.error;
  const errorTag =
    typeof firstFailure === "object" &&
    firstFailure !== null &&
    "_tag" in firstFailure &&
    typeof firstFailure._tag === "string"
      ? firstFailure._tag
      : "PreviewSnapshotError";
  const result = new McpSchema.CallToolResult({
    isError: true,
    structuredContent: {
      error: {
        _tag: errorTag,
        operation: "snapshot",
        failureCount: failures.length,
      },
    },
    content: [{ type: "text", text: "Preview snapshot failed." }],
  });
  return Effect.logWarning("preview snapshot failed", {
    operation: "snapshot",
    errorTag,
    failureCount: failures.length,
  }).pipe(Effect.as(result));
};

const registerPreviewSnapshot = Effect.fn("McpHttpServer.registerPreviewSnapshot")(function* () {
  const server = yield* McpServer.McpServer;
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  const built = yield* PreviewSnapshotToolkit;
  const tool = PreviewSnapshotTool;
  yield* server.addTool({
    tool: new McpSchema.Tool({
      name: tool.name,
      description: Tool.getDescription(tool),
      inputSchema: Tool.getJsonSchema(tool),
      annotations: {
        ...Context.getOption(tool.annotations, Tool.Title).pipe(
          Option.map((title) => ({ title })),
          Option.getOrUndefined,
        ),
        readOnlyHint: Context.get(tool.annotations, Tool.Readonly),
        destructiveHint: Context.get(tool.annotations, Tool.Destructive),
        idempotentHint: Context.get(tool.annotations, Tool.Idempotent),
        openWorldHint: Context.get(tool.annotations, Tool.OpenWorld),
      },
    }),
    annotations: tool.annotations,
    handle: (payload) =>
      Effect.withFiber((fiber) => {
        const invocation = Context.getUnsafe(
          fiber.context,
          McpInvocationContext.McpInvocationContext,
        );
        return built.handle("preview_snapshot", payload).pipe(
          Stream.unwrap,
          Stream.run(Sink.last()),
          Effect.flatMap(Effect.fromOption),
          Effect.provideService(PreviewAutomationBroker.PreviewAutomationBroker, broker),
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.matchCauseEffect({
            onFailure: previewSnapshotFailure,
            onSuccess: ({ encodedResult }) => {
              const snapshot = encodedResult as {
                readonly screenshot: {
                  readonly mimeType: "image/png";
                  readonly data: string;
                  readonly width: number;
                  readonly height: number;
                };
                readonly [key: string]: unknown;
              };
              const { screenshot, ...page } = snapshot;
              const metadata = {
                ...page,
                screenshot: {
                  mimeType: screenshot.mimeType,
                  width: screenshot.width,
                  height: screenshot.height,
                },
              };
              return Effect.succeed(
                new McpSchema.CallToolResult({
                  isError: false,
                  structuredContent: metadata,
                  content: [
                    { type: "text", text: JSON.stringify(metadata) },
                    {
                      type: "image",
                      data: new Uint8Array(Buffer.from(screenshot.data, "base64")),
                      mimeType: screenshot.mimeType,
                    },
                  ],
                }),
              );
            },
          }),
        );
      }),
  });
});

const PreviewStandardToolkitRegistrationLive = McpServer.toolkit(PreviewStandardToolkit).pipe(
  Layer.provide(PreviewStandardToolkitHandlersLive),
);

const PreviewSnapshotRegistrationLive = Layer.effectDiscard(registerPreviewSnapshot()).pipe(
  Layer.provide(PreviewSnapshotToolkitHandlersLive),
);

export const PreviewToolkitRegistrationLive = Layer.mergeAll(
  PreviewStandardToolkitRegistrationLive,
  PreviewSnapshotRegistrationLive,
);

export const T3SubagentToolkitRegistrationLive = McpServer.toolkit(T3SubagentToolkit).pipe(
  Layer.provide(T3SubagentToolkitHandlersLive),
  Layer.provide(T3SubagentRuntime.layer),
);

export const T3ToolCatalogNotificationLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const settings = yield* ServerSettingsService;
    let previousVisible = McpSessionRegistry.isT3SubagentMcpCapabilityEnabled(
      yield* settings.getSettings,
    );

    yield* settings.streamChanges.pipe(
      Stream.runForEach((nextSettings) => {
        const nextVisible = McpSessionRegistry.isT3SubagentMcpCapabilityEnabled(nextSettings);
        if (nextVisible === previousVisible) return Effect.void;
        previousVisible = nextVisible;
        return server.notifications["notifications/tools/list_changed"]({});
      }),
      Effect.forkScoped,
    );
  }),
);

const McpTransportLive = McpServer.layerHttp({
  name: "T3 Code",
  version: packageJson.version,
  path: "/mcp",
}).pipe(Layer.provide(McpAuthMiddlewareLive));

export const layer = Layer.mergeAll(
  T3SubagentToolkitRegistrationLive,
  T3ToolCatalogNotificationLive,
).pipe(Layer.provideMerge(McpTransportLive));
