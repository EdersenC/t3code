import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ServerConfig, ServerProvider } from "./server.ts";

const decodeServerProvider = Schema.decodeUnknownSync(ServerProvider);
const decodeServerConfig = Schema.decodeUnknownSync(ServerConfig);

describe("ServerProvider", () => {
  it("defaults capability arrays when decoding provider snapshots", () => {
    const parsed = decodeServerProvider({
      instanceId: "codex",
      driver: "codex",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
    });

    expect(parsed.slashCommands).toEqual([]);
    expect(parsed.skills).toEqual([]);
    expect(parsed.versionAdvisory).toBeUndefined();
    expect(parsed.updateState).toBeUndefined();
  });

  it("defaults one-click update support when decoding older advisory snapshots", () => {
    const parsed = decodeServerProvider({
      instanceId: "codex",
      driver: "codex",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
      versionAdvisory: {
        status: "behind_latest",
        currentVersion: "1.0.0",
        latestVersion: "1.0.1",
        updateCommand: "npm install -g @openai/codex@latest",
        checkedAt: "2026-04-10T00:00:00.000Z",
        message: "Update available.",
      },
    });

    expect(parsed.versionAdvisory?.canUpdate).toBe(false);
  });

  it("decodes continuation group metadata", () => {
    const parsed = decodeServerProvider({
      instanceId: "codex_personal",
      driver: "codex",
      continuation: { groupKey: "codex:home:/Users/julius/.codex" },
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
    });

    expect(parsed.continuation?.groupKey).toBe("codex:home:/Users/julius/.codex");
  });

  it("decodes optional model runtime source metadata", () => {
    const parsed = decodeServerProvider({
      instanceId: "ollama",
      driver: "ollama",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [
        {
          slug: "ollama/gpt-oss-120b-cloud",
          name: "gpt-oss-120b",
          subProvider: "Cloud",
          runtimeSource: "cloud",
          isCustom: false,
          capabilities: null,
        },
      ],
    });

    expect(parsed.models[0]?.runtimeSource).toBe("cloud");
  });

  it("decodes optional model disabled reason", () => {
    const parsed = decodeServerProvider({
      instanceId: "ollama",
      driver: "ollama",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [
        {
          slug: "ollama/gpt-oss-120b-cloud",
          name: "gpt-oss-120b",
          subProvider: "Cloud",
          runtimeSource: "cloud",
          disabledReason: "Ollama Cloud plan does not include this model.",
          isCustom: false,
          capabilities: null,
        },
      ],
    });

    expect(parsed.models[0]?.disabledReason).toBe("Ollama Cloud plan does not include this model.");
  });
});

describe("ServerConfig capabilities", () => {
  it("defaults capability snapshot for legacy config payloads", () => {
    const parsed = decodeServerConfig({
      environment: {
        environmentId: "environment-1",
        label: "Local",
        platform: { os: "linux", arch: "x64" },
        serverVersion: "0.0.0-test",
        capabilities: { repositoryIdentity: true },
      },
      auth: {
        policy: "loopback-browser",
        bootstrapMethods: ["one-time-token"],
        sessionMethods: ["browser-session-cookie"],
        sessionCookieName: "t3_session",
      },
      cwd: "/tmp/repo",
      keybindingsConfigPath: "/tmp/repo/keybindings.json",
      keybindings: [],
      issues: [],
      providers: [],
      availableEditors: [],
      observability: {
        logsDirectoryPath: "/tmp/logs",
        localTracingEnabled: false,
        otlpTracesEnabled: false,
        otlpMetricsEnabled: false,
      },
      settings: {},
    });

    expect(parsed.capabilities).toEqual({ capabilities: [] });
  });
});
