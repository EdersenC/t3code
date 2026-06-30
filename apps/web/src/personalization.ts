import type {
  BackgroundTexture,
  ClientSettings,
  InterfaceContrast,
  InterfaceDensity,
  UiAccentColor,
  UiCodeFontSize,
  UiFontFamily,
  UiFontSize,
  UiMonoFontFamily,
  UiSecondaryColor,
} from "@t3tools/contracts/settings";
import {
  DEFAULT_BACKGROUND_TEXTURE,
  DEFAULT_CUSTOM_UI_ACCENT_COLOR,
  DEFAULT_CUSTOM_UI_SECONDARY_COLOR,
  DEFAULT_INTERFACE_CONTRAST,
  DEFAULT_INTERFACE_DENSITY,
  DEFAULT_UI_ACCENT_COLOR,
  DEFAULT_UI_CODE_FONT_SIZE,
  DEFAULT_UI_FONT_FAMILY,
  DEFAULT_UI_FONT_SIZE,
  DEFAULT_UI_MONO_FONT_FAMILY,
  DEFAULT_UI_SECONDARY_COLOR,
} from "@t3tools/contracts/settings";
import { useEffect } from "react";

import { useClientSettings } from "./hooks/useSettings";
import { syncBrowserChromeTheme, useTheme } from "./hooks/useTheme";

export type ResolvedTheme = "light" | "dark";

export type PersonalizationSettings = Pick<
  ClientSettings,
  | "backgroundTexture"
  | "customUiAccentColor"
  | "customUiSecondaryColor"
  | "interfaceContrast"
  | "interfaceDensity"
  | "uiAccentColor"
  | "uiCodeFontSize"
  | "uiFontFamily"
  | "uiFontSize"
  | "uiMonoFontFamily"
  | "uiSecondaryColor"
>;

export type TerminalTypographySettings = Pick<
  ClientSettings,
  "uiCodeFontSize" | "uiMonoFontFamily"
>;

export interface PersonalizationOption<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly description: string;
}

export interface ColorPaletteOption<T extends string> extends PersonalizationOption<T> {
  readonly swatch: string;
  readonly preview: readonly string[];
}

interface AccentModeTokens {
  readonly primary: string;
  readonly primaryForeground: string;
  readonly ring: string;
}

interface SecondaryModeTokens {
  readonly accent: string;
  readonly muted: string;
  readonly secondary: string;
  readonly sidebar: string;
  readonly sidebarAccent: string;
}

interface ContrastModeTokens {
  readonly border: string;
  readonly input: string;
  readonly mutedForeground: string;
  readonly sidebarBorder: string;
}

export interface TerminalTypographyTokens {
  readonly fontFamily: string;
  readonly fontSize: number;
}

type PresetUiAccentColor = Exclude<UiAccentColor, "custom">;
type PresetUiSecondaryColor = Exclude<UiSecondaryColor, "custom">;

const DARK_TEXT = "var(--color-neutral-950)";
const LIGHT_TEXT = "var(--color-white)";
const LIGHT_FOREGROUND = "var(--color-neutral-800)";
const DARK_FOREGROUND = "var(--color-neutral-100)";

