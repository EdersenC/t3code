import * as NodeAssert from "node:assert/strict";

import { it } from "@effect/vitest";
import {
  DEFAULT_LOCAL_CONTEXT_WINDOW,
  DEFAULT_LOCAL_OUTPUT_TOKEN_LIMIT,
  LocalSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { beforeEach } from "vite-plus/test";

import {
  OpenCodeRuntime,
  OpenCodeRuntimeError,
  type OpenCodeInventory,
  type OpenCodeRuntimeShape,
} from "../opencodeRuntime.ts";
import { checkLocalProviderStatus, resolveLocalOpenCodeEnvironment } from "./LocalProvider.ts";

const decodeLocalSettings = Schema.decodeSync(LocalSettings);
const decodeJson = Schema.decodeUnknownSync(Schema.UnknownFromJsonString);
const DEFAULT_VERSION_STDOUT = "opencode 1.14.19\n";

type LocalOpenCodeConfig = {
  readonly model: string;
  readonly provider: {
    readonly "local-vllm": {
      readonly npm: string;
      readonly options: { readonly baseURL: string };
      readonly models: Record<
        string,
        {
          readonly name: string;
          readonly limit?: {
            readonly context?: number;
            readonly output?: number;
          };
        }
      >;
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

const httpMock = {
  state: {
    status: 200,
    body: { data: [{ id: "Qwen/Qwen3-8B-AWQ" }] } as unknown,
    requestedUrls: [] as string[],
  },
  reset() {
    this.state.status = 200;
    this.state.body = { data: [{ id: "Qwen/Qwen3-8B-AWQ" }] };
    this.state.requestedUrls.length = 0;
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

const TestHttpClientLive = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request: HttpClientRequest.HttpClientRequest) => {
    httpMock.state.requestedUrls.push(request.url);
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        Response.json(httpMock.state.body, { status: httpMock.state.status }),
      ),
    );
  }),
);

const testLayer = Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble).pipe(
  Layer.provideMerge(TestHttpClientLive),
);

beforeEach(() => {
  runtimeMock.reset();
  httpMock.reset();
});

it("adds the official OpenCode install dir to PATH for the default command", () => {
  const environment = resolveLocalOpenCodeEnvironment(
    "opencode",
    { HOME: "/home/test", PATH: "/usr/bin" },
    "linux",
  );

  NodeAssert.equal(environment.PATH, "/home/test/.opencode/bin:/usr/bin");
});

it("does not patch PATH for explicit OpenCode binary paths", () => {
  const input = { HOME: "/home/test", PATH: "/usr/bin" };
  const environment = resolveLocalOpenCodeEnvironment("/opt/opencode/bin/opencode", input, "linux");

  NodeAssert.equal(environment, input);
});

const makeLocalSettings = (overrides?: Partial<LocalSettings>): LocalSettings =>
  decodeLocalSettings({
    enabled: true,
    baseUrl: "http://127.0.0.1:8018",
    binaryPath: "opencode",
    customModels: ["local-vllm/Qwen/Qwen3-8B-AWQ"],
    ...overrides,
  });

it.layer(testLayer)("checkLocalProviderStatus", (it) => {
  it.effect("generates an OpenCode Local vLLM config and exposes served models", () =>
    Effect.gen(function* () {
      runtimeMock.state.inventory = {
        providerList: {
          connected: ["local-vllm"],
          all: [
            {
              id: "local-vllm",
              name: "Local vLLM",
              models: {
                "Qwen/Qwen3-8B-AWQ": {
                  id: "Qwen/Qwen3-8B-AWQ",
                  name: "Qwen/Qwen3-8B-AWQ",
                  variants: {},
                },
              },
            },
          ],
          default: {},
        },
        agents: [{ name: "build", hidden: false, mode: "primary" }],
      };

      const snapshot = yield* checkLocalProviderStatus(
        makeLocalSettings({ baseUrl: "localhost:8018/v1?debug=1" }),
        process.cwd(),
        process.env,
      );

      NodeAssert.equal(snapshot.status, "ready");
      NodeAssert.equal(snapshot.auth.label, "http://localhost:8018");
      NodeAssert.deepEqual(httpMock.state.requestedUrls, ["http://localhost:8018/v1/models"]);
      NodeAssert.ok(snapshot.models.some((model) => model.slug === "local-vllm/Qwen/Qwen3-8B-AWQ"));
      NodeAssert.equal(runtimeMock.state.closeCalls, 1);
      NodeAssert.equal(runtimeMock.state.configContents.length, 1);

      const config = decodeJson(runtimeMock.state.configContents[0]!) as LocalOpenCodeConfig;
      NodeAssert.equal(config.model, "local-vllm/Qwen/Qwen3-8B-AWQ");
      NodeAssert.equal(config.provider["local-vllm"].npm, "@ai-sdk/openai-compatible");
      NodeAssert.equal(config.provider["local-vllm"].options.baseURL, "http://localhost:8018/v1");
      NodeAssert.deepEqual(Object.keys(config.provider["local-vllm"].models), [
        "Qwen/Qwen3-8B-AWQ",
      ]);
      NodeAssert.deepEqual(config.provider["local-vllm"].models["Qwen/Qwen3-8B-AWQ"]?.limit, {
        context: DEFAULT_LOCAL_CONTEXT_WINDOW,
        output: DEFAULT_LOCAL_OUTPUT_TOKEN_LIMIT,
      });
    }),
  );

  it.effect("reports vLLM endpoint failures before checking OpenCode", () =>
    Effect.gen(function* () {
      httpMock.state.status = 503;
      httpMock.state.body = { error: "loading model" };

      const snapshot = yield* checkLocalProviderStatus(
        makeLocalSettings({ baseUrl: "http://127.0.0.1:8018" }),
        process.cwd(),
        process.env,
      );

      NodeAssert.equal(snapshot.status, "error");
      NodeAssert.equal(snapshot.installed, false);
      NodeAssert.match(snapshot.message ?? "", /Couldn't reach the local vLLM server/);
      NodeAssert.equal(runtimeMock.state.configContents.length, 0);
    }),
  );
});
