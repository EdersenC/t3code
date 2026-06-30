import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  applyPersonalizationSettings,
  resolvePersonalizationTokens,
  resolveTerminalTypography,
  selectPersonalizationSettings,
  UI_ACCENT_COLOR_OPTIONS,
  UI_SECONDARY_COLOR_OPTIONS,
  type PersonalizationSettings,
} from "./personalization";

function createDocumentStub() {
  const properties = new Map<string, string>();
  return {
    documentElement: {
      dataset: {} as Record<string, string>,
      style: {
        getPropertyValue: (property: string) => properties.get(property) ?? "",
        removeProperty: (property: string) => {
          const previous = properties.get(property) ?? "";
          properties.delete(property);
          return previous;
        },
        setProperty: (property: string, value: string) => {
          properties.set(property, value);
        },
      },
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("personalization palette", () => {
  it("offers broad accent and secondary palettes", () => {
    expect(UI_ACCENT_COLOR_OPTIONS.map((option) => option.value)).toEqual([
      "blue",
      "sky",
      "cyan",
      "teal",
      "emerald",
      "amber",
      "orange",
      "rose",
      "fuchsia",
      "violet",
      "indigo",
      "slate",
      "custom",
    ]);
    expect(UI_SECONDARY_COLOR_OPTIONS.map((option) => option.value)).toEqual([
      "neutral",
      "slate",
      "blue",
      "teal",
      "emerald",
      "amber",
      "rose",
      "violet",
      "custom",
    ]);
  });

  it("resolves selected colors to app-wide CSS tokens", () => {
    const settings: PersonalizationSettings = {
      ...selectPersonalizationSettings(DEFAULT_CLIENT_SETTINGS),
      backgroundTexture: "visible",
      interfaceContrast: "high",
      interfaceDensity: "compact",
      uiAccentColor: "emerald",
      uiSecondaryColor: "violet",
    };

    const tokens = resolvePersonalizationTokens(settings, "dark");

    expect(tokens["--primary"]).toBe("var(--color-emerald-300)");
    expect(tokens["--primary-foreground"]).toBe("var(--color-neutral-950)");
    expect(tokens["--sidebar"]).toContain("var(--color-violet-300)");
    expect(tokens["--border"]).toBe("rgb(255 255 255 / 0.18)");
    expect(tokens["--app-texture-opacity"]).toBe("0.07");
  });

  it("resolves custom colors and typography tokens", () => {
    const settings: PersonalizationSettings = {
      ...selectPersonalizationSettings(DEFAULT_CLIENT_SETTINGS),
      customUiAccentColor: "#facc15",
      customUiSecondaryColor: "0f766e",
      uiAccentColor: "custom",
      uiCodeFontSize: "large",
      uiFontFamily: "serif",
      uiFontSize: "large",
      uiMonoFontFamily: "system",
      uiSecondaryColor: "custom",
    };

    const tokens = resolvePersonalizationTokens(settings, "light");

    expect(tokens["--primary"]).toBe("#facc15");
    expect(tokens["--primary-foreground"]).toBe("var(--color-neutral-950)");
    expect(tokens["--sidebar"]).toContain("#0f766e");
    expect(tokens["--font-sans"]).toContain("Georgia");
    expect(tokens["--font-mono"]).toContain("ui-monospace");
    expect(tokens["--app-root-font-size"]).toBe("106.25%");
    expect(tokens["--app-code-font-scale"]).toBe("1.0625");
    expect(tokens["--app-terminal-font-size"]).toBe("13px");
  });

  it("resolves terminal typography options", () => {
    expect(
      resolveTerminalTypography({ uiCodeFontSize: "small", uiMonoFontFamily: "monospace" }),
    ).toEqual({
      fontFamily: "monospace",
      fontSize: 11,
    });
  });

  it("applies resolved settings to the document root", () => {
    const settings: PersonalizationSettings = {
      ...selectPersonalizationSettings(DEFAULT_CLIENT_SETTINGS),
      backgroundTexture: "none",
      interfaceContrast: "high",
      interfaceDensity: "spacious",
      uiAccentColor: "rose",
      uiSecondaryColor: "slate",
    };

    const documentStub = createDocumentStub();
    vi.stubGlobal("document", documentStub);

    applyPersonalizationSettings(settings, "light");

    expect(documentStub.documentElement.style.getPropertyValue("--primary")).toBe(
      "var(--color-rose-600)",
    );
    expect(documentStub.documentElement.style.getPropertyValue("--sidebar-accent")).toContain(
      "var(--color-slate-500)",
    );
    expect(documentStub.documentElement.style.getPropertyValue("--app-texture-opacity")).toBe("0");
    expect(documentStub.documentElement.dataset.interfaceDensity).toBe("spacious");
    expect(documentStub.documentElement.style.getPropertyValue("--font-sans")).toContain("DM Sans");
    expect(documentStub.documentElement.dataset.interfaceContrast).toBe("high");
    expect(documentStub.documentElement.dataset.uiFontSize).toBe("default");
  });
});