export const UI_ACCENT_COLOR_OPTIONS: ReadonlyArray<ColorPaletteOption<UiAccentColor>> = [
  {
    value: "blue",
    label: "Command Blue",
    description: "Clear, direct, and close to the default app identity.",
    swatch: "#2563eb",
    preview: ["#2563eb", "#60a5fa"],
  },
  {
    value: "sky",
    label: "Signal Sky",
    description: "Bright highlights that still feel calm in long sessions.",
    swatch: "#0284c7",
    preview: ["#0284c7", "#7dd3fc"],
  },
  {
    value: "cyan",
    label: "Terminal Cyan",
    description: "Cool, technical, and easy to pick out in dense UI.",
    swatch: "#0891b2",
    preview: ["#0891b2", "#67e8f9"],
  },
  {
    value: "teal",
    label: "Ops Teal",
    description: "Balanced color for status-heavy workflows.",
    swatch: "#0f766e",
    preview: ["#0f766e", "#5eead4"],
  },
  {
    value: "emerald",
    label: "Build Green",
    description: "A confident palette for code, checks, and progress.",
    swatch: "#059669",
    preview: ["#059669", "#6ee7b7"],
  },
  {
    value: "amber",
    label: "Review Amber",
    description: "Warm focus without turning the whole app beige.",
    swatch: "#b45309",
    preview: ["#b45309", "#fbbf24"],
  },
  {
    value: "orange",
    label: "Patch Orange",
    description: "Energetic callouts for hands-on editing sessions.",
    swatch: "#ea580c",
    preview: ["#ea580c", "#fdba74"],
  },
  {
    value: "rose",
    label: "Alert Rose",
    description: "Sharp, expressive highlights for high-signal controls.",
    swatch: "#e11d48",
    preview: ["#e11d48", "#fda4af"],
  },
  {
    value: "fuchsia",
    label: "Prompt Fuchsia",
    description: "Playful and visible without flooding the surface.",
    swatch: "#c026d3",
    preview: ["#c026d3", "#f0abfc"],
  },
  {
    value: "violet",
    label: "Agent Violet",
    description: "A modern assistant color with restrained saturation.",
    swatch: "#7c3aed",
    preview: ["#7c3aed", "#c4b5fd"],
  },
  {
    value: "indigo",
    label: "Deep Indigo",
    description: "Focused, familiar, and slightly quieter than blue.",
    swatch: "#4f46e5",
    preview: ["#4f46e5", "#a5b4fc"],
  },
  {
    value: "slate",
    label: "Graphite",
    description: "Minimal accenting for users who prefer a low-color UI.",
    swatch: "#475569",
    preview: ["#475569", "#cbd5e1"],
  },
  {
    value: "custom",
    label: "Color wheel",
    description: "Pick an exact accent color from the native color picker.",
    swatch: DEFAULT_CUSTOM_UI_ACCENT_COLOR,
    preview: [DEFAULT_CUSTOM_UI_ACCENT_COLOR, "#93c5fd"],
  },
] as const;

export const UI_SECONDARY_COLOR_OPTIONS: ReadonlyArray<ColorPaletteOption<UiSecondaryColor>> = [
  {
    value: "neutral",
    label: "Neutral",
    description: "Keeps hovers, panels, and chips close to the base theme.",
    swatch: "#737373",
    preview: ["#f5f5f5", "#262626"],
  },
  {
    value: "slate",
    label: "Slate",
    description: "A cool chrome tint for sidebars and repeated surfaces.",
    swatch: "#64748b",
    preview: ["#e2e8f0", "#334155"],
  },
  {
    value: "blue",
    label: "Blue Wash",
    description: "Adds a faint product color to hover and sidebar states.",
    swatch: "#3b82f6",
    preview: ["#dbeafe", "#1e3a8a"],
  },
  {
    value: "teal",
    label: "Teal Wash",
    description: "Softens the shell with a quiet green-blue tint.",
    swatch: "#14b8a6",
    preview: ["#ccfbf1", "#134e4a"],
  },
  {
    value: "emerald",
    label: "Emerald Wash",
    description: "Gives supporting surfaces a subtle progress-oriented tone.",
    swatch: "#10b981",
    preview: ["#d1fae5", "#064e3b"],
  },
  {
    value: "amber",
    label: "Amber Wash",
    description: "Warms secondary areas without changing the main background.",
    swatch: "#f59e0b",
    preview: ["#fef3c7", "#78350f"],
  },
  {
    value: "rose",
    label: "Rose Wash",
    description: "Adds a lightly editorial tint to supporting UI.",
    swatch: "#f43f5e",
    preview: ["#ffe4e6", "#881337"],
  },
  {
    value: "violet",
    label: "Violet Wash",
    description: "A soft assistant-like tint for panels and active rows.",
    swatch: "#8b5cf6",
    preview: ["#ede9fe", "#4c1d95"],
  },
  {
    value: "custom",
    label: "Color wheel",
    description: "Tint supporting surfaces with an exact color.",
    swatch: DEFAULT_CUSTOM_UI_SECONDARY_COLOR,
    preview: ["#f1f5f9", DEFAULT_CUSTOM_UI_SECONDARY_COLOR],
  },
] as const;

