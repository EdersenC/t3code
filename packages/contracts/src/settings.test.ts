import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ProviderInstanceId } from "./providerInstance.ts";
import {
  ClientSettingsPatch,
  ClientSettingsSchema,
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  ServerSettings,
  ServerSettingsPatch,
} from "./settings.ts";

const decodeClientSettings = Schema.decodeUnknownSync(ClientSettingsSchema);
const decodeClientSettingsPatch = Schema.decodeUnknownSync(ClientSettingsPatch);
const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);
const decodeServerSettingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch);
const encodeServerSettings = Schema.encodeSync(ServerSettings);

describe("ClientSettings word wrap", () => {
  it("defaults word wrap on", () => {
    expect(decodeClientSettings({}).wordWrap).toBe(true);
  });

  it("ignores obsolete wrapping preferences", () => {
    const decoded = decodeClientSettings({
      chatWordWrap: false,
      diffWordWrap: false,
    });

    expect(decoded.wordWrap).toBe(true);
    expect(decoded).not.toHaveProperty("chatWordWrap");
    expect(decoded).not.toHaveProperty("diffWordWrap");
  });
});

describe("ClientSettings personalization", () => {
  it("defaults personalization controls for legacy settings", () => {
    const decoded = decodeClientSettings({});

    expect(decoded.uiAccentColor).toBe(DEFAULT_CLIENT_SETTINGS.uiAccentColor);
    expect(decoded.customUiAccentColor).toBe(DEFAULT_CLIENT_SETTINGS.customUiAccentColor);
    expect(decoded.uiSecondaryColor).toBe(DEFAULT_CLIENT_SETTINGS.uiSecondaryColor);
    expect(decoded.customUiSecondaryColor).toBe(DEFAULT_CLIENT_SETTINGS.customUiSecondaryColor);
    expect(decoded.uiFontFamily).toBe(DEFAULT_CLIENT_SETTINGS.uiFontFamily);
    expect(decoded.uiMonoFontFamily).toBe(DEFAULT_CLIENT_SETTINGS.uiMonoFontFamily);
    expect(decoded.uiFontSize).toBe(DEFAULT_CLIENT_SETTINGS.uiFontSize);
    expect(decoded.uiCodeFontSize).toBe(DEFAULT_CLIENT_SETTINGS.uiCodeFontSize);
    expect(decoded.interfaceDensity).toBe(DEFAULT_CLIENT_SETTINGS.interfaceDensity);
    expect(decoded.interfaceContrast).toBe(DEFAULT_CLIENT_SETTINGS.interfaceContrast);
    expect(decoded.backgroundTexture).toBe(DEFAULT_CLIENT_SETTINGS.backgroundTexture);
    expect(decoded.agentActivityCopyStyle).toBe(DEFAULT_CLIENT_SETTINGS.agentActivityCopyStyle);
    expect(decoded.chatPromptSuggestions).toBe(DEFAULT_CLIENT_SETTINGS.chatPromptSuggestions);
    expect(decoded.chatStartComposerPlacement).toBe(
      DEFAULT_CLIENT_SETTINGS.chatStartComposerPlacement,
    );
    expect(decoded.chatSurfaceStyle).toBe(DEFAULT_CLIENT_SETTINGS.chatSurfaceStyle);
  });

  it("accepts personalization patches", () => {
    const patch = decodeClientSettingsPatch({
      agentActivityCopyStyle: "plain",
      backgroundTexture: "visible",
      chatPromptSuggestions: false,
      chatStartComposerPlacement: "bottom",
      chatSurfaceStyle: "crisp",
      customUiAccentColor: "  #123abc  ",
      customUiSecondaryColor: "abc",
      interfaceContrast: "high",
      interfaceDensity: "compact",
      uiAccentColor: "custom",
      uiCodeFontSize: "large",
      uiFontFamily: "serif",
      uiFontSize: "large",
      uiMonoFontFamily: "system",
      uiSecondaryColor: "custom",
    });

    expect(patch).toEqual({
      agentActivityCopyStyle: "plain",
      backgroundTexture: "visible",
      chatPromptSuggestions: false,
      chatStartComposerPlacement: "bottom",
      chatSurfaceStyle: "crisp",
      customUiAccentColor: "#123abc",
      customUiSecondaryColor: "#aabbcc",
      interfaceContrast: "high",
      interfaceDensity: "compact",
      uiAccentColor: "custom",
      uiCodeFontSize: "large",
      uiFontFamily: "serif",
      uiFontSize: "large",
      uiMonoFontFamily: "system",
      uiSecondaryColor: "custom",
    });
  });

  it("normalizes invalid custom color patches back to defaults", () => {
    const patch = decodeClientSettingsPatch({
      customUiAccentColor: "not-a-color",
      customUiSecondaryColor: "#12",
    });

    expect(patch).toEqual({
      customUiAccentColor: DEFAULT_CLIENT_SETTINGS.customUiAccentColor,
      customUiSecondaryColor: DEFAULT_CLIENT_SETTINGS.customUiSecondaryColor,
    });
  });
});

