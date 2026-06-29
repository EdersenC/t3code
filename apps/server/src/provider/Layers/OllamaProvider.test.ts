import * as NodeAssert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { beforeEach } from "vite-plus/test";

import { OllamaSettings } from "@t3tools/contracts";
import { ServerConfig } from "../../config.ts";
import {
  OpenCodeRuntime,
  OpenCodeRuntimeError,
  type OpenCodeInventory,
  type OpenCodeRuntimeShape,
} from "../opencodeRuntime.ts";
import { checkOllamaProviderStatus, resolveOllamaOpenCodeEnvironment } from "./OllamaProvider.ts";

const decodeOllamaSettings = Schema.decodeSync(OllamaSettings);
const DEFAULT_VERSION_STDOUT = "opencode 1.14.19\n";
const decodeJson = Schema.decodeUnknownSync(Schema.UnknownFromJsonString);

type OllamaOpenCodeConfig = {
  readonly model: string;
  readonly provider: {
    readonly ollama: {
      readonly npm: string;
      readonly options: { readonly baseURL: string };
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

it("adds the official OpenCode install dir to PATH for the default command", () => {
  const environment = resolveOllamaOpenCodeEnvironment(
    "opencode",
    { HOME: "/home/test", PATH: "/usr/bin" },
    "linux",
  );

  NodeAssert.equal(environment.PATH, "/home/test/.opencode/bin:/usr/bin");
});

it("does not patch PATH for explicit OpenCode binary paths", () => {
  const input = { HOME: "/home/test", PATH: "/usr/bin" };
  const environment = resolveOllamaOpenCodeEnvironment(
    "/opt/opencode/bin/opencode",
    input,
    "linux",
  );

  NodeAssert.equal(environment, input);
});

const makeOllamaSettings = (overrides?: Partial<OllamaSettings>): OllamaSettings =>
  decodeOllamaSettings({
    enabled: true,
    baseUrl: "http://127.0.0.1:11434",
    binaryPath: "opencode",
    customModels: ["ollama/llama3.2:3b"],
    ...overrides,
  });

function makeOllamaFetch(
  models: ReadonlyArray<string>,
  runningModels: ReadonlyArray<Record<string, unknown>> = [],
): typeof fetch {
  const fetchFn = async (input: Parameters<typeof fetch>[0]) => {
    const rawUrl =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(rawUrl);
    if (url.pathname === "/api/version") {
      return new Response(JSON.stringify({ version: "0.13.0" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.pathname === "/api/tags") {
      return new Response(
        JSON.stringify({
          models: models.map((name) => ({ name })),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.pathname === "/api/ps") {
      return new Response(JSON.stringify({ models: runningModels }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  };
  return fetchFn as typeof fetch;
}

function makeOllamaFetchWithCloudProbe(input: {
  readonly models: ReadonlyArray<string>;
  readonly runningModels?: ReadonlyArray<Record<string, unknown>>;
  readonly cloudProbeStatusByModel?: Partial<Record<string, number>>;
}): {
  readonly fetchFn: typeof fetch;
  readonly probeCallCount: () => number;
} {
  const { models, runningModels = [], cloudProbeStatusByModel = {} } = input;
  let probeCalls = 0;

  const fetchFn = async (
    requestInput: Parameters<typeof fetch>[0],
    init: Parameters<typeof fetch>[1],
  ) => {
    const rawUrl =
      typeof requestInput === "string"
        ? requestInput
        : requestInput instanceof URL
          ? requestInput.href
          : requestInput.url;
    const url = new URL(rawUrl);
    if (url.pathname === "/api/version") {
      return new Response(JSON.stringify({ version: "0.13.0" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.pathname === "/api/tags") {
      return new Response(
        JSON.stringify({
          models: models.map((name) => ({ name })),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.pathname === "/api/ps") {
      return new Response(JSON.stringify({ models: runningModels }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.pathname === "/v1/chat/completions") {
      probeCalls++;
      const body = typeof init?.body === "string" ? init.body : "";
      let model = "";
      try {
        const payload = JSON.parse(body);
        if (typeof payload?.model === "string") {
          model = payload.model;
        }
      } catch {
        // Ignore malformed probe request payloads.
      }

      const status = cloudProbeStatusByModel[model] ?? 200;
      const responseBody =
        status === 200
          ? JSON.stringify({ object: "chat.completion" })
          : JSON.stringify({ error: "not available" });
      return new Response(responseBody, {
        status,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  };

  return {
    fetchFn: fetchFn as typeof fetch,
    probeCallCount: () => probeCalls,
  };
}

it.layer(testLayer)("checkOllamaProviderStatus", (it) => {
  it.effect("generates an OpenCode Ollama config and exposes local models", () =>
    Effect.gen(function* () {
      runtimeMock.state.inventory = {
        providerList: {
          connected: ["ollama"],
          all: [
            {
              id: "ollama",
              name: "Ollama (local)",
              models: {
                "qwen2.5-coder:7b": {
                  id: "qwen2.5-coder:7b",
                  name: "Qwen2.5 Coder 7B",
                  variants: {},
                },
              },
            },
          ],
          default: {},
        },
        agents: [{ name: "build", hidden: false, mode: "primary" }],
      };

      const snapshot = yield* checkOllamaProviderStatus(
        makeOllamaSettings({ baseUrl: "http://127.0.0.1:11434/v1" }),
        process.cwd(),
        process.env,
        { fetchFn: makeOllamaFetch(["qwen2.5-coder:7b"]) },
      );

      NodeAssert.equal(snapshot.status, "ready");
      NodeAssert.equal(snapshot.auth.label, "http://127.0.0.1:11434");
      NodeAssert.ok(snapshot.models.some((model) => model.slug === "ollama/qwen2.5-coder:7b"));
      NodeAssert.equal(runtimeMock.state.closeCalls, 1);
      NodeAssert.equal(runtimeMock.state.configContents.length, 1);

      const config = decodeJson(runtimeMock.state.configContents[0]!) as OllamaOpenCodeConfig;
      NodeAssert.equal(config.model, "ollama/qwen2.5-coder:7b");
      NodeAssert.equal(config.provider.ollama.npm, "@ai-sdk/openai-compatible");
      NodeAssert.equal(config.provider.ollama.options.baseURL, "http://127.0.0.1:11434/v1");
      NodeAssert.deepEqual(Object.keys(config.provider.ollama.models), [
        "qwen2.5-coder:7b",
        "llama3.2:3b",
      ]);
    }),
  );

  it.effect("labels configured Ollama Cloud models without exposing the cloud suffix", () =>
    Effect.gen(function* () {
      runtimeMock.state.inventory = {
        providerList: {
          connected: ["ollama"],
          all: [
            {
              id: "ollama",
              name: "Ollama (local)",
              models: {
                "gpt-oss-120b-cloud": {
                  id: "gpt-oss-120b-cloud",
                  name: "gpt-oss-120b-cloud",
                  variants: {},
                },
              },
            },
          ],
          default: {},
        },
        agents: [],
      };

      const snapshot = yield* checkOllamaProviderStatus(
        makeOllamaSettings({ customModels: ["ollama/gpt-oss-120b-cloud"] }),
        process.cwd(),
        process.env,
        { fetchFn: makeOllamaFetch([]) },
      );

      const cloudModel = snapshot.models.find(
        (model) => model.slug === "ollama/gpt-oss-120b-cloud",
      );
      NodeAssert.equal(snapshot.status, "ready");
      NodeAssert.equal(cloudModel?.name, "gpt-oss-120b");
      NodeAssert.equal(cloudModel?.subProvider, "Cloud");
      NodeAssert.equal(cloudModel?.runtimeSource, "cloud");
      NodeAssert.match(snapshot.message ?? "", /cloud model/);

      const config = decodeJson(runtimeMock.state.configContents[0]!) as OllamaOpenCodeConfig;
      NodeAssert.ok(Object.hasOwn(config.provider.ollama.models, "gpt-oss-120b-cloud"));
    }),
  );

  it.effect("marks unavailable Ollama Cloud models when chat probe rejects them", () =>
    Effect.gen(function* () {
      runtimeMock.state.inventory = {
        providerList: {
          connected: ["ollama"],
          all: [
            {
              id: "ollama",
              name: "Ollama (local)",
              models: {
                "gpt-oss-120b-cloud": {
                  id: "gpt-oss-120b-cloud",
                  name: "gpt-oss-120b-cloud",
                  variants: {},
                },
              },
            },
          ],
          default: {},
        },
        agents: [],
      };

      const { fetchFn } = makeOllamaFetchWithCloudProbe({
        models: [],
        cloudProbeStatusByModel: {
          "gpt-oss-120b-cloud": 403,
        },
      });

      const snapshot = yield* checkOllamaProviderStatus(
        makeOllamaSettings({
          baseUrl: "http://127.0.0.1:11436",
          customModels: ["ollama/gpt-oss-120b-cloud"],
        }),
        process.cwd(),
        process.env,
        { fetchFn },
      );

      const cloudModel = snapshot.models.find(
        (model) => model.slug === "ollama/gpt-oss-120b-cloud",
      );
      NodeAssert.equal(snapshot.status, "ready");
      NodeAssert.equal(
        cloudModel?.disabledReason,
        "access denied by Ollama Cloud plan or authentication.",
      );
    }),
  );

  it.effect("probes only a bounded number of unavailable cloud models per refresh", () =>
    Effect.gen(function* () {
      runtimeMock.state.inventory = {
        providerList: {
          connected: ["ollama"],
          all: [
            {
              id: "ollama",
              name: "Ollama (local)",
              models: {
                "gpt-oss-120b-cloud": {
                  id: "gpt-oss-120b-cloud",
                  name: "gpt-oss-120b-cloud",
                  variants: {},
                },
                "gpt-oss-70b-cloud": {
                  id: "gpt-oss-70b-cloud",
                  name: "gpt-oss-70b-cloud",
                  variants: {},
                },
                "gpt-oss-30b-cloud": {
                  id: "gpt-oss-30b-cloud",
                  name: "gpt-oss-30b-cloud",
                  variants: {},
                },
                "gpt-oss-20b-cloud": {
                  id: "gpt-oss-20b-cloud",
                  name: "gpt-oss-20b-cloud",
                  variants: {},
                },
                "gpt-oss-14b-cloud": {
                  id: "gpt-oss-14b-cloud",
                  name: "gpt-oss-14b-cloud",
                  variants: {},
                },
                "gpt-oss-8b-cloud": {
                  id: "gpt-oss-8b-cloud",
                  name: "gpt-oss-8b-cloud",
                  variants: {},
                },
              },
            },
          ],
        },
        default: {},
        agents: [],
      };

      const probe = makeOllamaFetchWithCloudProbe({
        models: [],
        cloudProbeStatusByModel: {
          "gpt-oss-120b-cloud": 403,
          "gpt-oss-70b-cloud": 403,
          "gpt-oss-30b-cloud": 403,
          "gpt-oss-20b-cloud": 403,
          "gpt-oss-14b-cloud": 403,
          "gpt-oss-8b-cloud": 403,
        },
      });

      const snapshot = yield* checkOllamaProviderStatus(
        makeOllamaSettings({
          baseUrl: "http://127.0.0.1:11435",
          customModels: [
            "ollama/gpt-oss-120b-cloud",
            "ollama/gpt-oss-70b-cloud",
            "ollama/gpt-oss-30b-cloud",
            "ollama/gpt-oss-20b-cloud",
            "ollama/gpt-oss-14b-cloud",
            "ollama/gpt-oss-8b-cloud",
          ],
        }),
        process.cwd(),
        process.env,
        { fetchFn: probe.fetchFn },
      );

      NodeAssert.equal(snapshot.status, "ready");
      NodeAssert.ok(probe.probeCallCount() <= 4);
      NodeAssert.equal(snapshot.models.filter((model) => model.disabledReason).length, 4);
    }),
  );

  it.effect("requires explicit CPU fallback when a loaded model has no VRAM residency", () =>
    Effect.gen(function* () {
      runtimeMock.state.inventory = {
        providerList: {
          connected: ["ollama"],
          all: [
            {
              id: "ollama",
              name: "Ollama (local)",
              models: {
                "qwen3:1.7b": { id: "qwen3:1.7b", name: "qwen3:1.7b", variants: {} },
              },
            },
          ],
          default: {},
        },
        agents: [],
      };

      const snapshot = yield* checkOllamaProviderStatus(
        makeOllamaSettings({ customModels: ["ollama/qwen3:1.7b"] }),
        process.cwd(),
        process.env,
        {
          fetchFn: makeOllamaFetch(
            ["qwen3:1.7b"],
            [{ name: "qwen3:1.7b", model: "qwen3:1.7b", size: 1000, size_vram: 0 }],
          ),
        },
      );

      NodeAssert.equal(snapshot.status, "error");
      NodeAssert.match(snapshot.message ?? "", /CPU instead of GPU/);
      NodeAssert.match(snapshot.message ?? "", /accept CPU fallback/);
    }),
  );

  it.effect("ignores CPU-only residency for unrelated running models", () =>
    Effect.gen(function* () {
      runtimeMock.state.inventory = {
        providerList: {
          connected: ["ollama"],
          all: [
            {
              id: "ollama",
              name: "Ollama (local)",
              models: {
                "qwen3:1.7b": { id: "qwen3:1.7b", name: "qwen3:1.7b", variants: {} },
              },
            },
          ],
          default: {},
        },
        agents: [],
      };

      const snapshot = yield* checkOllamaProviderStatus(
        makeOllamaSettings({ customModels: ["ollama/qwen3:1.7b"] }),
        process.cwd(),
        process.env,
        {
          fetchFn: makeOllamaFetch(
            ["qwen3:1.7b"],
            [{ name: "other:latest", model: "other:latest", size: 1000, size_vram: 0 }],
          ),
        },
      );

      NodeAssert.equal(snapshot.status, "ready");
    }),
  );

  it.effect("errors when OpenCode does not expose the generated Ollama provider", () =>
    Effect.gen(function* () {
      runtimeMock.state.inventory = {
        providerList: { connected: [], all: [], default: {} },
        agents: [],
      };

      const snapshot = yield* checkOllamaProviderStatus(
        makeOllamaSettings(),
        process.cwd(),
        process.env,
        { fetchFn: makeOllamaFetch(["llama3.2:3b"]) },
      );

      NodeAssert.equal(snapshot.status, "error");
      NodeAssert.match(snapshot.message ?? "", /did not expose any generated Ollama models/);
    }),
  );

  it.effect("reports OpenCode as the missing piece when Ollama is reachable", () =>
    Effect.gen(function* () {
      runtimeMock.state.runVersionError = new Error("spawn opencode ENOENT");

      const snapshot = yield* checkOllamaProviderStatus(
        makeOllamaSettings(),
        process.cwd(),
        process.env,
        { fetchFn: makeOllamaFetch(["llama3.2:3b"]) },
      );

      NodeAssert.equal(snapshot.status, "error");
      NodeAssert.equal(snapshot.installed, false);
      NodeAssert.equal(
        snapshot.message,
        "Ollama is running, but OpenCode CLI (opencode) is not installed or not on PATH.",
      );
    }),
  );
});