export const INTERFACE_DENSITY_OPTIONS: ReadonlyArray<PersonalizationOption<InterfaceDensity>> = [
  {
    value: "compact",
    label: "Compact",
    description: "Fits more projects, threads, and controls into view.",
  },
  {
    value: "comfortable",
    label: "Comfortable",
    description: "The balanced default for mixed reading and editing.",
  },
  {
    value: "spacious",
    label: "Spacious",
    description: "Adds breathing room around navigation and settings rows.",
  },
] as const;

export const INTERFACE_CONTRAST_OPTIONS: ReadonlyArray<PersonalizationOption<InterfaceContrast>> = [
  {
    value: "standard",
    label: "Standard",
    description: "Keeps borders and secondary text visually quiet.",
  },
  {
    value: "high",
    label: "High contrast",
    description: "Strengthens dividers, inputs, focus rings, and muted text.",
  },
] as const;

export const BACKGROUND_TEXTURE_OPTIONS: ReadonlyArray<PersonalizationOption<BackgroundTexture>> = [
  {
    value: "none",
    label: "Off",
    description: "Removes the subtle page grain overlay.",
  },
  {
    value: "subtle",
    label: "Subtle",
    description: "Keeps the default low-noise texture.",
  },
  {
    value: "visible",
    label: "Visible",
    description: "Makes background texture more apparent on empty surfaces.",
  },
] as const;

export const UI_FONT_FAMILY_OPTIONS: ReadonlyArray<PersonalizationOption<UiFontFamily>> = [
  {
    value: "dm-sans",
    label: "DM Sans",
    description: "The app default: readable, neutral, and compact.",
  },
  {
    value: "system",
    label: "System",
    description: "Uses your OS interface font for a native feel.",
  },
  {
    value: "serif",
    label: "Serif",
    description: "Adds a more editorial reading style to the interface.",
  },
  {
    value: "mono",
    label: "Mono",
    description: "Gives the whole UI a terminal-like rhythm.",
  },
] as const;

export const UI_MONO_FONT_FAMILY_OPTIONS: ReadonlyArray<PersonalizationOption<UiMonoFontFamily>> = [
  {
    value: "jetbrains-mono",
    label: "JetBrains Mono",
    description: "A coding-focused monospace stack with the current fallback chain.",
  },
  {
    value: "system",
    label: "System mono",
    description: "Uses your platform's preferred monospace font.",
  },
  {
    value: "sf-mono",
    label: "SF Mono",
    description: "Prioritizes Apple's developer monospace where available.",
  },
  {
    value: "monospace",
    label: "Browser mono",
    description: "Falls back to the browser's generic monospace choice.",
  },
] as const;

export const UI_FONT_SIZE_OPTIONS: ReadonlyArray<PersonalizationOption<UiFontSize>> = [
  {
    value: "small",
    label: "Small",
    description: "Slightly reduces global interface text.",
  },
  {
    value: "default",
    label: "Default",
    description: "Keeps the current app scale.",
  },
  {
    value: "large",
    label: "Large",
    description: "Raises global interface text one step.",
  },
  {
    value: "extra-large",
    label: "Extra large",
    description: "Uses the largest global interface scale.",
  },
] as const;

export const UI_CODE_FONT_SIZE_OPTIONS: ReadonlyArray<PersonalizationOption<UiCodeFontSize>> = [
  {
    value: "small",
    label: "Small",
    description: "Makes code and terminal text more compact.",
  },
  {
    value: "default",
    label: "Default",
    description: "Keeps the current code and terminal scale.",
  },
  {
    value: "large",
    label: "Large",
    description: "Increases code and terminal readability.",
  },
] as const;

