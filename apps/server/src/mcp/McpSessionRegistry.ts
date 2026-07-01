import { ProviderInstanceId, type ServerSettings, ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { HttpServer } from "effect/unstable/http";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpProviderSession from "./McpProviderSession.ts";

export interface McpCredentialRequest {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
}

export interface McpIssuedCredential {
  readonly config: McpProviderSession.McpProviderSessionConfig;
  readonly expiresAt: number;
}

export interface McpSessionRegistryShape {
  readonly issue: (request: McpCredentialRequest) => Effect.Effect<McpIssuedCredential>;
  readonly resolve: (
    rawToken: string,
    context: McpInvocationContext.McpInvocationContextRequest,
  ) => Effect.Effect<McpInvocationContext.McpInvocationScope | undefined>;
  readonly revokeProviderSession: (providerSessionId: string) => Effect.Effect<void>;
  readonly revokeThread: (threadId: ThreadId) => Effect.Effect<void>;
  readonly revokeAll: Effect.Effect<void>;
}

export class McpSessionRegistry extends Context.Service<
  McpSessionRegistry,
  McpSessionRegistryShape
>()("t3/mcp/McpSessionRegistry") {}

interface CredentialRecord {
  readonly tokenHash: string;
  readonly rawToken: string;
  readonly issuedAt: number;
}

interface RegistryState {
  readonly credential: CredentialRecord | null;
  readonly issuedContexts: ReadonlySet<string>;
}

export interface McpSessionRegistryOptions {
  readonly idleTimeoutMs?: number;
  readonly maximumLifetimeMs?: number;
  readonly now?: () => number;
}

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const tokenFromBytes = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

const getHttpMcpEndpointHost = (hostname: string): string => {
  const normalized = hostname.toLowerCase();
  const endpointHostname =
    normalized === "0.0.0.0" || normalized === "::" || normalized === "[::]"
      ? "127.0.0.1"
      : hostname;
  return endpointHostname.includes(":") && !endpointHostname.startsWith("[")
    ? `[${endpointHostname}]`
    : endpointHostname;
};

const mcpContextKey = (request: McpInvocationContext.McpInvocationContextRequest): string =>
  `${request.threadId}\u0000${request.providerInstanceId}`;

export function isT3SubagentMcpCapabilityEnabled(settings: ServerSettings): boolean {
  const subagentOverride =
    settings.capabilityRegistry.overrides[McpInvocationContext.T3_SUBAGENT_MCP_CAPABILITY];
  return subagentOverride?.enabled !== false && subagentOverride?.activation !== "hidden";
}

export function resolveT3McpCapabilitiesFromSettings(
  settings: ServerSettings,
): ReadonlySet<McpInvocationContext.McpCapability> {
  return new Set<McpInvocationContext.McpCapability>(
    isT3SubagentMcpCapabilityEnabled(settings)
      ? [McpInvocationContext.T3_SUBAGENT_MCP_CAPABILITY]
      : [],
  );
}

const resolveT3McpCapabilities = Effect.fn("McpSessionRegistry.resolveT3McpCapabilities")(
  function* (settings: ServerSettingsService["Service"]) {
    return resolveT3McpCapabilitiesFromSettings(yield* settings.getSettings);
  },
);

const makeWithOptions = Effect.fn("McpSessionRegistry.make")(function* (
  options: McpSessionRegistryOptions = {},
) {
  const crypto = yield* Crypto.Crypto;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const environmentId = yield* environment.getEnvironmentId;
  const serverSettings = yield* ServerSettingsService;
  const httpServer = yield* HttpServer.HttpServer;
  const state = yield* SynchronizedRef.make<RegistryState>({
    credential: null,
    issuedContexts: new Set<string>(),
  });
  const currentTimeMillis = options.now ? Effect.sync(options.now) : Clock.currentTimeMillis;
  const endpoint =
    httpServer.address._tag === "TcpAddress"
      ? `http://${getHttpMcpEndpointHost(httpServer.address.hostname)}:${httpServer.address.port}/mcp`
      : "http://127.0.0.1/mcp";

  const hashToken = (token: string) =>
    crypto
      .digest("SHA-256", new TextEncoder().encode(token))
      .pipe(Effect.map(bytesToHex), Effect.orDie);

  const endpointWithContext = (request: McpCredentialRequest): string => {
    const url = new URL(endpoint);
    url.searchParams.set("threadId", request.threadId);
    url.searchParams.set("providerInstanceId", request.providerInstanceId);
    return url.toString();
  };

  const makeCredential = Effect.gen(function* () {
    const issuedAt = yield* currentTimeMillis;
    const rawToken = yield* crypto.randomBytes(32).pipe(Effect.map(tokenFromBytes), Effect.orDie);
    const tokenHash = yield* hashToken(rawToken);
    return {
      tokenHash,
      rawToken,
      issuedAt,
    } satisfies CredentialRecord;
  });

  const issue: McpSessionRegistryShape["issue"] = Effect.fn("McpSessionRegistry.issue")(
    function* (request) {
      const credential = yield* SynchronizedRef.modifyEffect(state, (current) =>
        Effect.gen(function* () {
          const credential = current.credential ?? (yield* makeCredential);
          const issuedContexts = new Set(current.issuedContexts);
          issuedContexts.add(mcpContextKey(request));
          return [
            credential,
            {
              credential,
              issuedContexts,
            },
          ] as const;
        }),
      );
      return {
        config: {
          environmentId,
          threadId: ThreadId.make(request.threadId),
          providerSessionId: "global",
          providerInstanceId: ProviderInstanceId.make(request.providerInstanceId),
          endpoint: endpointWithContext(request),
          authorizationHeader: `Bearer ${credential.rawToken}`,
        },
        expiresAt: Number.MAX_SAFE_INTEGER,
      };
    },
  );

  const resolve: McpSessionRegistryShape["resolve"] = Effect.fn("McpSessionRegistry.resolve")(
    function* (rawToken, context) {
      if (rawToken.length === 0) return undefined;
      const tokenHash = yield* hashToken(rawToken);
      const { credential, issuedContexts } = yield* SynchronizedRef.get(state);
      if (!credential || credential.tokenHash !== tokenHash) return undefined;
      if (!issuedContexts.has(mcpContextKey(context))) return undefined;
      const capabilities = yield* resolveT3McpCapabilities(serverSettings).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Failed to resolve T3 MCP tool capabilities.", {
            error: error.message,
          }).pipe(Effect.as(new Set<McpInvocationContext.McpCapability>())),
        ),
      );
      return {
        environmentId,
        threadId: context.threadId,
        providerSessionId: "global",
        providerInstanceId: context.providerInstanceId,
        capabilities,
        issuedAt: credential.issuedAt,
        expiresAt: Number.MAX_SAFE_INTEGER,
      } satisfies McpInvocationContext.McpInvocationScope;
    },
  );

  return McpSessionRegistry.of({
    issue,
    resolve,
    revokeProviderSession: () => Effect.void,
    revokeThread: (threadId) =>
      SynchronizedRef.update(state, (current) => ({
        ...current,
        issuedContexts: new Set(
          Array.from(current.issuedContexts).filter((key) => !key.startsWith(`${threadId}\u0000`)),
        ),
      })),
    revokeAll: SynchronizedRef.set(state, { credential: null, issuedContexts: new Set<string>() }),
  });
});