describe("ServerSettings.providerInstances (slice-2 invariant)", () => {
  it("defaults the local model hub to the app-managed model root", () => {
    expect(DEFAULT_SERVER_SETTINGS.localModelHub).toEqual({ modelRoot: "" });
    expect(decodeServerSettings({}).localModelHub).toEqual({ modelRoot: "" });
  });

  it("accepts local model hub and Local provider patches", () => {
    expect(
      decodeServerSettingsPatch({
        localModelHub: { modelRoot: "  ~/Models/t3  " },
        providers: {
          local: {
            enabled: true,
            baseUrl: " http://127.0.0.1:8018 ",
            contextWindow: 8192,
            outputTokenLimit: 512,
          },
        },
      }),
    ).toEqual({
      localModelHub: { modelRoot: "~/Models/t3" },
      providers: {
        local: {
          enabled: true,
          baseUrl: "http://127.0.0.1:8018",
          contextWindow: 8192,
          outputTokenLimit: 512,
        },
      },
    });
  });

  it("defaults to an empty record so legacy configs without the key still decode", () => {
    expect(DEFAULT_SERVER_SETTINGS.providerInstances).toEqual({});
  });

  it("decodes a fully empty config (legacy on-disk shape) without complaint", () => {
    const decoded = decodeServerSettings({});
    expect(decoded.providerInstances).toEqual({});
    // Legacy `providers` struct is still hydrated with its per-driver defaults
    // so existing call sites keep working through the migration.
    expect(decoded.providers.codex.enabled).toBe(true);
  });

  it("decodes a multi-instance map mixing first-party and fork drivers", () => {
    const decoded = decodeServerSettings({
      providerInstances: {
        codex_personal: {
          driver: "codex",
          displayName: "Codex (personal)",
          config: { homePath: "~/.codex_personal" },
        },
        codex_work: {
          driver: "codex",
          config: { homePath: "~/.codex_work" },
        },
        ollama_local: {
          driver: "ollama",
          displayName: "Ollama (local)",
          config: { endpoint: "http://localhost:11434" },
        },
      },
    });
    const personalId = ProviderInstanceId.make("codex_personal");
    const workId = ProviderInstanceId.make("codex_work");
    const ollamaId = ProviderInstanceId.make("ollama_local");

    expect(decoded.providerInstances[personalId]?.driver).toBe("codex");
    expect(decoded.providerInstances[workId]?.config).toEqual({ homePath: "~/.codex_work" });
    // Critical: a config naming a driver this build does not know about
    // (`ollama` is not in `ProviderDriverKind`) must round-trip without loss.
    // The runtime handles "driver not installed" — the schema must not.
    expect(decoded.providerInstances[ollamaId]?.driver).toBe("ollama");
    expect(decoded.providerInstances[ollamaId]?.config).toEqual({
      endpoint: "http://localhost:11434",
    });
  });

  it("rejects instance keys that violate the slug pattern", () => {
    expect(() =>
      decodeServerSettings({
        providerInstances: { "1bad": { driver: "codex" } },
      }),
    ).toThrow();
  });
});

