import * as NodeAssert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { beforeEach } from "vite-plus/test";

import { GroqSettings } from "@t3tools/contracts";
import { ServerConfig } from "../../config.ts";
import {
  OpenCodeRuntime,
  OpenCodeRuntimeError,
  type OpenCodeInventory,
  type OpenCodeRuntimeShape,
} from "../opencodeRuntime.ts";
import { checkGroqProviderStatus } from "./GroqCloudProvider.ts";

const decodeGroqSettings = Schema.decodeSync(GroqSettings);
const DEFAULT_VERSION_STDOUT = "opencode 1.14.19\n";
const decodeJson = Schema.decodeUnknownSync(Schema.UnknownFromJsonString);

type GroqOpenCodeConfig = {
  readonly model: string;
  readonly provider: {
    readonly groq: {
      readonly npm: string;
      readonly options: { readonly baseURL: string; readonly apiKey?: string };
      readonly models: Record<string, unknown>;
    };
  };
};

const runtimeMock = {
  state: {
    runVersionError: null as Error | null,
    versionStdout: DEFAULT_VERSION_STDOUT,
    inventoryError: null as Error | null,
    closeCalls: 0,
    configContents: [] as string[],
    inventory: {
      providerList: { connected: [] as string[], all: [] as unknown[], default: {} },
      agents: [] as unknown[],
    } as unknown,
  },
  reset() {
    this.state.runVersionError = null;
    this.state.versionStdout = DEFAULT_VERSION_STDOUT;
    this.state.inventoryError = null;
    this.state.closeCalls = 0;
    this.state.configContents.length = 0;
    this.state.inventory = {
      providerList: { connected: [], all: [] as unknown[], default: {} },
      agents: [] as unknown[],
    };
  },
};

const OpenCodeRuntimeTestDouble: OpenCodeRuntimeShape = {
  startOpenCodeServerProcess: () =>
    Effect.succeed({
      url: "http://127.0.0.1:4301",
      exitCode: Effect.never,
    }),
  connectToOpenCodeServer: ({ configContent }) =>
    Effect.gen(function* () {
      if (configContent !== undefined) runtimeMock.state.configContents.push(configContent);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          runtimeMock.state.closeCalls += 1;
        }),
      );
      return {
        url: "http://127.0.0.1:4301",
        exitCode: null,
        external: false,
      };
    }),
  runOpenCodeCommand: () =>
    runtimeMock.state.runVersionError
      ? Effect.fail(
          new OpenCodeRuntimeError({
            operation: "runOpenCodeCommand",
            detail: runtimeMock.state.runVersionError.message,
            cause: runtimeMock.state.runVersionError,
          }),
        )
      : Effect.succeed({ stdout: runtimeMock.state.versionStdout, stderr: "", code: 0 }),
  createOpenCodeSdkClient: () =>
    ({}) as unknown as ReturnType<OpenCodeRuntimeShape["createOpenCodeSdkClient"]>,
  loadOpenCodeInventory: () =>
    runtimeMock.state.inventoryError
      ? Effect.fail(
          new OpenCodeRuntimeError({
            operation: "loadOpenCodeInventory",
            detail: runtimeMock.state.inventoryError.message,
            cause: runtimeMock.state.inventoryError,
          }),
        )
      : Effect.succeed(runtimeMock.state.inventory as OpenCodeInventory),
};

beforeEach(() => {
  runtimeMock.reset();
});

const testLayer = Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble).pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
  Layer.provideMerge(NodeServices.layer),
);

const makeGroqSettings = (overrides?: Partial<GroqSettings>): GroqSettings =>
  decodeGroqSettings({
    enabled: true,
    apiKey: "gsk_test",
    baseUrl: "https://api.groq.com/openai/v1",
    binaryPath: "opencode",
    customModels: ["groq/openai/gpt-oss-120b"],
    ...overrides,
  });