const ACCENT_TOKENS: Record<PresetUiAccentColor, Record<ResolvedTheme, AccentModeTokens>> = {
  blue: {
    light: {
      primary: "var(--color-blue-600)",
      primaryForeground: LIGHT_TEXT,
      ring: "var(--color-blue-600)",
    },
    dark: {
      primary: "var(--color-blue-400)",
      primaryForeground: DARK_TEXT,
      ring: "var(--color-blue-400)",
    },
  },
  sky: {
    light: {
      primary: "var(--color-sky-600)",
      primaryForeground: LIGHT_TEXT,
      ring: "var(--color-sky-600)",
    },
    dark: {
      primary: "var(--color-sky-300)",
      primaryForeground: DARK_TEXT,
      ring: "var(--color-sky-300)",
    },
  },
  cyan: {
    light: {
      primary: "var(--color-cyan-700)",
      primaryForeground: LIGHT_TEXT,
      ring: "var(--color-cyan-700)",
    },
    dark: {
      primary: "var(--color-cyan-300)",
      primaryForeground: DARK_TEXT,
      ring: "var(--color-cyan-300)",
    },
  },
  teal: {
    light: {
      primary: "var(--color-teal-700)",
      primaryForeground: LIGHT_TEXT,
      ring: "var(--color-teal-700)",
    },
    dark: {
      primary: "var(--color-teal-300)",
      primaryForeground: DARK_TEXT,
      ring: "var(--color-teal-300)",
    },
  },
  emerald: {
    light: {
      primary: "var(--color-emerald-700)",
      primaryForeground: LIGHT_TEXT,
      ring: "var(--color-emerald-700)",
    },
    dark: {
      primary: "var(--color-emerald-300)",
      primaryForeground: DARK_TEXT,
      ring: "var(--color-emerald-300)",
    },
  },
  amber: {
    light: {
      primary: "var(--color-amber-700)",
      primaryForeground: LIGHT_TEXT,
      ring: "var(--color-amber-700)",
    },
    dark: {
      primary: "var(--color-amber-300)",
      primaryForeground: DARK_TEXT,
      ring: "var(--color-amber-300)",
    },
  },
  orange: {
    light: {
      primary: "var(--color-orange-700)",
      primaryForeground: LIGHT_TEXT,
      ring: "var(--color-orange-700)",
    },
    dark: {
      primary: "var(--color-orange-300)",
      primaryForeground: DARK_TEXT,
      ring: "var(--color-orange-300)",
    },
  },
  rose: {
    light: {
      primary: "var(--color-rose-600)",
      primaryForeground: LIGHT_TEXT,
      ring: "var(--color-rose-600)",
    },
    dark: {
      primary: "var(--color-rose-300)",
      primaryForeground: DARK_TEXT,
      ring: "var(--color-rose-300)",
    },
  },
  fuchsia: {
    light: {
      primary: "var(--color-fuchsia-700)",
      primaryForeground: LIGHT_TEXT,
      ring: "var(--color-fuchsia-700)",
    },
    dark: {
      primary: "var(--color-fuchsia-300)",
      primaryForeground: DARK_TEXT,
      ring: "var(--color-fuchsia-300)",
    },
  },
  violet: {
    light: {
      primary: "var(--color-violet-600)",
      primaryForeground: LIGHT_TEXT,
      ring: "var(--color-violet-600)",
    },
    dark: {
      primary: "var(--color-violet-300)",
      primaryForeground: DARK_TEXT,
      ring: "var(--color-violet-300)",
    },
  },
  indigo: {
    light: {
      primary: "var(--color-indigo-600)",
      primaryForeground: LIGHT_TEXT,
      ring: "var(--color-indigo-600)",
    },
    dark: {
      primary: "var(--color-indigo-300)",
      primaryForeground: DARK_TEXT,
      ring: "var(--color-indigo-300)",
    },
  },
  slate: {
    light: {
      primary: "var(--color-slate-700)",
      primaryForeground: LIGHT_TEXT,
      ring: "var(--color-slate-700)",
    },
    dark: {
      primary: "var(--color-slate-300)",
      primaryForeground: DARK_TEXT,
      ring: "var(--color-slate-300)",
    },
  },
};