describe("ServerSettings.capabilityRegistry", () => {
  it("defaults capability registry settings for legacy server configs", () => {
    expect(DEFAULT_SERVER_SETTINGS.capabilityRegistry).toEqual({
      skillRoots: [],
      overrides: {},
    });

    expect(decodeServerSettings({}).capabilityRegistry).toEqual({
      skillRoots: [],
      overrides: {},
    });
  });

  it("decodes skill roots and capability overrides from patches", () => {
    const patch = decodeServerSettingsPatch({
      capabilityRegistry: {
        skillRoots: ["  .t3/skills  "],
        overrides: {
          "t3:tool:subagent": {
            enabled: false,
            activation: "hidden",
          },
        },
      },
    });

    expect(patch.capabilityRegistry).toEqual({
      skillRoots: [".t3/skills"],
      overrides: {
        "t3:tool:subagent": {
          enabled: false,
          activation: "hidden",
        },
      },
    });
  });
});

describe("ServerSettings worktree defaults", () => {
  it("defaults start-from-origin off for legacy configs", () => {
    expect(decodeServerSettings({}).newWorktreesStartFromOrigin).toBe(false);
  });

  it("accepts start-from-origin updates", () => {
    expect(
      decodeServerSettingsPatch({ newWorktreesStartFromOrigin: true }).newWorktreesStartFromOrigin,
    ).toBe(true);
  });
});

describe("ServerSettingsPatch.providerInstances", () => {
  it("treats providerInstances as an optional whole-map replacement", () => {
    const patch = decodeServerSettingsPatch({});
    expect(patch.providerInstances).toBeUndefined();

    const replacement = decodeServerSettingsPatch({
      providerInstances: {
        codex_personal: { driver: "codex", config: { homePath: "~/.codex" } },
      },
    });
    expect(replacement.providerInstances).toBeDefined();
    expect(replacement.providerInstances?.[ProviderInstanceId.make("codex_personal")]?.driver).toBe(
      "codex",
    );
  });

  it("preserves a fork-defined driver entry through patch decoding", () => {
    const patch = decodeServerSettingsPatch({
      providerInstances: {
        ollama_local: {
          driver: "ollama",
          config: { endpoint: "http://localhost:11434" },
        },
      },
    });
    const ollamaId = ProviderInstanceId.make("ollama_local");
    expect(patch.providerInstances?.[ollamaId]?.driver).toBe("ollama");
  });
});

describe("ServerSettingsPatch string normalization", () => {
  it("trims string settings while decoding patches", () => {
    const patch = decodeServerSettingsPatch({
      addProjectBaseDirectory: "  ~/Development  ",
      textGenerationModelSelection: { model: "  gpt-5.4-mini  " },
      observability: {
        otlpTracesUrl: "  http://localhost:4318/v1/traces  ",
      },
      providers: {
        codex: {
          binaryPath: "  /opt/homebrew/bin/codex  ",
          homePath: "  ~/.codex  ",
        },
      },
      providerInstances: {
        codex_personal: {
          driver: "  codex  ",
          displayName: "  Codex Personal  ",
          config: { homePath: "  ~/.codex-personal  " },
        },
      },
    });

    expect(patch.addProjectBaseDirectory).toBe("~/Development");
    expect(patch.textGenerationModelSelection?.model).toBe("gpt-5.4-mini");
    expect(patch.observability?.otlpTracesUrl).toBe("http://localhost:4318/v1/traces");
    expect(patch.providers?.codex?.binaryPath).toBe("/opt/homebrew/bin/codex");
    expect(patch.providers?.codex?.homePath).toBe("~/.codex");
    expect(patch.providerInstances?.[ProviderInstanceId.make("codex_personal")]?.driver).toBe(
      "codex",
    );
    expect(patch.providerInstances?.[ProviderInstanceId.make("codex_personal")]?.displayName).toBe(
      "Codex Personal",
    );
    expect(patch.providerInstances?.[ProviderInstanceId.make("codex_personal")]?.config).toEqual({
      homePath: "  ~/.codex-personal  ",
    });
  });

  it("trims encoded server settings values before validation", () => {
    const defaultSettings = decodeServerSettings({});
    const encoded = encodeServerSettings({
      ...defaultSettings,
      addProjectBaseDirectory: "  ~/Development  ",
      providers: {
        ...defaultSettings.providers,
        codex: {
          ...defaultSettings.providers.codex,
          binaryPath: "  /opt/homebrew/bin/codex  ",
        },
      },
    });

    expect(encoded.addProjectBaseDirectory).toBe("~/Development");
    expect(encoded.providers?.codex?.binaryPath).toBe("/opt/homebrew/bin/codex");
  });
});