let activeMcpSessionRegistry: McpSessionRegistryShape | undefined;

const make = Effect.acquireRelease(
  makeWithOptions().pipe(
    Effect.tap((registry) =>
      Effect.sync(() => {
        activeMcpSessionRegistry = registry;
      }),
    ),
  ),
  (registry) =>
    Effect.sync(() => {
      if (activeMcpSessionRegistry === registry) {
        activeMcpSessionRegistry = undefined;
      }
    }),
);

export const layer = Layer.effect(McpSessionRegistry, make);

export const issueActiveMcpCredential = (
  request: McpCredentialRequest,
): Effect.Effect<McpIssuedCredential | undefined> =>
  activeMcpSessionRegistry
    ? activeMcpSessionRegistry.issue(request)
    : Effect.sync((): McpIssuedCredential | undefined => undefined);

export const revokeActiveMcpThread = (threadId: ThreadId): Effect.Effect<void> =>
  activeMcpSessionRegistry ? activeMcpSessionRegistry.revokeThread(threadId) : Effect.void;

export const revokeAllActiveMcpCredentials = (): Effect.Effect<void> =>
  activeMcpSessionRegistry ? activeMcpSessionRegistry.revokeAll : Effect.void;

/** Exposed for tests. */
export const __testing = {
  make: makeWithOptions,
};