const neutralSecondaryTokens: Record<ResolvedTheme, SecondaryModeTokens> = {
  light: {
    accent: "rgb(0 0 0 / 0.04)",
    muted: "rgb(0 0 0 / 0.04)",
    secondary: "rgb(0 0 0 / 0.04)",
    sidebar: "var(--background)",
    sidebarAccent: "rgb(0 0 0 / 0.05)",
  },
  dark: {
    accent: "rgb(255 255 255 / 0.04)",
    muted: "rgb(255 255 255 / 0.04)",
    secondary: "rgb(255 255 255 / 0.04)",
    sidebar: "var(--background)",
    sidebarAccent: "rgb(255 255 255 / 0.06)",
  },
};

function tintedSecondaryTokens(color: string): Record<ResolvedTheme, SecondaryModeTokens> {
  return {
    light: {
      accent: "color-mix(in srgb, var(--color-" + color + "-500) 10%, transparent)",
      muted: "color-mix(in srgb, var(--color-" + color + "-500) 7%, transparent)",
      secondary: "color-mix(in srgb, var(--color-" + color + "-500) 8%, transparent)",
      sidebar: "color-mix(in srgb, var(--background) 94%, var(--color-" + color + "-500))",
      sidebarAccent: "color-mix(in srgb, var(--color-" + color + "-500) 12%, transparent)",
    },
    dark: {
      accent: "color-mix(in srgb, var(--color-" + color + "-300) 12%, transparent)",
      muted: "color-mix(in srgb, var(--color-" + color + "-300) 8%, transparent)",
      secondary: "color-mix(in srgb, var(--color-" + color + "-300) 10%, transparent)",
      sidebar: "color-mix(in srgb, var(--background) 92%, var(--color-" + color + "-300))",
      sidebarAccent: "color-mix(in srgb, var(--color-" + color + "-300) 14%, transparent)",
    },
  };
}

const SECONDARY_TOKENS: Record<
  PresetUiSecondaryColor,
  Record<ResolvedTheme, SecondaryModeTokens>
> = {
  neutral: neutralSecondaryTokens,
  slate: tintedSecondaryTokens("slate"),
  blue: tintedSecondaryTokens("blue"),
  teal: tintedSecondaryTokens("teal"),
  emerald: tintedSecondaryTokens("emerald"),
  amber: tintedSecondaryTokens("amber"),
  rose: tintedSecondaryTokens("rose"),
  violet: tintedSecondaryTokens("violet"),
};

const CONTRAST_TOKENS: Record<InterfaceContrast, Record<ResolvedTheme, ContrastModeTokens>> = {
  standard: {
    light: {
      border: "rgb(0 0 0 / 0.08)",
      input: "rgb(0 0 0 / 0.10)",
      mutedForeground: "color-mix(in srgb, var(--color-neutral-500) 90%, var(--color-black))",
      sidebarBorder: "rgb(0 0 0 / 0.08)",
    },
    dark: {
      border: "rgb(255 255 255 / 0.06)",
      input: "rgb(255 255 255 / 0.08)",
      mutedForeground: "color-mix(in srgb, var(--color-neutral-500) 90%, var(--color-white))",
      sidebarBorder: "rgb(255 255 255 / 0.07)",
    },
  },
  high: {
    light: {
      border: "rgb(0 0 0 / 0.16)",
      input: "rgb(0 0 0 / 0.20)",
      mutedForeground: "var(--color-neutral-700)",
      sidebarBorder: "rgb(0 0 0 / 0.16)",
    },
    dark: {
      border: "rgb(255 255 255 / 0.18)",
      input: "rgb(255 255 255 / 0.22)",
      mutedForeground: "var(--color-neutral-300)",
      sidebarBorder: "rgb(255 255 255 / 0.18)",
    },
  },
};

const TEXTURE_OPACITY: Record<BackgroundTexture, string> = {
  none: "0",
  subtle: "0.035",
  visible: "0.07",
};

