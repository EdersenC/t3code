import {
  CheckIcon,
  MessageSquareIcon,
  MonitorIcon,
  MoonIcon,
  PaletteIcon,
  Rows3Icon,
  SparklesIcon,
  SunIcon,
  TypeIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import type {
  BackgroundTexture,
  InterfaceContrast,
  InterfaceDensity,
  UiAccentColor,
  AgentActivityCopyStyle,
  UiCodeFontSize,
  UiFontFamily,
  UiFontSize,
  UiMonoFontFamily,
  UiSecondaryColor,
  ChatStartComposerPlacement,
  ChatSurfaceStyle,
} from "@t3tools/contracts/settings";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";

import { useTheme } from "../../hooks/useTheme";
import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import {
  BACKGROUND_TEXTURE_OPTIONS,
  AGENT_ACTIVITY_COPY_STYLE_OPTIONS,
  CHAT_START_COMPOSER_PLACEMENT_OPTIONS,
  CHAT_SURFACE_STYLE_OPTIONS,
  INTERFACE_CONTRAST_OPTIONS,
  INTERFACE_DENSITY_OPTIONS,
  normalizeHexColor,
  UI_ACCENT_COLOR_OPTIONS,
  UI_CODE_FONT_SIZE_OPTIONS,
  UI_FONT_FAMILY_OPTIONS,
  UI_FONT_SIZE_OPTIONS,
  UI_MONO_FONT_FAMILY_OPTIONS,
  UI_SECONDARY_COLOR_OPTIONS,
  type ColorPaletteOption,
  type PersonalizationOption,
} from "../../personalization";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";

const THEME_OPTIONS = [
  {
    value: "system",
    label: "System",
    icon: MonitorIcon,
  },
  {
    value: "light",
    label: "Light",
    icon: SunIcon,
  },
  {
    value: "dark",
    label: "Dark",
    icon: MoonIcon,
  },
] as const;

type ThemePreference = (typeof THEME_OPTIONS)[number]["value"];

const INVALID_HEX_FALLBACK = "__invalid_hex__";

function optionLabel<T extends string>(
  options: ReadonlyArray<PersonalizationOption<T>>,
  value: T,
): string {
  return options.find((option) => option.value === value)?.label ?? value;
}

function ColorPaletteGrid<T extends string>({
  customColor,
  options,
  value,
  onChange,
}: {
  readonly customColor?: string;
  readonly options: ReadonlyArray<ColorPaletteOption<T>>;
  readonly value: T;
  readonly onChange: (value: T) => void;
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {options.map((option) => {
        const selected = option.value === value;
        const [previewStart, previewEnd] = option.preview;
        const start = option.value === "custom" && customColor ? customColor : previewStart;
        const end = option.value === "custom" && customColor ? customColor : previewEnd;
        return (
          <button
            key={option.value}
            type="button"
            className={cn(
              "group flex min-h-20 min-w-0 cursor-pointer items-center gap-3 rounded-md border px-3 py-2.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
              selected
                ? "border-primary/80 bg-primary/8 text-foreground shadow-xs/5"
                : "border-border/70 bg-background text-foreground hover:bg-accent/60",
            )}
            onClick={() => onChange(option.value)}
            aria-pressed={selected}
          >
            <span
              className="relative flex size-8 shrink-0 items-center justify-center rounded-full border border-black/10 shadow-inner dark:border-white/15"
              style={{
                background: "linear-gradient(135deg, " + start + ", " + (end ?? start) + ")",
              }}
              aria-hidden
            >
              {selected ? (
                <span className="flex size-4 items-center justify-center rounded-full bg-background/90 text-foreground shadow-sm">
                  <CheckIcon className="size-3" />
                </span>
              ) : null}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-semibold text-foreground">
                {option.label}
              </span>
              <span className="mt-0.5 block text-[0.6875rem] leading-snug text-muted-foreground/80">
                {option.description}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function CustomColorPicker({
  fallback,
  label,
  value,
  onChange,
}: {
  readonly fallback: string;
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const normalizedColor = normalizeHexColor(value, fallback);
  const [draft, setDraft] = useState(normalizedColor);

  useEffect(() => {
    setDraft(normalizedColor);
  }, [normalizedColor]);

  const handleDraftChange = (rawValue: string) => {
    setDraft(rawValue);
    const nextColor = normalizeHexColor(rawValue, INVALID_HEX_FALLBACK);
    if (nextColor === INVALID_HEX_FALLBACK) return;
    setDraft(nextColor);
    onChange(nextColor);
  };

  return (
    <div className="mt-3 flex flex-wrap items-center gap-3 rounded-md border border-border/70 bg-card/60 px-3 py-2.5">
      <label className="relative flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full border border-black/10 shadow-inner outline-none focus-within:ring-2 focus-within:ring-ring dark:border-white/15">
        <span
          className="size-full rounded-full"
          style={{ backgroundColor: normalizedColor }}
          aria-hidden
        />
        <input
          aria-label={label + " color wheel"}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
          type="color"
          value={normalizedColor}
          onChange={(event) => handleDraftChange(event.currentTarget.value)}
        />
      </label>
      <Input
        aria-label={label + " hex color"}
        autoCapitalize="none"
        autoCorrect="off"
        className="w-[7.5rem] rounded-md font-mono text-xs sm:w-32"
        inputMode="text"
        maxLength={7}
        nativeInput
        onBlur={() => setDraft(normalizedColor)}
        onChange={(event) => handleDraftChange(event.currentTarget.value)}
        size="sm"
        spellCheck={false}
        value={draft}
      />
    </div>
  );
}

function OptionSelect<T extends string>({
  ariaLabel,
  options,
  value,
  onChange,
}: {
  readonly ariaLabel: string;
  readonly options: ReadonlyArray<PersonalizationOption<T>>;
  readonly value: T;
  readonly onChange: (value: T) => void;
}) {
  return (
    <Select value={value} onValueChange={(next) => onChange(next as T)}>
      <SelectTrigger className="w-full sm:w-44" aria-label={ariaLabel}>
        <SelectValue>{optionLabel(options, value)}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {options.map((option) => (
          <SelectItem hideIndicator key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function ThemeSelect({
  value,
  onChange,
}: {
  readonly value: ThemePreference;
  readonly onChange: (value: ThemePreference) => void;
}) {
  const selected = THEME_OPTIONS.find((option) => option.value === value) ?? THEME_OPTIONS[0];
  const SelectedIcon = selected.icon;

  return (
    <Select
      value={value}
      onValueChange={(next) => {
        if (next === "system" || next === "light" || next === "dark") {
          onChange(next);
        }
      }}
    >
      <SelectTrigger className="w-full sm:w-40" aria-label="Theme preference">
        <SelectValue>
          <span className="inline-flex items-center gap-2">
            <SelectedIcon className="size-3.5" />
            {selected.label}
          </span>
        </SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {THEME_OPTIONS.map((option) => {
          const Icon = option.icon;
          return (
            <SelectItem hideIndicator key={option.value} value={option.value}>
              <span className="inline-flex items-center gap-2">
                <Icon className="size-3.5" />
                {option.label}
              </span>
            </SelectItem>
          );
        })}
      </SelectPopup>
    </Select>
  );
}

function PersonalizationPreview() {
  return (
    <div className="overflow-hidden rounded-md border border-border bg-background text-foreground shadow-sm/5">
      <div className="flex h-9 items-center gap-2 border-b border-border bg-sidebar px-3">
        <span className="size-2.5 rounded-full bg-primary" aria-hidden />
        <span className="h-2 w-24 rounded-full bg-sidebar-accent" aria-hidden />
        <span className="ms-auto h-5 w-12 rounded-md bg-primary" aria-hidden />
      </div>
      <div className="grid grid-cols-[7.5rem_minmax(0,1fr)]">
        <div className="space-y-1.5 border-r border-sidebar-border bg-sidebar p-2">
          <div className="h-6 rounded-md bg-sidebar-accent" />
          <div className="h-5 rounded-md bg-transparent" />
          <div className="h-5 rounded-md bg-transparent" />
        </div>
        <div className="space-y-2 p-3">
          <div className="flex items-center gap-2">
            <span className="h-2.5 w-20 rounded-full bg-foreground/80" />
            <span className="h-2.5 w-12 rounded-full bg-muted" />
          </div>
          <div className="rounded-md border border-border bg-card p-2">
            <div className="mb-2 h-2 w-28 rounded-full bg-muted-foreground/35" />
            <div className="h-2 w-full rounded-full bg-muted" />
            <div className="mt-1.5 h-2 w-3/4 rounded-full bg-muted" />
          </div>
          <div className="flex justify-end gap-1.5">
            <span className="h-6 w-14 rounded-md border border-input bg-popover" />
            <span className="h-6 w-14 rounded-md bg-primary" />
          </div>
        </div>
      </div>
    </div>
  );
}

export function PersonalizationSettingsPanel() {
  const { theme, setTheme } = useTheme();
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();

  return (
    <SettingsPageContainer>
      <SettingsSection title="Personalization" icon={<PaletteIcon className="size-3.5" />}>
        <SettingsRow
          title="Theme"
          description="Choose how the app resolves light, dark, and system appearance."
          resetAction={
            theme !== "system" ? (
              <SettingResetButton label="theme" onClick={() => setTheme("system")} />
            ) : null
          }
          control={<ThemeSelect value={theme} onChange={setTheme} />}
        />

        <SettingsRow
          title="Accent palette"
          description="Sets the primary action color, focus rings, active controls, and command emphasis."
          resetAction={
            settings.uiAccentColor !== DEFAULT_UNIFIED_SETTINGS.uiAccentColor ||
            settings.customUiAccentColor !== DEFAULT_UNIFIED_SETTINGS.customUiAccentColor ? (
              <SettingResetButton
                label="accent palette"
                onClick={() =>
                  updateSettings({
                    customUiAccentColor: DEFAULT_UNIFIED_SETTINGS.customUiAccentColor,
                    uiAccentColor: DEFAULT_UNIFIED_SETTINGS.uiAccentColor,
                  })
                }
              />
            ) : null
          }
        >
          <div className="mt-3 pb-4">
            <ColorPaletteGrid<UiAccentColor>
              customColor={normalizeHexColor(
                settings.customUiAccentColor,
                DEFAULT_UNIFIED_SETTINGS.customUiAccentColor,
              )}
              options={UI_ACCENT_COLOR_OPTIONS}
              value={settings.uiAccentColor}
              onChange={(uiAccentColor) => updateSettings({ uiAccentColor })}
            />
            {settings.uiAccentColor === "custom" ? (
              <CustomColorPicker
                fallback={DEFAULT_UNIFIED_SETTINGS.customUiAccentColor}
                label="Accent"
                value={settings.customUiAccentColor}
                onChange={(customUiAccentColor) =>
                  updateSettings({ customUiAccentColor, uiAccentColor: "custom" })
                }
              />
            ) : null}
          </div>
        </SettingsRow>

        <SettingsRow
          title="Secondary palette"
          description="Tints supporting surfaces like sidebars, hover states, muted chips, and panel chrome."
          resetAction={
            settings.uiSecondaryColor !== DEFAULT_UNIFIED_SETTINGS.uiSecondaryColor ||
            settings.customUiSecondaryColor !== DEFAULT_UNIFIED_SETTINGS.customUiSecondaryColor ? (
              <SettingResetButton
                label="secondary palette"
                onClick={() =>
                  updateSettings({
                    customUiSecondaryColor: DEFAULT_UNIFIED_SETTINGS.customUiSecondaryColor,
                    uiSecondaryColor: DEFAULT_UNIFIED_SETTINGS.uiSecondaryColor,
                  })
                }
              />
            ) : null
          }
        >
          <div className="mt-3 pb-4">
            <ColorPaletteGrid<UiSecondaryColor>
              customColor={normalizeHexColor(
                settings.customUiSecondaryColor,
                DEFAULT_UNIFIED_SETTINGS.customUiSecondaryColor,
              )}
              options={UI_SECONDARY_COLOR_OPTIONS}
              value={settings.uiSecondaryColor}
              onChange={(uiSecondaryColor) => updateSettings({ uiSecondaryColor })}
            />
            {settings.uiSecondaryColor === "custom" ? (
              <CustomColorPicker
                fallback={DEFAULT_UNIFIED_SETTINGS.customUiSecondaryColor}
                label="Secondary"
                value={settings.customUiSecondaryColor}
                onChange={(customUiSecondaryColor) =>
                  updateSettings({ customUiSecondaryColor, uiSecondaryColor: "custom" })
                }
              />
            ) : null}
          </div>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Typography" icon={<TypeIcon className="size-3.5" />}>
        <SettingsRow
          title="Interface font"
          description="Changes the font used for navigation, settings, and conversation text."
          resetAction={
            settings.uiFontFamily !== DEFAULT_UNIFIED_SETTINGS.uiFontFamily ? (
              <SettingResetButton
                label="interface font"
                onClick={() =>
                  updateSettings({ uiFontFamily: DEFAULT_UNIFIED_SETTINGS.uiFontFamily })
                }
              />
            ) : null
          }
          control={
            <OptionSelect<UiFontFamily>
              ariaLabel="Interface font"
              options={UI_FONT_FAMILY_OPTIONS}
              value={settings.uiFontFamily}
              onChange={(uiFontFamily) => updateSettings({ uiFontFamily })}
            />
          }
        />

        <SettingsRow
          title="Monospace font"
          description="Changes code, inline technical values, and terminal text."
          resetAction={
            settings.uiMonoFontFamily !== DEFAULT_UNIFIED_SETTINGS.uiMonoFontFamily ? (
              <SettingResetButton
                label="monospace font"
                onClick={() =>
                  updateSettings({ uiMonoFontFamily: DEFAULT_UNIFIED_SETTINGS.uiMonoFontFamily })
                }
              />
            ) : null
          }
          control={
            <OptionSelect<UiMonoFontFamily>
              ariaLabel="Monospace font"
              options={UI_MONO_FONT_FAMILY_OPTIONS}
              value={settings.uiMonoFontFamily}
              onChange={(uiMonoFontFamily) => updateSettings({ uiMonoFontFamily })}
            />
          }
        />

        <SettingsRow
          title="Interface size"
          description="Scales global interface text without changing row density."
          resetAction={
            settings.uiFontSize !== DEFAULT_UNIFIED_SETTINGS.uiFontSize ? (
              <SettingResetButton
                label="interface size"
                onClick={() => updateSettings({ uiFontSize: DEFAULT_UNIFIED_SETTINGS.uiFontSize })}
              />
            ) : null
          }
          control={
            <OptionSelect<UiFontSize>
              ariaLabel="Interface size"
              options={UI_FONT_SIZE_OPTIONS}
              value={settings.uiFontSize}
              onChange={(uiFontSize) => updateSettings({ uiFontSize })}
            />
          }
        />

        <SettingsRow
          title="Code size"
          description="Scales code blocks, inline code, and embedded terminal text."
          resetAction={
            settings.uiCodeFontSize !== DEFAULT_UNIFIED_SETTINGS.uiCodeFontSize ? (
              <SettingResetButton
                label="code size"
                onClick={() =>
                  updateSettings({ uiCodeFontSize: DEFAULT_UNIFIED_SETTINGS.uiCodeFontSize })
                }
              />
            ) : null
          }
          control={
            <OptionSelect<UiCodeFontSize>
              ariaLabel="Code size"
              options={UI_CODE_FONT_SIZE_OPTIONS}
              value={settings.uiCodeFontSize}
              onChange={(uiCodeFontSize) => updateSettings({ uiCodeFontSize })}
            />
          }
        />
      </SettingsSection>

      <SettingsSection title="Interface" icon={<Rows3Icon className="size-3.5" />}>
        <SettingsRow
          title="Density"
          description="Adjusts sidebar rows, settings rows, and top chrome spacing."
          resetAction={
            settings.interfaceDensity !== DEFAULT_UNIFIED_SETTINGS.interfaceDensity ? (
              <SettingResetButton
                label="interface density"
                onClick={() =>
                  updateSettings({ interfaceDensity: DEFAULT_UNIFIED_SETTINGS.interfaceDensity })
                }
              />
            ) : null
          }
          control={
            <OptionSelect<InterfaceDensity>
              ariaLabel="Interface density"
              options={INTERFACE_DENSITY_OPTIONS}
              value={settings.interfaceDensity}
              onChange={(interfaceDensity) => updateSettings({ interfaceDensity })}
            />
          }
        />

        <SettingsRow
          title="Contrast"
          description="Strengthens borders and secondary text when you want clearer separation."
          resetAction={
            settings.interfaceContrast !== DEFAULT_UNIFIED_SETTINGS.interfaceContrast ? (
              <SettingResetButton
                label="interface contrast"
                onClick={() =>
                  updateSettings({ interfaceContrast: DEFAULT_UNIFIED_SETTINGS.interfaceContrast })
                }
              />
            ) : null
          }
          control={
            <OptionSelect<InterfaceContrast>
              ariaLabel="Interface contrast"
              options={INTERFACE_CONTRAST_OPTIONS}
              value={settings.interfaceContrast}
              onChange={(interfaceContrast) => updateSettings({ interfaceContrast })}
            />
          }
        />

        <SettingsRow
          title="Background texture"
          description="Controls the subtle grain overlay on large empty surfaces."
          resetAction={
            settings.backgroundTexture !== DEFAULT_UNIFIED_SETTINGS.backgroundTexture ? (
              <SettingResetButton
                label="background texture"
                onClick={() =>
                  updateSettings({ backgroundTexture: DEFAULT_UNIFIED_SETTINGS.backgroundTexture })
                }
              />
            ) : null
          }
          control={
            <OptionSelect<BackgroundTexture>
              ariaLabel="Background texture"
              options={BACKGROUND_TEXTURE_OPTIONS}
              value={settings.backgroundTexture}
              onChange={(backgroundTexture) => updateSettings({ backgroundTexture })}
            />
          }
        />
      </SettingsSection>

      <SettingsSection title="Chat experience" icon={<MessageSquareIcon className="size-3.5" />}>
        <SettingsRow
          title="Chat surface"
          description="Changes the conversation background and composer chrome."
          resetAction={
            settings.chatSurfaceStyle !== DEFAULT_UNIFIED_SETTINGS.chatSurfaceStyle ? (
              <SettingResetButton
                label="chat surface"
                onClick={() =>
                  updateSettings({ chatSurfaceStyle: DEFAULT_UNIFIED_SETTINGS.chatSurfaceStyle })
                }
              />
            ) : null
          }
          control={
            <OptionSelect<ChatSurfaceStyle>
              ariaLabel="Chat surface"
              options={CHAT_SURFACE_STYLE_OPTIONS}
              value={settings.chatSurfaceStyle}
              onChange={(chatSurfaceStyle) => updateSettings({ chatSurfaceStyle })}
            />
          }
        />

        <SettingsRow
          title="New chat composer"
          description="Choose whether a fresh thread opens with the composer centered or anchored."
          resetAction={
            settings.chatStartComposerPlacement !==
            DEFAULT_UNIFIED_SETTINGS.chatStartComposerPlacement ? (
              <SettingResetButton
                label="new chat composer"
                onClick={() =>
                  updateSettings({
                    chatStartComposerPlacement: DEFAULT_UNIFIED_SETTINGS.chatStartComposerPlacement,
                  })
                }
              />
            ) : null
          }
          control={
            <OptionSelect<ChatStartComposerPlacement>
              ariaLabel="New chat composer placement"
              options={CHAT_START_COMPOSER_PLACEMENT_OPTIONS}
              value={settings.chatStartComposerPlacement}
              onChange={(chatStartComposerPlacement) =>
                updateSettings({ chatStartComposerPlacement })
              }
            />
          }
        />

        <SettingsRow
          title="Prompt suggestions"
          description="Shows a project-aware starter line on new chats."
          resetAction={
            settings.chatPromptSuggestions !== DEFAULT_UNIFIED_SETTINGS.chatPromptSuggestions ? (
              <SettingResetButton
                label="prompt suggestions"
                onClick={() =>
                  updateSettings({
                    chatPromptSuggestions: DEFAULT_UNIFIED_SETTINGS.chatPromptSuggestions,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              aria-label="Prompt suggestions"
              checked={settings.chatPromptSuggestions}
              onCheckedChange={(chatPromptSuggestions) => updateSettings({ chatPromptSuggestions })}
            />
          }
        />

        <SettingsRow
          title="Activity language"
          description="Controls the short status text shown while an agent is running."
          resetAction={
            settings.agentActivityCopyStyle !== DEFAULT_UNIFIED_SETTINGS.agentActivityCopyStyle ? (
              <SettingResetButton
                label="activity language"
                onClick={() =>
                  updateSettings({
                    agentActivityCopyStyle: DEFAULT_UNIFIED_SETTINGS.agentActivityCopyStyle,
                  })
                }
              />
            ) : null
          }
          control={
            <OptionSelect<AgentActivityCopyStyle>
              ariaLabel="Activity language"
              options={AGENT_ACTIVITY_COPY_STYLE_OPTIONS}
              value={settings.agentActivityCopyStyle}
              onChange={(agentActivityCopyStyle) => updateSettings({ agentActivityCopyStyle })}
            />
          }
        />
      </SettingsSection>

      <SettingsSection title="Preview" icon={<SparklesIcon className="size-3.5" />}>
        <SettingsRow
          title="Live surface"
          description="A small read on the active palette, typography, density, and contrast."
        >
          <div className="mt-3 pb-4">
            <PersonalizationPreview />
          </div>
        </SettingsRow>
      </SettingsSection>
    </SettingsPageContainer>
  );
}
