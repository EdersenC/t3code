import { assert, it, vi } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionStartInput,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderTurnStartResult,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { makeProviderServiceLive } from "./ProviderService.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "./ProviderEventLoggers.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { ProviderAdapterRegistry } from "../Services/ProviderAdapterRegistry.ts";
import { ProviderService } from "../Services/ProviderService.ts";
import {
  ProviderSessionDirectory,
  type ProviderRuntimeBinding,
  type ProviderRuntimeBindingWithMetadata,
} from "../Services/ProviderSessionDirectory.ts";
import { makeAdapterRegistryMock } from "../testUtils/providerAdapterRegistryMock.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { AnalyticsService } from "../../telemetry/Services/AnalyticsService.ts";

const CODEX_DRIVER = ProviderDriverKind.make("codex");
const codexInstanceId = ProviderInstanceId.make("codex");
const asThreadId = (value: string): ThreadId => ThreadId.make(value);

function makeProviderSnapshot(input?: Partial<ServerProvider>): ServerProvider {
  return {
    instanceId: codexInstanceId,
    driver: CODEX_DRIVER,
    displayName: "Codex",
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [],
    skills: [],
    slashCommands: [],
    ...input,
  };
}

function makeFakeAdapter() {
  const sessions = new Map<ThreadId, ProviderSession>();

  const startSession = vi.fn((input: ProviderSessionStartInput) =>
    Effect.sync(() => {
      const session: ProviderSession = {
        provider: CODEX_DRIVER,
        providerInstanceId: input.providerInstanceId,
        status: "ready",
        runtimeMode: input.runtimeMode,
        threadId: input.threadId,
        resumeCursor: input.resumeCursor ?? { opaque: `resume-${input.threadId}` },
        cwd: input.cwd ?? "/tmp/project",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
      sessions.set(input.threadId, session);
      return session;
    }),
  );

  const sendTurn = vi.fn((input: ProviderSendTurnInput) =>
    Effect.succeed({
      threadId: input.threadId,
      turnId: TurnId.make(`turn-${String(input.threadId)}`),
      resumeCursor: { opaque: `resume-${input.threadId}` },
    } satisfies ProviderTurnStartResult),
  );

  const adapter: ProviderAdapterShape<never> = {
    provider: CODEX_DRIVER,
    capabilities: { sessionModelSwitch: "unsupported" },
    startSession,
    sendTurn,
    interruptTurn: () => Effect.void,
    respondToRequest: () => Effect.void,
    respondToUserInput: () => Effect.void,
    stopSession: (threadId) =>
      Effect.sync(() => {
        sessions.delete(threadId);
      }),
    listSessions: () => Effect.succeed(Array.from(sessions.values())),
    hasSession: (threadId) => Effect.succeed(sessions.has(threadId)),
    readThread: (threadId) => Effect.succeed({ threadId, turns: [] }),
    rollbackThread: (threadId) => Effect.succeed({ threadId, turns: [] }),
    stopAll: () =>
      Effect.sync(() => {
        sessions.clear();
      }),
    streamEvents: Stream.empty as Stream.Stream<ProviderRuntimeEvent>,
  };

  return { adapter, sendTurn, startSession };
}

function makeInMemoryDirectory() {
  const bindings = new Map<ThreadId, ProviderRuntimeBindingWithMetadata>();
  const now = "2026-01-01T00:00:00.000Z";

  return {
    upsert: (binding: ProviderRuntimeBinding) =>
      Effect.sync(() => {
        bindings.set(binding.threadId, { ...binding, lastSeenAt: now });
      }),
    getProvider: (threadId: ThreadId) =>
      Effect.sync(() => {
        const binding = bindings.get(threadId);
        if (!binding) {
          return CODEX_DRIVER;
        }
        return binding.provider;
      }),
    getBinding: (threadId: ThreadId) =>
      Effect.succeed(bindings.has(threadId) ? Option.some(bindings.get(threadId)!) : Option.none()),
    listThreadIds: () => Effect.succeed(Array.from(bindings.keys())),
    listBindings: () => Effect.succeed(Array.from(bindings.values())),
  } satisfies ProviderSessionDirectory["Service"];
}

it.effect("ProviderService expands repo skill prompts before adapter dispatch", () => {
  const adapter = makeFakeAdapter();
  const providerLayer = makeProviderServiceLive({
    repoSkillCatalog: {
      rootPath: "/repo/skills",
      diagnostics: [],
      skills: [
        {
          name: "code-review",
          directoryPath: "/repo/skills/code-review",
          skillPath: "/repo/skills/code-review/SKILL.md",
          enabled: true,
          description: "Review code changes for bugs and regressions.",
          instructions: "Prioritize defects, regressions, and missing tests.",
          slashCommand: { name: "review", description: "Review code changes" },
        },
      ],
    },
  }).pipe(
    Layer.provide(
      Layer.succeed(
        ProviderAdapterRegistry,
        makeAdapterRegistryMock({ [CODEX_DRIVER]: adapter.adapter }),
      ),
    ),
    Layer.provide(Layer.succeed(ProviderSessionDirectory, makeInMemoryDirectory())),
    Layer.provide(ServerSettings.ServerSettingsService.layerTest()),
    Layer.provide(AnalyticsService.layerTest),
    Layer.provide(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
  );

  return Effect.gen(function* () {
    const provider = yield* ProviderService;
    const threadId = asThreadId("repo-skill-thread");
    yield* provider.startSession(threadId, {
      provider: CODEX_DRIVER,
      providerInstanceId: codexInstanceId,
      threadId,
      cwd: "/tmp/project",
      runtimeMode: "full-access",
    });

    yield* provider.sendTurn({
      threadId,
      input: "/review focus tests",
      attachments: [],
    });

    const sentInput = adapter.sendTurn.mock.calls[0]?.[0]?.input;
    assert.equal(typeof sentInput, "string");
    assert.match(sentInput ?? "", /<t3_repo_skill name="code-review" trigger="\/review">/);
    assert.match(sentInput ?? "", /Prioritize defects, regressions, and missing tests\./);
    assert.match(sentInput ?? "", /User prompt:\nfocus tests/);
  }).pipe(Effect.provide(providerLayer));
});

it.effect(
  "ProviderService leaves repo commands untouched when hidden by provider-native collisions",
  () => {
    const adapter = makeFakeAdapter();
    const providerLayer = makeProviderServiceLive({
      repoSkillCatalog: {
        rootPath: "/repo/skills",
        diagnostics: [],
        skills: [
          {
            name: "code-review",
            directoryPath: "/repo/skills/code-review",
            skillPath: "/repo/skills/code-review/SKILL.md",
            enabled: true,
            description: "Review code changes for bugs and regressions.",
            instructions: "Prioritize defects, regressions, and missing tests.",
            slashCommand: { name: "review", scope: "repo", description: "Review code changes" },
          },
        ],
      },
      repoSkillProviderSnapshots: Effect.succeed([
        makeProviderSnapshot({ slashCommands: [{ name: "review", description: "Native review" }] }),
      ]),
    }).pipe(
      Layer.provide(
        Layer.succeed(
          ProviderAdapterRegistry,
          makeAdapterRegistryMock({ [CODEX_DRIVER]: adapter.adapter }),
        ),
      ),
      Layer.provide(Layer.succeed(ProviderSessionDirectory, makeInMemoryDirectory())),
      Layer.provide(ServerSettings.ServerSettingsService.layerTest()),
      Layer.provide(AnalyticsService.layerTest),
      Layer.provide(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
    );

    return Effect.gen(function* () {
      const provider = yield* ProviderService;
      const threadId = asThreadId("repo-skill-native-collision");
      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });

      yield* provider.sendTurn({
        threadId,
        input: "/review focus tests",
        attachments: [],
      });

      assert.equal(adapter.sendTurn.mock.calls[0]?.[0]?.input, "/review focus tests");
    }).pipe(Effect.provide(providerLayer));
  },
);

it.effect(
  "ProviderService rejects expanded repo skill prompts that exceed send-turn limits",
  () => {
    const adapter = makeFakeAdapter();
    const providerLayer = makeProviderServiceLive({
      repoSkillCatalog: {
        rootPath: "/repo/skills",
        diagnostics: [],
        skills: [
          {
            name: "code-review",
            directoryPath: "/repo/skills/code-review",
            skillPath: "/repo/skills/code-review/SKILL.md",
            enabled: true,
            description: "Review code changes for bugs and regressions.",
            instructions: "x".repeat(121_000),
            slashCommand: { name: "review", scope: "repo", description: "Review code changes" },
          },
        ],
      },
    }).pipe(
      Layer.provide(
        Layer.succeed(
          ProviderAdapterRegistry,
          makeAdapterRegistryMock({ [CODEX_DRIVER]: adapter.adapter }),
        ),
      ),
      Layer.provide(Layer.succeed(ProviderSessionDirectory, makeInMemoryDirectory())),
      Layer.provide(ServerSettings.ServerSettingsService.layerTest()),
      Layer.provide(AnalyticsService.layerTest),
      Layer.provide(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
    );

    return Effect.gen(function* () {
      const provider = yield* ProviderService;
      const threadId = asThreadId("repo-skill-too-large");
      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });

      yield* provider
        .sendTurn({
          threadId,
          input: "/review focus tests",
          attachments: [],
        })
        .pipe(Effect.flip);

      assert.equal(adapter.sendTurn.mock.calls.length, 0);
    }).pipe(Effect.provide(providerLayer));
  },
);