const UI_FONT_STACKS: Record<UiFontFamily, string> = {
  "dm-sans":
    '"DM Sans Variable", "DM Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  system: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  serif: 'ui-serif, Georgia, Cambria, "Times New Roman", Times, serif',
  mono: '"SF Mono", "SFMono-Regular", "JetBrains Mono", Consolas, "Liberation Mono", Menlo, monospace',
};

const UI_MONO_FONT_STACKS: Record<UiMonoFontFamily, string> = {
  "jetbrains-mono":
    '"SF Mono", "SFMono-Regular", "JetBrains Mono", Consolas, "Liberation Mono", Menlo, monospace',
  system: 'ui-monospace, "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
  "sf-mono": '"SF Mono", "SFMono-Regular", ui-monospace, Menlo, Monaco, Consolas, monospace',
  monospace: "monospace",
};

const UI_FONT_SIZE_TOKENS: Record<UiFontSize, string> = {
  small: "93.75%",
  default: "100%",
  large: "106.25%",
  "extra-large": "112.5%",
};

const UI_CODE_FONT_SCALE_TOKENS: Record<UiCodeFontSize, string> = {
  small: "0.9375",
  default: "1",
  large: "1.0625",
};

const TERMINAL_FONT_SIZE_TOKENS: Record<UiCodeFontSize, number> = {
  small: 11,
  default: 12,
  large: 13,
};

const HEX_COLOR_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

export function normalizeHexColor(value: string, fallback: string): string {
  const trimmed = value.trim();
  const candidate = trimmed.startsWith("#") ? trimmed : "#" + trimmed;
  if (!HEX_COLOR_PATTERN.test(candidate)) {
    return fallback;
  }
  if (candidate.length === 4) {
    const r = candidate[1] ?? "0";
    const g = candidate[2] ?? "0";
    const b = candidate[3] ?? "0";
    return ("#" + r + r + g + g + b + b).toLowerCase();
  }
  return candidate.toLowerCase();
}

function hexChannelToLinear(channel: string): number {
  const value = Number.parseInt(channel, 16) / 255;
  return value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
}

function hexRelativeLuminance(hexColor: string): number {
  const red = hexChannelToLinear(hexColor.slice(1, 3));
  const green = hexChannelToLinear(hexColor.slice(3, 5));
  const blue = hexChannelToLinear(hexColor.slice(5, 7));
  return red * 0.2126 + green * 0.7152 + blue * 0.0722;
}

function readableForegroundForHex(hexColor: string): string {
  return hexRelativeLuminance(hexColor) > 0.48 ? DARK_TEXT : LIGHT_TEXT;
}

function customAccentTokens(hexColor: string): Record<ResolvedTheme, AccentModeTokens> {
  const foreground = readableForegroundForHex(hexColor);
  return {
    light: {
      primary: hexColor,
      primaryForeground: foreground,
      ring: hexColor,
    },
    dark: {
      primary: hexColor,
      primaryForeground: foreground,
      ring: hexColor,
    },
  };
}

function customSecondaryTokens(hexColor: string): Record<ResolvedTheme, SecondaryModeTokens> {
  return {
    light: {
      accent: "color-mix(in srgb, " + hexColor + " 10%, transparent)",
      muted: "color-mix(in srgb, " + hexColor + " 7%, transparent)",
      secondary: "color-mix(in srgb, " + hexColor + " 8%, transparent)",
      sidebar: "color-mix(in srgb, var(--background) 94%, " + hexColor + ")",
      sidebarAccent: "color-mix(in srgb, " + hexColor + " 12%, transparent)",
    },
    dark: {
      accent: "color-mix(in srgb, " + hexColor + " 12%, transparent)",
      muted: "color-mix(in srgb, " + hexColor + " 8%, transparent)",
      secondary: "color-mix(in srgb, " + hexColor + " 10%, transparent)",
      sidebar: "color-mix(in srgb, var(--background) 92%, " + hexColor + ")",
      sidebarAccent: "color-mix(in srgb, " + hexColor + " 14%, transparent)",
    },
  };
}

