import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_LOCAL_CONTEXT_WINDOW,
  DEFAULT_LOCAL_OUTPUT_TOKEN_LIMIT,
  ProviderDriverKind,
} from "@t3tools/contracts";

import { DRIVER_OPTION_BY_VALUE } from "./providerDriverMeta";
import {
  deriveProviderSettingsFields,
  nextProviderConfigWithFieldValue,
  readProviderConfigBoolean,
  readProviderConfigNumberInput,
  readProviderConfigString,
} from "./ProviderSettingsForm";

describe("ProviderSettingsForm helpers", () => {
  it("derives visible provider config fields from the client definition schema", () => {
    const codex = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("codex")];

    expect(codex).toBeDefined();
    expect(deriveProviderSettingsFields(codex!).map((field) => field.key)).toEqual([
      "binaryPath",
      "homePath",
      "shadowHomePath",
    ]);
  });

  it("sources labels and descriptions from schema annotations", () => {
    const opencode = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("opencode")];
    expect(opencode).toBeDefined();

    const serverPassword = deriveProviderSettingsFields(opencode!).find(
      (field) => field.key === "serverPassword",
    );

    expect(serverPassword).toMatchObject({
      label: "Server password",
      description: "Stored in plain text on disk.",
      control: "password",
    });
  });

  it("exposes Local vLLM token limits as numeric fields", () => {
    const local = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("local")];
    expect(local).toBeDefined();

    const fields = deriveProviderSettingsFields(local!);

    expect(fields.find((field) => field.key === "contextWindow")).toMatchObject({
      control: "number",
      label: "Context window",
      placeholder: String(DEFAULT_LOCAL_CONTEXT_WINDOW),
    });
    expect(fields.find((field) => field.key === "outputTokenLimit")).toMatchObject({
      control: "number",
      label: "Output token limit",
      placeholder: String(DEFAULT_LOCAL_OUTPUT_TOKEN_LIMIT),
    });
  });

  it("preserves unknown config keys while omitting empty configurable fields", () => {
    const opencode = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("opencode")];
    expect(opencode).toBeDefined();

    const serverUrl = deriveProviderSettingsFields(opencode!).find(
      (field) => field.key === "serverUrl",
    );
    expect(serverUrl).toBeDefined();

    const next = nextProviderConfigWithFieldValue(
      { forkOwned: 1, serverUrl: "http://127.0.0.1:4096" },
      serverUrl!,
      "",
    );

    expect(next).toEqual({ forkOwned: 1 });
  });

  it("reads non-string config values as blank strings", () => {
    expect(readProviderConfigString({ binaryPath: 123 }, "binaryPath")).toBe("");
  });

  it("stores numeric field values as numbers", () => {
    const next = nextProviderConfigWithFieldValue(
      { forkOwned: 1 },
      {
        key: "contextWindow",
        control: "number",
        label: "Context window",
        clearWhenEmpty: "omit",
      },
      "4096",
    );

    expect(next).toEqual({ forkOwned: 1, contextWindow: 4096 });
    expect(readProviderConfigNumberInput(next, "contextWindow")).toBe("4096");
  });

  it("omits empty numeric values when clearWhenEmpty is omit", () => {
    const next = nextProviderConfigWithFieldValue(
      { forkOwned: 1, contextWindow: 4096 },
      {
        key: "contextWindow",
        control: "number",
        label: "Context window",
        clearWhenEmpty: "omit",
      },
      "",
    );

    expect(next).toEqual({ forkOwned: 1 });
  });

  it("does not persist invalid numeric field input", () => {
    const next = nextProviderConfigWithFieldValue(
      { forkOwned: 1, contextWindow: 4096 },
      {
        key: "contextWindow",
        control: "number",
        label: "Context window",
        clearWhenEmpty: "omit",
      },
      "4k",
    );

    expect(next).toEqual({ forkOwned: 1, contextWindow: 4096 });
    expect(readProviderConfigNumberInput(next, "contextWindow")).toBe("4096");
  });

  it("does not persist invalid numeric field input into empty config", () => {
    const next = nextProviderConfigWithFieldValue(
      undefined,
      {
        key: "contextWindow",
        control: "number",
        label: "Context window",
        clearWhenEmpty: "omit",
      },
      "nope",
    );

    expect(next).toBeUndefined();
  });

  it("omits false boolean fields when clearWhenEmpty is omit", () => {
    const next = nextProviderConfigWithFieldValue(
      { forkOwned: 1, experimental: true },
      {
        key: "experimental",
        control: "switch",
        label: "Experimental",
        clearWhenEmpty: "omit",
        defaultBooleanValue: false,
      },
      false,
    );

    expect(next).toEqual({ forkOwned: 1 });
  });

  it("omits true boolean fields when true is the default", () => {
    const next = nextProviderConfigWithFieldValue(
      { forkOwned: 1, experimental: false },
      {
        key: "experimental",
        control: "switch",
        label: "Experimental",
        clearWhenEmpty: "omit",
        defaultBooleanValue: true,
      },
      true,
    );

    expect(next).toEqual({ forkOwned: 1 });
  });

  it("stores false boolean fields when true is the default", () => {
    const next = nextProviderConfigWithFieldValue(
      undefined,
      {
        key: "experimental",
        control: "switch",
        label: "Experimental",
        clearWhenEmpty: "omit",
        defaultBooleanValue: true,
      },
      false,
    );

    expect(next).toEqual({ experimental: false });
  });

  it("preserves false boolean fields when clearWhenEmpty is persist", () => {
    const next = nextProviderConfigWithFieldValue(
      undefined,
      {
        key: "experimental",
        control: "switch",
        label: "Experimental",
        clearWhenEmpty: "persist",
      },
      false,
    );

    expect(next).toEqual({ experimental: false });
  });

  it("reads non-boolean config values as false booleans", () => {
    expect(readProviderConfigBoolean({ experimental: "true" }, "experimental")).toBe(false);
  });

  it("reads missing boolean config values from the supplied default", () => {
    expect(readProviderConfigBoolean({}, "experimental", true)).toBe(true);
  });
});
