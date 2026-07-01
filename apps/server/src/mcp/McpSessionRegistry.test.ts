import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServer } from "effect/unstable/http";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";

const environmentId = EnvironmentId.make("environment-1");
const makeFakeHttpServer = (hostname: string, port = 43123) =>
  HttpServer.HttpServer.of({
    address: { _tag: "TcpAddress", hostname, port },
    serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
  });
const fakeHttpServer = makeFakeHttpServer("127.0.0.1");
const fakeEnvironment = ServerEnvironment.ServerEnvironment.of({
  getEnvironmentId: Effect.succeed(environmentId),
  getDescriptor: Effect.die("unused"),
});

const makeRegistry = (
  now: () => number,
  httpServer = fakeHttpServer,
  serverSettingsLayer = ServerSettingsService.layerTest(),
) =>
  McpSessionRegistry.__testing
    .make({
      now,
      idleTimeoutMs: 100,
      maximumLifetimeMs: 1_000,
    })
    .pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(HttpServer.HttpServer, httpServer),
          Layer.succeed(ServerEnvironment.ServerEnvironment, fakeEnvironment),
          serverSettingsLayer,
          NodeServices.layer,
        ),
      ),
    );

it.effect("uses one global bearer token scoped to issued thread URL contexts", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry(() => 1_000);
    const threadId = ThreadId.make("thread-1");
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("codex"),
    });
    expect(issued.config.endpoint).toBe(
      "http://127.0.0.1:43123/mcp?threadId=thread-1&providerInstanceId=codex",
    );
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    expect(token.length).toBeGreaterThan(20);

    const secondIssued = yield* registry.issue({
      threadId: ThreadId.make("thread-2"),
      providerInstanceId: ProviderInstanceId.make("claude"),
    });
    expect(secondIssued.config.authorizationHeader).toBe(issued.config.authorizationHeader);
    expect(secondIssued.config.endpoint).toBe(
      "http://127.0.0.1:43123/mcp?threadId=thread-2&providerInstanceId=claude",
    );

    const resolved = yield* registry.resolve(token, {
      threadId,
      providerInstanceId: ProviderInstanceId.make("codex"),
    });
    expect(resolved?.threadId).toBe(threadId);
    expect(resolved?.providerSessionId).toBe("global");
    expect(resolved?.capabilities.has("preview")).toBe(false);
    expect(resolved?.capabilities.has(McpInvocationContext.T3_SUBAGENT_MCP_CAPABILITY)).toBe(true);

    expect(
      yield* registry.resolve(token, {
        threadId: ThreadId.make("thread-never-issued"),
        providerInstanceId: ProviderInstanceId.make("codex"),
      }),
    ).toBeUndefined();

    yield* registry.revokeThread(threadId);
    expect(
      yield* registry.resolve(token, {
        threadId,
        providerInstanceId: ProviderInstanceId.make("codex"),
      }),
    ).toBeUndefined();
  }),
);

it.effect("builds MCP endpoints from the bound server host", () =>
  Effect.gen(function* () {
    const cases = [
      ["100.64.0.40", "http://100.64.0.40:43123/mcp"],
      ["0.0.0.0", "http://127.0.0.1:43123/mcp"],
      ["localhost", "http://localhost:43123/mcp"],
      ["127.0.0.1", "http://127.0.0.1:43123/mcp"],
    ] as const;

    for (const [hostname, expectedEndpoint] of cases) {
      const registry = yield* makeRegistry(() => 1_000, makeFakeHttpServer(hostname));
      const issued = yield* registry.issue({
        threadId: ThreadId.make(`thread-${hostname}`),
        providerInstanceId: ProviderInstanceId.make("codex"),
      });
      expect(issued.config.endpoint).toBe(
        `${expectedEndpoint}?threadId=thread-${encodeURIComponent(hostname)}&providerInstanceId=codex`,
      );
    }
  }),
);

it.effect("revokes the global credential on revokeAll", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry(() => 1_000);
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-2"),
      providerInstanceId: ProviderInstanceId.make("claude"),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    yield* registry.revokeAll;
    expect(
      yield* registry.resolve(token, {
        threadId: ThreadId.make("thread-2"),
        providerInstanceId: ProviderInstanceId.make("claude"),
      }),
    ).toBeUndefined();
  }),
);

it.effect("resolves T3 MCP tool grants from the live capability registry settings", () =>
  Effect.gen(function* () {
    const settingsLayer = ServerSettingsService.layerTest({
      capabilityRegistry: {
        skillRoots: [],
        overrides: {
          "t3:tool:subagent": {
            enabled: false,
          },
        },
      },
    });
    const registry = yield* makeRegistry(() => 1_000, fakeHttpServer, settingsLayer);
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-disabled"),
      providerInstanceId: ProviderInstanceId.make("codex"),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    const disabled = yield* registry.resolve(token, {
      threadId: ThreadId.make("thread-disabled"),
      providerInstanceId: ProviderInstanceId.make("codex"),
    });
    expect(disabled?.capabilities.has(McpInvocationContext.T3_SUBAGENT_MCP_CAPABILITY)).toBe(false);

    const hiddenActivationRegistry = yield* makeRegistry(
      () => 1_000,
      fakeHttpServer,
      ServerSettingsService.layerTest({
        capabilityRegistry: {
          skillRoots: [],
          overrides: {
            "t3:tool:subagent": {
              enabled: true,
              activation: "hidden",
            },
          },
        },
      }),
    );
    const hiddenActivationIssued = yield* hiddenActivationRegistry.issue({
      threadId: ThreadId.make("thread-hidden-activation"),
      providerInstanceId: ProviderInstanceId.make("codex"),
    });
    const hiddenActivationToken = hiddenActivationIssued.config.authorizationHeader.replace(
      /^Bearer\s+/,
      "",
    );
    const hidden = yield* hiddenActivationRegistry.resolve(hiddenActivationToken, {
      threadId: ThreadId.make("thread-hidden-activation"),
      providerInstanceId: ProviderInstanceId.make("codex"),
    });
    expect(hidden?.capabilities.has(McpInvocationContext.T3_SUBAGENT_MCP_CAPABILITY)).toBe(false);

    const invalidActivationRegistry = yield* makeRegistry(
      () => 1_000,
      fakeHttpServer,
      ServerSettingsService.layerTest({
        capabilityRegistry: {
          skillRoots: [],
          overrides: {
            "t3:tool:subagent": {
              enabled: true,
              activation: "command",
            },
          },
        },
      }),
    );
    const invalidActivationIssued = yield* invalidActivationRegistry.issue({
      threadId: ThreadId.make("thread-invalid-activation"),
      providerInstanceId: ProviderInstanceId.make("codex"),
    });
    const invalidActivationToken = invalidActivationIssued.config.authorizationHeader.replace(
      /^Bearer\s+/,
      "",
    );
    const enabled = yield* invalidActivationRegistry.resolve(invalidActivationToken, {
      threadId: ThreadId.make("thread-invalid-activation"),
      providerInstanceId: ProviderInstanceId.make("codex"),
    });
    expect(enabled?.capabilities.has(McpInvocationContext.T3_SUBAGENT_MCP_CAPABILITY)).toBe(true);
  }),
);