export function selectPersonalizationSettings(settings: ClientSettings): PersonalizationSettings {
  return {
    backgroundTexture: settings.backgroundTexture,
    customUiAccentColor: settings.customUiAccentColor,
    customUiSecondaryColor: settings.customUiSecondaryColor,
    interfaceContrast: settings.interfaceContrast,
    interfaceDensity: settings.interfaceDensity,
    uiAccentColor: settings.uiAccentColor,
    uiCodeFontSize: settings.uiCodeFontSize,
    uiFontFamily: settings.uiFontFamily,
    uiFontSize: settings.uiFontSize,
    uiMonoFontFamily: settings.uiMonoFontFamily,
    uiSecondaryColor: settings.uiSecondaryColor,
  };
}

export function selectTerminalTypographySettings(
  settings: ClientSettings,
): TerminalTypographySettings {
  return {
    uiCodeFontSize: settings.uiCodeFontSize,
    uiMonoFontFamily: settings.uiMonoFontFamily,
  };
}

function resolveKnownValue<T extends string>(
  value: T,
  fallback: T,
  options: ReadonlyArray<PersonalizationOption<T>>,
): T {
  return options.some((option) => option.value === value) ? value : fallback;
}

export function resolveTerminalTypography(
  settings: TerminalTypographySettings,
): TerminalTypographyTokens {
  const uiCodeFontSize = resolveKnownValue(
    settings.uiCodeFontSize,
    DEFAULT_UI_CODE_FONT_SIZE,
    UI_CODE_FONT_SIZE_OPTIONS,
  );
  const uiMonoFontFamily = resolveKnownValue(
    settings.uiMonoFontFamily,
    DEFAULT_UI_MONO_FONT_FAMILY,
    UI_MONO_FONT_FAMILY_OPTIONS,
  );
  return {
    fontFamily: UI_MONO_FONT_STACKS[uiMonoFontFamily],
    fontSize: TERMINAL_FONT_SIZE_TOKENS[uiCodeFontSize],
  };
}