function makeGroqFetch(models: ReadonlyArray<string>, status = 200): typeof fetch {
  const fetchFn = async (input: Parameters<typeof fetch>[0]) => {
    const rawUrl =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(rawUrl);
    if (url.pathname === "/openai/v1/models" || url.pathname === "/models") {
      return new Response(
        status === 200
          ? JSON.stringify({ data: models.map((id) => ({ id, owned_by: "Groq" })) })
          : "unauthorized",
        { status, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("not found", { status: 404 });
  };
  return fetchFn as typeof fetch;
}

function makeThrowingFetch(cause: unknown): typeof fetch {
  return (async () => {
    throw cause;
  }) as unknown as typeof fetch;
}

it.layer(testLayer)("checkGroqProviderStatus", (it) => {
  it.effect("generates an OpenCode Groq config and exposes discovered models", () =>
    Effect.gen(function* () {
      runtimeMock.state.inventory = {
        providerList: {
          connected: ["groq"],
          all: [
            {
              id: "groq",
              name: "Groq",
              models: {
                "openai/gpt-oss-120b": {
                  id: "openai/gpt-oss-120b",
                  name: "OpenAI GPT OSS 120B",
                  variants: {},
                },
              },
            },
          ],
          default: {},
        },
        agents: [{ name: "build", hidden: false, mode: "primary" }],
      };

      const snapshot = yield* checkGroqProviderStatus(
        makeGroqSettings(),
        process.cwd(),
        {},
        { fetchFn: makeGroqFetch(["openai/gpt-oss-120b"]) },
      );

      NodeAssert.equal(snapshot.status, "ready");
      NodeAssert.equal(snapshot.auth.status, "authenticated");
      NodeAssert.ok(snapshot.models.some((model) => model.slug === "groq/openai/gpt-oss-120b"));
      NodeAssert.equal(runtimeMock.state.closeCalls, 1);
      NodeAssert.equal(runtimeMock.state.configContents.length, 1);

      const config = decodeJson(runtimeMock.state.configContents[0]!) as GroqOpenCodeConfig;
      NodeAssert.equal(config.model, "groq/openai/gpt-oss-120b");
      NodeAssert.equal(config.provider.groq.npm, "@ai-sdk/groq");
      NodeAssert.equal(config.provider.groq.options.baseURL, "https://api.groq.com/openai/v1");
      NodeAssert.equal(config.provider.groq.options.apiKey, "gsk_test");
    }),
  );

  it.effect("reports missing auth before checking the OpenCode harness", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkGroqProviderStatus(
        makeGroqSettings({ apiKey: "" }),
        process.cwd(),
        {},
        { fetchFn: makeGroqFetch(["openai/gpt-oss-120b"]) },
      );

      NodeAssert.equal(snapshot.status, "warning");
      NodeAssert.equal(snapshot.auth.status, "unauthenticated");
      NodeAssert.match(snapshot.message ?? "", /Groq API key/);
      NodeAssert.equal(runtimeMock.state.configContents.length, 0);
    }),
  );

  it.effect("reports invalid Groq auth as unauthenticated discovery failure", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkGroqProviderStatus(
        makeGroqSettings(),
        process.cwd(),
        {},
        { fetchFn: makeGroqFetch([], 401) },
      );

      NodeAssert.equal(snapshot.status, "error");
      NodeAssert.equal(snapshot.auth.status, "unauthenticated");
      NodeAssert.match(snapshot.message ?? "", /rejected authentication/);
      NodeAssert.equal(runtimeMock.state.configContents.length, 0);
    }),
  );

  it.effect("reports Groq model discovery timeouts without blaming auth", () =>
    Effect.gen(function* () {
      const timeout = new Error("request timed out");
      timeout.name = "TimeoutError";
      const snapshot = yield* checkGroqProviderStatus(
        makeGroqSettings(),
        process.cwd(),
        {},
        { fetchFn: makeThrowingFetch(timeout), timeoutMs: 10 },
      );

      NodeAssert.equal(snapshot.status, "error");
      NodeAssert.equal(snapshot.auth.status, "unknown");
      NodeAssert.match(snapshot.message ?? "", /model discovery/);
      NodeAssert.match(snapshot.message ?? "", /timed out/);
      NodeAssert.equal(runtimeMock.state.configContents.length, 0);
    }),
  );

  it.effect("reports missing OpenCode after Groq auth and discovery succeed", () =>
    Effect.gen(function* () {
      runtimeMock.state.runVersionError = new Error("ENOENT opencode");

      const snapshot = yield* checkGroqProviderStatus(
        makeGroqSettings(),
        process.cwd(),
        {},
        { fetchFn: makeGroqFetch(["openai/gpt-oss-120b"]) },
      );

      NodeAssert.equal(snapshot.status, "error");
      NodeAssert.equal(snapshot.auth.status, "authenticated");
      NodeAssert.match(snapshot.message ?? "", /OpenCode CLI/);
      NodeAssert.match(snapshot.message ?? "", /not installed|not on PATH/);
      NodeAssert.equal(runtimeMock.state.configContents.length, 0);
    }),
  );

  it.effect("reports OpenCode generated-provider-config load failures", () =>
    Effect.gen(function* () {
      runtimeMock.state.inventoryError = new Error("Cannot load provider groq");

      const snapshot = yield* checkGroqProviderStatus(
        makeGroqSettings(),
        process.cwd(),
        {},
        { fetchFn: makeGroqFetch(["openai/gpt-oss-120b"]) },
      );

      NodeAssert.equal(snapshot.status, "error");
      NodeAssert.equal(snapshot.auth.status, "authenticated");
      NodeAssert.match(snapshot.message ?? "", /generated Groq provider config/);
      NodeAssert.match(snapshot.message ?? "", /Cannot load provider groq/);
      NodeAssert.equal(runtimeMock.state.configContents.length, 1);
    }),
  );
});