export function resolvePersonalizationTokens(
  settings: PersonalizationSettings,
  resolvedTheme: ResolvedTheme,
): Record<string, string> {
  const accentColor = resolveKnownValue(
    settings.uiAccentColor,
    DEFAULT_UI_ACCENT_COLOR,
    UI_ACCENT_COLOR_OPTIONS,
  );
  const secondaryColor = resolveKnownValue(
    settings.uiSecondaryColor,
    DEFAULT_UI_SECONDARY_COLOR,
    UI_SECONDARY_COLOR_OPTIONS,
  );
  const interfaceContrast = resolveKnownValue(
    settings.interfaceContrast,
    DEFAULT_INTERFACE_CONTRAST,
    INTERFACE_CONTRAST_OPTIONS,
  );
  const backgroundTexture = resolveKnownValue(
    settings.backgroundTexture,
    DEFAULT_BACKGROUND_TEXTURE,
    BACKGROUND_TEXTURE_OPTIONS,
  );
  const uiCodeFontSize = resolveKnownValue(
    settings.uiCodeFontSize,
    DEFAULT_UI_CODE_FONT_SIZE,
    UI_CODE_FONT_SIZE_OPTIONS,
  );
  const uiFontFamily = resolveKnownValue(
    settings.uiFontFamily,
    DEFAULT_UI_FONT_FAMILY,
    UI_FONT_FAMILY_OPTIONS,
  );
  const uiFontSize = resolveKnownValue(
    settings.uiFontSize,
    DEFAULT_UI_FONT_SIZE,
    UI_FONT_SIZE_OPTIONS,
  );
  const uiMonoFontFamily = resolveKnownValue(
    settings.uiMonoFontFamily,
    DEFAULT_UI_MONO_FONT_FAMILY,
    UI_MONO_FONT_FAMILY_OPTIONS,
  );
  const customAccentColor = normalizeHexColor(
    settings.customUiAccentColor,
    DEFAULT_CUSTOM_UI_ACCENT_COLOR,
  );
  const customSecondaryColor = normalizeHexColor(
    settings.customUiSecondaryColor,
    DEFAULT_CUSTOM_UI_SECONDARY_COLOR,
  );

  const accent =
    accentColor === "custom"
      ? customAccentTokens(customAccentColor)[resolvedTheme]
      : ACCENT_TOKENS[accentColor][resolvedTheme];
  const secondary =
    secondaryColor === "custom"
      ? customSecondaryTokens(customSecondaryColor)[resolvedTheme]
      : SECONDARY_TOKENS[secondaryColor][resolvedTheme];
  const contrast = CONTRAST_TOKENS[interfaceContrast][resolvedTheme];
  const foreground = resolvedTheme === "dark" ? DARK_FOREGROUND : LIGHT_FOREGROUND;

  return {
    "--accent": secondary.accent,
    "--accent-foreground": foreground,
    "--app-code-font-scale": UI_CODE_FONT_SCALE_TOKENS[uiCodeFontSize],
    "--app-root-font-size": UI_FONT_SIZE_TOKENS[uiFontSize],
    "--app-terminal-font-size": TERMINAL_FONT_SIZE_TOKENS[uiCodeFontSize] + "px",
    "--app-texture-opacity": TEXTURE_OPACITY[backgroundTexture],
    "--border": contrast.border,
    "--font-mono": UI_MONO_FONT_STACKS[uiMonoFontFamily],
    "--font-sans": UI_FONT_STACKS[uiFontFamily],
    "--input": contrast.input,
    "--muted": secondary.muted,
    "--muted-foreground": contrast.mutedForeground,
    "--primary": accent.primary,
    "--primary-foreground": accent.primaryForeground,
    "--ring": accent.ring,
    "--secondary": secondary.secondary,
    "--secondary-foreground": foreground,
    "--sidebar": secondary.sidebar,
    "--sidebar-accent": secondary.sidebarAccent,
    "--sidebar-accent-foreground": foreground,
    "--sidebar-border": contrast.sidebarBorder,
    "--sidebar-foreground": foreground,
  };
}

export function applyPersonalizationSettings(
  settings: PersonalizationSettings,
  resolvedTheme: ResolvedTheme,
): void {
  if (typeof document === "undefined") return;

  const root = document.documentElement;
  const tokens = resolvePersonalizationTokens(settings, resolvedTheme);
  for (const [property, value] of Object.entries(tokens)) {
    root.style.setProperty(property, value);
  }

  root.dataset.backgroundTexture = settings.backgroundTexture;
  root.dataset.interfaceContrast = settings.interfaceContrast;
  root.dataset.interfaceDensity = resolveKnownValue(
    settings.interfaceDensity,
    DEFAULT_INTERFACE_DENSITY,
    INTERFACE_DENSITY_OPTIONS,
  );
  root.dataset.uiAccentColor = settings.uiAccentColor;
  root.dataset.uiCodeFontSize = settings.uiCodeFontSize;
  root.dataset.uiFontFamily = settings.uiFontFamily;
  root.dataset.uiFontSize = settings.uiFontSize;
  root.dataset.uiMonoFontFamily = settings.uiMonoFontFamily;
  root.dataset.uiSecondaryColor = settings.uiSecondaryColor;
}

export function usePersonalizationSync(): void {
  const settings = useClientSettings(selectPersonalizationSettings);
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    applyPersonalizationSettings(settings, resolvedTheme);
    const frame = window.requestAnimationFrame(() => {
      syncBrowserChromeTheme();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [
    resolvedTheme,
    settings.backgroundTexture,
    settings.customUiAccentColor,
    settings.customUiSecondaryColor,
    settings.interfaceContrast,
    settings.interfaceDensity,
    settings.uiAccentColor,
    settings.uiCodeFontSize,
    settings.uiFontFamily,
    settings.uiFontSize,
    settings.uiMonoFontFamily,
    settings.uiSecondaryColor,
  ]);
}
