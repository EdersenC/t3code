import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { PositiveInt, TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";
import {
  DEFAULT_GIT_TEXT_GENERATION_MODEL,
  DEFAULT_GROQ_MODEL,
  DEFAULT_OLLAMA_MODEL,
  ProviderOptionSelections,
} from "./model.ts";
import { ModelSelection } from "./orchestration.ts";
import { ProviderInstanceConfig, ProviderInstanceId } from "./providerInstance.ts";
import { T3CapabilityRegistrySettings, T3CapabilityRegistrySettingsPatch } from "./capability.ts";

// ── Client Settings (local-only) ───────────────────────────────

export const TimestampFormat = Schema.Literals(["locale", "12-hour", "24-hour"]);
export type TimestampFormat = typeof TimestampFormat.Type;
export const DEFAULT_TIMESTAMP_FORMAT: TimestampFormat = "locale";

export const DEFAULT_LOCAL_CONTEXT_WINDOW = 4096;
export const DEFAULT_LOCAL_OUTPUT_TOKEN_LIMIT = 256;

export const SidebarProjectSortOrder = Schema.Literals(["updated_at", "created_at", "manual"]);
export type SidebarProjectSortOrder = typeof SidebarProjectSortOrder.Type;
export const DEFAULT_SIDEBAR_PROJECT_SORT_ORDER: SidebarProjectSortOrder = "updated_at";

export const SidebarThreadSortOrder = Schema.Literals(["updated_at", "created_at"]);
export type SidebarThreadSortOrder = typeof SidebarThreadSortOrder.Type;
export const DEFAULT_SIDEBAR_THREAD_SORT_ORDER: SidebarThreadSortOrder = "updated_at";

export const SidebarProjectGroupingMode = Schema.Literals([
  "repository",
  "repository_path",
  "separate",
]);
export type SidebarProjectGroupingMode = typeof SidebarProjectGroupingMode.Type;
export const DEFAULT_SIDEBAR_PROJECT_GROUPING_MODE: SidebarProjectGroupingMode = "repository";
export const MIN_SIDEBAR_THREAD_PREVIEW_COUNT = 1;
export const MAX_SIDEBAR_THREAD_PREVIEW_COUNT = 15;
export const SidebarThreadPreviewCount = Schema.Int.check(
  Schema.isBetween({
    minimum: MIN_SIDEBAR_THREAD_PREVIEW_COUNT,
    maximum: MAX_SIDEBAR_THREAD_PREVIEW_COUNT,
  }),
);
export type SidebarThreadPreviewCount = typeof SidebarThreadPreviewCount.Type;
export const DEFAULT_SIDEBAR_THREAD_PREVIEW_COUNT: SidebarThreadPreviewCount = 6;

export const UiAccentColor = Schema.Literals([
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
export type UiAccentColor = typeof UiAccentColor.Type;
export const DEFAULT_UI_ACCENT_COLOR: UiAccentColor = "blue";

export const UiSecondaryColor = Schema.Literals([
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
export type UiSecondaryColor = typeof UiSecondaryColor.Type;
export const DEFAULT_UI_SECONDARY_COLOR: UiSecondaryColor = "neutral";
export const DEFAULT_CUSTOM_UI_ACCENT_COLOR = "#2563eb";
export const DEFAULT_CUSTOM_UI_SECONDARY_COLOR = "#64748b";

const HEX_COLOR_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

function normalizeHexColorSetting(value: string, fallback: string): string {
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

const makeHexColorSetting = (fallback: string) =>
  TrimmedString.pipe(
    Schema.decodeTo(
      Schema.String,
      SchemaTransformation.transformOrFail({
        decode: (value) => Effect.succeed(normalizeHexColorSetting(value, fallback)),
        encode: (value) => Effect.succeed(normalizeHexColorSetting(value, fallback)),
      }),
    ),
  );

export const UiFontFamily = Schema.Literals(["dm-sans", "system", "serif", "mono"]);
export type UiFontFamily = typeof UiFontFamily.Type;
export const DEFAULT_UI_FONT_FAMILY: UiFontFamily = "dm-sans";

export const UiMonoFontFamily = Schema.Literals([
  "jetbrains-mono",
  "system",
  "sf-mono",
  "monospace",
]);
export type UiMonoFontFamily = typeof UiMonoFontFamily.Type;
export const DEFAULT_UI_MONO_FONT_FAMILY: UiMonoFontFamily = "jetbrains-mono";

export const UiFontSize = Schema.Literals(["small", "default", "large", "extra-large"]);
export type UiFontSize = typeof UiFontSize.Type;
export const DEFAULT_UI_FONT_SIZE: UiFontSize = "default";

export const UiCodeFontSize = Schema.Literals(["small", "default", "large"]);
export type UiCodeFontSize = typeof UiCodeFontSize.Type;
export const DEFAULT_UI_CODE_FONT_SIZE: UiCodeFontSize = "default";

export const InterfaceDensity = Schema.Literals(["compact", "comfortable", "spacious"]);
export type InterfaceDensity = typeof InterfaceDensity.Type;
export const DEFAULT_INTERFACE_DENSITY: InterfaceDensity = "comfortable";

export const InterfaceContrast = Schema.Literals(["standard", "high"]);
export type InterfaceContrast = typeof InterfaceContrast.Type;
export const DEFAULT_INTERFACE_CONTRAST: InterfaceContrast = "standard";

export const BackgroundTexture = Schema.Literals(["none", "subtle", "visible"]);
export type BackgroundTexture = typeof BackgroundTexture.Type;
export const DEFAULT_BACKGROUND_TEXTURE: BackgroundTexture = "subtle";

export const ChatSurfaceStyle = Schema.Literals(["soft", "flat", "crisp"]);
export type ChatSurfaceStyle = typeof ChatSurfaceStyle.Type;
export const DEFAULT_CHAT_SURFACE_STYLE: ChatSurfaceStyle = "soft";

export const ChatStartComposerPlacement = Schema.Literals(["center", "bottom"]);
export type ChatStartComposerPlacement = typeof ChatStartComposerPlacement.Type;
export const DEFAULT_CHAT_START_COMPOSER_PLACEMENT: ChatStartComposerPlacement = "center";

export const AgentActivityCopyStyle = Schema.Literals(["lively", "plain"]);
export type AgentActivityCopyStyle = typeof AgentActivityCopyStyle.Type;
export const DEFAULT_AGENT_ACTIVITY_COPY_STYLE: AgentActivityCopyStyle = "lively";

export const ClientSettingsSchema = Schema.Struct({
  agentActivityCopyStyle: AgentActivityCopyStyle.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_AGENT_ACTIVITY_COPY_STYLE)),
  ),
  autoOpenPlanSidebar: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  backgroundTexture: BackgroundTexture.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_BACKGROUND_TEXTURE)),
  ),
  chatPromptSuggestions: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  chatStartComposerPlacement: ChatStartComposerPlacement.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_CHAT_START_COMPOSER_PLACEMENT)),
  ),
  chatSurfaceStyle: ChatSurfaceStyle.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_CHAT_SURFACE_STYLE)),
  ),
  customUiAccentColor: makeHexColorSetting(DEFAULT_CUSTOM_UI_ACCENT_COLOR).pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_CUSTOM_UI_ACCENT_COLOR)),
  ),
  customUiSecondaryColor: makeHexColorSetting(DEFAULT_CUSTOM_UI_SECONDARY_COLOR).pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_CUSTOM_UI_SECONDARY_COLOR)),
  ),
  confirmThreadArchive: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  confirmThreadDelete: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  dismissedProviderUpdateNotificationKeys: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  diffIgnoreWhitespace: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  // Model favorites. Historically keyed by provider kind, now
  // widened to `ProviderInstanceId` so users can favorite a specific model
  // on a custom provider instance (e.g. "Codex Personal · gpt-5") without
  // the UI collapsing it into the same bucket as the default Codex. The
  // widening is backward-compatible by construction: prior provider-kind
  // strings satisfy the `ProviderInstanceId` slug schema, so previously
  // persisted favorites decode unchanged and continue to point at the
  // default instance for their kind (because `defaultInstanceIdForDriver(kind)`
  // uses the same slug). The field name is kept as `provider` for storage
  // stability; new call sites should treat the value as an instance id.
  favorites: Schema.Array(
    Schema.Struct({
      provider: ProviderInstanceId,
      model: TrimmedNonEmptyString,
    }),
  ).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  providerModelPreferences: Schema.Record(
    ProviderInstanceId,
    Schema.Struct({
      hiddenModels: Schema.Array(Schema.String).pipe(
        Schema.withDecodingDefault(Effect.succeed([])),
      ),
      modelOrder: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
    }),
  ).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  interfaceContrast: InterfaceContrast.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_INTERFACE_CONTRAST)),
  ),
  interfaceDensity: InterfaceDensity.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_INTERFACE_DENSITY)),
  ),
  sidebarProjectGroupingMode: SidebarProjectGroupingMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_PROJECT_GROUPING_MODE)),
  ),
  sidebarProjectGroupingOverrides: Schema.Record(
    TrimmedNonEmptyString,
    SidebarProjectGroupingMode,
  ).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  sidebarProjectSortOrder: SidebarProjectSortOrder.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_PROJECT_SORT_ORDER)),
  ),
  sidebarThreadSortOrder: SidebarThreadSortOrder.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_THREAD_SORT_ORDER)),
  ),
  sidebarThreadPreviewCount: SidebarThreadPreviewCount.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_THREAD_PREVIEW_COUNT)),
  ),
  timestampFormat: TimestampFormat.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_TIMESTAMP_FORMAT)),
  ),
  uiAccentColor: UiAccentColor.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_UI_ACCENT_COLOR)),
  ),
  uiCodeFontSize: UiCodeFontSize.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_UI_CODE_FONT_SIZE)),
  ),
  uiFontFamily: UiFontFamily.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_UI_FONT_FAMILY)),
  ),
  uiFontSize: UiFontSize.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_UI_FONT_SIZE))),
  uiMonoFontFamily: UiMonoFontFamily.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_UI_MONO_FONT_FAMILY)),
  ),
  uiSecondaryColor: UiSecondaryColor.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_UI_SECONDARY_COLOR)),
  ),
  wordWrap: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
});
export type ClientSettings = typeof ClientSettingsSchema.Type;

export const DEFAULT_CLIENT_SETTINGS: ClientSettings = Schema.decodeSync(ClientSettingsSchema)({});

// ── Server Settings (server-authoritative) ────────────────────

export const ThreadEnvMode = Schema.Literals(["local", "worktree"]);
export type ThreadEnvMode = typeof ThreadEnvMode.Type;

const makeBinaryPathSetting = (fallback: string) =>
  TrimmedString.pipe(
    Schema.decodeTo(
      Schema.String,
      SchemaTransformation.transformOrFail({
        decode: (value) => Effect.succeed(value || fallback),
        encode: (value) => Effect.succeed(value),
      }),
    ),
    Schema.withDecodingDefault(Effect.succeed(fallback)),
  );

export type ProviderSettingsFormControl = "text" | "password" | "textarea" | "switch" | "number";

export interface ProviderSettingsFormAnnotation {
  readonly control?: ProviderSettingsFormControl | undefined;
  readonly placeholder?: string | undefined;
  readonly hidden?: boolean | undefined;
  readonly clearWhenEmpty?: "omit" | "persist" | undefined;
}

export interface ProviderSettingsFormSchemaAnnotation {
  readonly order?: readonly string[] | undefined;
}

declare module "effect/Schema" {
  namespace Annotations {
    interface Annotations {
      readonly providerSettingsForm?: ProviderSettingsFormAnnotation | undefined;
      readonly providerSettingsFormSchema?: ProviderSettingsFormSchemaAnnotation | undefined;
    }
  }
}

export type ProviderSettingsOrder<Fields extends Schema.Struct.Fields> = readonly Extract<
  keyof Fields,
  string
>[];

export function makeProviderSettingsSchema<const Fields extends Schema.Struct.Fields>(
  fields: Fields,
  options?: {
    readonly order?: ProviderSettingsOrder<Fields> | undefined;
  },
): Schema.Struct<Fields> {
  return Schema.Struct(fields).pipe(
    Schema.annotate({
      providerSettingsFormSchema:
        options?.order === undefined ? undefined : { order: options.order },
    }),
  );
}

export const CodexSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("codex").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the Codex binary used by this instance.",
        providerSettingsForm: { placeholder: "codex", clearWhenEmpty: "omit" },
      }),
    ),
    homePath: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "CODEX_HOME path",
        description: "Custom Codex home and config directory.",
        providerSettingsForm: {
          placeholder: "~/.codex",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    shadowHomePath: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Shadow home path",
        description:
          "Account-specific Codex home. Keeps auth.json separate while sharing state from CODEX_HOME.",
        providerSettingsForm: {
          placeholder: "~/.codex-t3/personal",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    customModels: Schema.Array(Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["binaryPath", "homePath", "shadowHomePath"],
  },
);
export type CodexSettings = typeof CodexSettings.Type;

export const ClaudeSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("claude").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the Claude binary used by this instance.",
        providerSettingsForm: { placeholder: "claude", clearWhenEmpty: "omit" },
      }),
    ),
    homePath: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Claude HOME path",
        description:
          "Custom HOME used when running this Claude instance. Keeps .claude.json and .claude separate.",
        providerSettingsForm: { placeholder: "~", clearWhenEmpty: "omit" },
      }),
    ),
    customModels: Schema.Array(Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    launchArgs: Schema.String.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Launch arguments",
        description: "Additional CLI arguments passed on session start.",
        providerSettingsForm: {
          placeholder: "e.g. --chrome",
          clearWhenEmpty: "omit",
        },
      }),
    ),
  },
  {
    order: ["binaryPath", "homePath", "launchArgs"],
  },
);
export type ClaudeSettings = typeof ClaudeSettings.Type;

export const CursorSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("agent").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the Cursor agent binary.",
        providerSettingsForm: { placeholder: "agent", clearWhenEmpty: "omit" },
      }),
    ),
    apiEndpoint: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "API endpoint",
        description: "Override the Cursor API endpoint for this instance.",
        providerSettingsForm: {
          placeholder: "https://...",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    customModels: Schema.Array(Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["binaryPath", "apiEndpoint"],
  },
);
export type CursorSettings = typeof CursorSettings.Type;

export const GrokSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("grok").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the Grok CLI binary.",
        providerSettingsForm: { placeholder: "grok", clearWhenEmpty: "omit" },
      }),
    ),
    customModels: Schema.Array(Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["binaryPath"],
  },
);
export type GrokSettings = typeof GrokSettings.Type;

export const DEFAULT_GROQ_BASE_URL = "https://api.groq.com/openai/v1";

export const GroqSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    apiKey: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "API key",
        description: "Groq API key. Can be left blank when GROQ_API_KEY is set.",
        providerSettingsForm: {
          control: "password",
          placeholder: "gsk_...",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    baseUrl: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed(DEFAULT_GROQ_BASE_URL)),
      Schema.annotateKey({
        title: "Base URL",
        description: "OpenAI-compatible Groq endpoint.",
        providerSettingsForm: {
          placeholder: DEFAULT_GROQ_BASE_URL,
          clearWhenEmpty: "omit",
        },
      }),
    ),
    binaryPath: makeBinaryPathSetting("opencode").pipe(
      Schema.annotateKey({
        title: "OpenCode binary path",
        description: "Path to the OpenCode binary used as the Groq harness.",
        providerSettingsForm: {
          placeholder: "opencode",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    customModels: Schema.Array(Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed([DEFAULT_GROQ_MODEL])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["apiKey", "baseUrl", "binaryPath"],
  },
);
export type GroqSettings = typeof GroqSettings.Type;

export const OpenCodeSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("opencode").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the OpenCode binary.",
        providerSettingsForm: {
          placeholder: "opencode",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    serverUrl: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Server URL",
        description: "Leave blank to let T3 Code spawn the server when needed.",
        providerSettingsForm: {
          placeholder: "http://127.0.0.1:4096",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    serverPassword: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Server password",
        description: "Stored in plain text on disk.",
        providerSettingsForm: {
          control: "password",
          placeholder: "Optional",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    customModels: Schema.Array(Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["binaryPath", "serverUrl", "serverPassword"],
  },
);
export type OpenCodeSettings = typeof OpenCodeSettings.Type;

export const OllamaSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    baseUrl: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("http://127.0.0.1:11434")),
      Schema.annotateKey({
        title: "Base URL",
        description: "Local Ollama server URL used by this instance.",
        providerSettingsForm: {
          placeholder: "http://127.0.0.1:11434",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    binaryPath: makeBinaryPathSetting("opencode").pipe(
      Schema.annotateKey({
        title: "OpenCode binary path",
        description: "Path to the OpenCode binary used as the local-model harness.",
        providerSettingsForm: {
          placeholder: "opencode",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    allowCpuFallback: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({
        title: "Accept CPU fallback",
        description:
          "Treat CPU-backed Ollama models as usable when Ollama cannot keep them on GPU. Ollama decides placement; this only controls T3 Code warning and error policy.",
        providerSettingsForm: { control: "switch" },
      }),
    ),
    customModels: Schema.Array(Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed([DEFAULT_OLLAMA_MODEL])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["baseUrl", "binaryPath", "allowCpuFallback"],
  },
);
export type OllamaSettings = typeof OllamaSettings.Type;

export const LocalSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    baseUrl: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("http://127.0.0.1:8018")),
      Schema.annotateKey({
        title: "vLLM base URL",
        description: "OpenAI-compatible vLLM server URL used by this Local instance.",
        providerSettingsForm: {
          placeholder: "http://127.0.0.1:8018",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    binaryPath: makeBinaryPathSetting("opencode").pipe(
      Schema.annotateKey({
        title: "OpenCode binary path",
        description: "Path to the OpenCode binary used as the Local model harness.",
        providerSettingsForm: {
          placeholder: "opencode",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    customModels: Schema.Array(Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    contextWindow: PositiveInt.pipe(
      Schema.withDecodingDefault(Effect.succeed(DEFAULT_LOCAL_CONTEXT_WINDOW)),
      Schema.annotateKey({
        title: "Context window",
        description:
          "Maximum total tokens advertised to OpenCode for Local vLLM models. This should match the vLLM --max-model-len value.",
        providerSettingsForm: {
          control: "number",
          placeholder: String(DEFAULT_LOCAL_CONTEXT_WINDOW),
          clearWhenEmpty: "omit",
        },
      }),
    ),
    outputTokenLimit: PositiveInt.pipe(
      Schema.withDecodingDefault(Effect.succeed(DEFAULT_LOCAL_OUTPUT_TOKEN_LIMIT)),
      Schema.annotateKey({
        title: "Output token limit",
        description:
          "Maximum assistant output tokens advertised to OpenCode for Local vLLM models.",
        providerSettingsForm: {
          control: "number",
          placeholder: String(DEFAULT_LOCAL_OUTPUT_TOKEN_LIMIT),
          clearWhenEmpty: "omit",
        },
      }),
    ),
  },
  {
    order: ["baseUrl", "binaryPath", "contextWindow", "outputTokenLimit"],
  },
);
export type LocalSettings = typeof LocalSettings.Type;

export const ObservabilitySettings = Schema.Struct({
  otlpTracesUrl: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  otlpMetricsUrl: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
});
export type ObservabilitySettings = typeof ObservabilitySettings.Type;

export const LocalModelRuntimeKind = Schema.Literals([
  "vllm",
  "llamacpp",
  "tgi",
  "lmstudio",
  "custom",
]);
export type LocalModelRuntimeKind = typeof LocalModelRuntimeKind.Type;

export const LocalModelRuntimeSettings = Schema.Struct({
  preferredRuntime: LocalModelRuntimeKind.pipe(Schema.withDecodingDefault(Effect.succeed("vllm"))),
  notes: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
});
export type LocalModelRuntimeSettings = typeof LocalModelRuntimeSettings.Type;

export const DEFAULT_AGENTIC_RESOURCE_LIMITS = {
  maxAgentDepth: 8,
  maxChildrenPerAgent: 64,
  maxActiveAgentsPerSession: 64,
  maxToolCallsPerGroup: 32,
  defaultToolGroupTimeoutMs: 120_000,
  maxToolGroupTimeoutMs: 600_000,
} as const;

export const AgenticResourceLimitsSettings = Schema.Struct({
  maxAgentDepth: PositiveInt.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_AGENTIC_RESOURCE_LIMITS.maxAgentDepth)),
  ),
  maxChildrenPerAgent: PositiveInt.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_AGENTIC_RESOURCE_LIMITS.maxChildrenPerAgent)),
  ),
  maxActiveAgentsPerSession: PositiveInt.pipe(
    Schema.withDecodingDefault(
      Effect.succeed(DEFAULT_AGENTIC_RESOURCE_LIMITS.maxActiveAgentsPerSession),
    ),
  ),
  maxToolCallsPerGroup: PositiveInt.pipe(
    Schema.withDecodingDefault(
      Effect.succeed(DEFAULT_AGENTIC_RESOURCE_LIMITS.maxToolCallsPerGroup),
    ),
  ),
  defaultToolGroupTimeoutMs: PositiveInt.pipe(
    Schema.withDecodingDefault(
      Effect.succeed(DEFAULT_AGENTIC_RESOURCE_LIMITS.defaultToolGroupTimeoutMs),
    ),
  ),
  maxToolGroupTimeoutMs: PositiveInt.pipe(
    Schema.withDecodingDefault(
      Effect.succeed(DEFAULT_AGENTIC_RESOURCE_LIMITS.maxToolGroupTimeoutMs),
    ),
  ),
});
export type AgenticResourceLimitsSettings = typeof AgenticResourceLimitsSettings.Type;

export const DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL = Duration.seconds(30);

export const ServerSettings = Schema.Struct({
  enableAssistantStreaming: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  enableProviderUpdateChecks: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  automaticGitFetchInterval: Schema.DurationFromMillis.pipe(
    Schema.withDecodingDefault(
      Effect.succeed(Duration.toMillis(DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL)),
    ),
  ),
  defaultThreadEnvMode: ThreadEnvMode.pipe(
    Schema.withDecodingDefault(Effect.succeed("local" as const satisfies ThreadEnvMode)),
  ),
  newWorktreesStartFromOrigin: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
  addProjectBaseDirectory: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  textGenerationModelSelection: ModelSelection.pipe(
    Schema.withDecodingDefault(
      Effect.succeed({
        instanceId: ProviderInstanceId.make("codex"),
        model: DEFAULT_GIT_TEXT_GENERATION_MODEL,
      }),
    ),
  ),

  // Legacy single-instance-per-driver settings. Continues to be the source
  // of truth until `providerInstances` (below) lands per-driver migration
  // shims and the server starts hydrating instances from it. Driver-specific
  // schemas live here for the duration of the migration; once each driver
  // owns its config in its own package, this struct shrinks to nothing and
  // is removed entirely.
  providers: Schema.Struct({
    codex: CodexSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
    claudeAgent: ClaudeSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
    cursor: CursorSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
    grok: GrokSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
    groq: GroqSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
    opencode: OpenCodeSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
    ollama: OllamaSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
    local: LocalSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  }).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  // New driver-agnostic instance map. Keyed by `ProviderInstanceId`; values
  // are `ProviderInstanceConfig` envelopes. The driver-specific config blob
  // is `Schema.Unknown` at this layer so envelopes with unknown drivers
  // (forks, downgrades, in-flight PR branches) round-trip without loss.
  // See providerInstance.ts for the forward/backward compatibility invariant.
  providerInstances: Schema.Record(ProviderInstanceId, ProviderInstanceConfig).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  observability: ObservabilitySettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  localModelRuntime: LocalModelRuntimeSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  capabilityRegistry: T3CapabilityRegistrySettings.pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  agenticResourceLimits: AgenticResourceLimitsSettings.pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
});
export type ServerSettings = typeof ServerSettings.Type;

export const DEFAULT_SERVER_SETTINGS: ServerSettings = Schema.decodeSync(ServerSettings)({});

export const ServerSettingsOperation = Schema.Literals([
  "normalize",
  "check-exists",
  "read-file",
  "read-secret",
  "remove-secret",
  "remove-stale-secret",
  "write-secret",
  "write-file",
  "prepare-directory",
]);
export type ServerSettingsOperation = typeof ServerSettingsOperation.Type;

export class ServerSettingsError extends Schema.TaggedErrorClass<ServerSettingsError>()(
  "ServerSettingsError",
  {
    settingsPath: Schema.String,
    operation: ServerSettingsOperation,
    providerInstanceId: Schema.optional(Schema.String),
    environmentVariable: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const provider =
      this.providerInstanceId === undefined ? "" : ` for provider ${this.providerInstanceId}`;
    const variable =
      this.environmentVariable === undefined
        ? ""
        : ` and environment variable ${this.environmentVariable}`;
    return `Server settings ${this.operation} failed${provider}${variable} at ${this.settingsPath}.`;
  }
}

// ── Unified type ─────────────────────────────────────────────────────

export type UnifiedSettings = ServerSettings & ClientSettings;
export const DEFAULT_UNIFIED_SETTINGS: UnifiedSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  ...DEFAULT_CLIENT_SETTINGS,
};

// ── Server Settings Patch (replace with a Schema.deepPartial if available) ──────────────────────────────────────────

const ModelSelectionPatch = Schema.Struct({
  instanceId: Schema.optionalKey(ProviderInstanceId),
  model: Schema.optionalKey(TrimmedNonEmptyString),
  options: Schema.optionalKey(ProviderOptionSelections),
});

const CodexSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(TrimmedString),
  homePath: Schema.optionalKey(TrimmedString),
  shadowHomePath: Schema.optionalKey(TrimmedString),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
});

const ClaudeSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(TrimmedString),
  homePath: Schema.optionalKey(TrimmedString),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
  launchArgs: Schema.optionalKey(TrimmedString),
});

const CursorSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(TrimmedString),
  apiEndpoint: Schema.optionalKey(TrimmedString),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
});

const GrokSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(TrimmedString),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
});

const GroqSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  apiKey: Schema.optionalKey(TrimmedString),
  baseUrl: Schema.optionalKey(TrimmedString),
  binaryPath: Schema.optionalKey(TrimmedString),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
});

const OpenCodeSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(TrimmedString),
  serverUrl: Schema.optionalKey(TrimmedString),
  serverPassword: Schema.optionalKey(TrimmedString),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
});

const OllamaSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  baseUrl: Schema.optionalKey(TrimmedString),
  binaryPath: Schema.optionalKey(TrimmedString),
  allowCpuFallback: Schema.optionalKey(Schema.Boolean),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
});

export const ServerSettingsPatch = Schema.Struct({
  // Server settings
  enableAssistantStreaming: Schema.optionalKey(Schema.Boolean),
  enableProviderUpdateChecks: Schema.optionalKey(Schema.Boolean),
  automaticGitFetchInterval: Schema.optionalKey(Schema.DurationFromMillis),
  defaultThreadEnvMode: Schema.optionalKey(ThreadEnvMode),
  newWorktreesStartFromOrigin: Schema.optionalKey(Schema.Boolean),
  addProjectBaseDirectory: Schema.optionalKey(TrimmedString),
  textGenerationModelSelection: Schema.optionalKey(ModelSelectionPatch),
  localModelRuntime: Schema.optionalKey(
    Schema.Struct({
      preferredRuntime: Schema.optionalKey(LocalModelRuntimeKind),
      notes: Schema.optionalKey(TrimmedString),
    }),
  ),
  observability: Schema.optionalKey(
    Schema.Struct({
      otlpTracesUrl: Schema.optionalKey(TrimmedString),
      otlpMetricsUrl: Schema.optionalKey(TrimmedString),
    }),
  ),
  capabilityRegistry: Schema.optionalKey(T3CapabilityRegistrySettingsPatch),
  agenticResourceLimits: Schema.optionalKey(
    Schema.Struct({
      maxAgentDepth: Schema.optionalKey(PositiveInt),
      maxChildrenPerAgent: Schema.optionalKey(PositiveInt),
      maxActiveAgentsPerSession: Schema.optionalKey(PositiveInt),
      maxToolCallsPerGroup: Schema.optionalKey(PositiveInt),
      defaultToolGroupTimeoutMs: Schema.optionalKey(PositiveInt),
      maxToolGroupTimeoutMs: Schema.optionalKey(PositiveInt),
    }),
  ),
  providers: Schema.optionalKey(
    Schema.Struct({
      codex: Schema.optionalKey(CodexSettingsPatch),
      claudeAgent: Schema.optionalKey(ClaudeSettingsPatch),
      cursor: Schema.optionalKey(CursorSettingsPatch),
      grok: Schema.optionalKey(GrokSettingsPatch),
      groq: Schema.optionalKey(GroqSettingsPatch),
      opencode: Schema.optionalKey(OpenCodeSettingsPatch),
      ollama: Schema.optionalKey(OllamaSettingsPatch),
    }),
  ),
  // Whole-map replacement for the new instance config. Patching individual
  // entries is intentionally out of scope: the map is small, and partial
  // patches risk leaving driver-specific config in a half-merged state.
  // The web UI sends a fully-formed map every time it edits this field.
  providerInstances: Schema.optionalKey(Schema.Record(ProviderInstanceId, ProviderInstanceConfig)),
});
export type ServerSettingsPatch = typeof ServerSettingsPatch.Type;

export const ClientSettingsPatch = Schema.Struct({
  agentActivityCopyStyle: Schema.optionalKey(AgentActivityCopyStyle),
  autoOpenPlanSidebar: Schema.optionalKey(Schema.Boolean),
  backgroundTexture: Schema.optionalKey(BackgroundTexture),
  chatPromptSuggestions: Schema.optionalKey(Schema.Boolean),
  chatStartComposerPlacement: Schema.optionalKey(ChatStartComposerPlacement),
  chatSurfaceStyle: Schema.optionalKey(ChatSurfaceStyle),
  customUiAccentColor: Schema.optionalKey(makeHexColorSetting(DEFAULT_CUSTOM_UI_ACCENT_COLOR)),
  customUiSecondaryColor: Schema.optionalKey(
    makeHexColorSetting(DEFAULT_CUSTOM_UI_SECONDARY_COLOR),
  ),
  confirmThreadArchive: Schema.optionalKey(Schema.Boolean),
  confirmThreadDelete: Schema.optionalKey(Schema.Boolean),
  diffIgnoreWhitespace: Schema.optionalKey(Schema.Boolean),
  favorites: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        provider: ProviderInstanceId,
        model: TrimmedNonEmptyString,
      }),
    ),
  ),
  providerModelPreferences: Schema.optionalKey(
    Schema.Record(
      ProviderInstanceId,
      Schema.Struct({
        hiddenModels: Schema.Array(Schema.String).pipe(
          Schema.withDecodingDefault(Effect.succeed([])),
        ),
        modelOrder: Schema.Array(Schema.String).pipe(
          Schema.withDecodingDefault(Effect.succeed([])),
        ),
      }),
    ),
  ),
  interfaceContrast: Schema.optionalKey(InterfaceContrast),
  interfaceDensity: Schema.optionalKey(InterfaceDensity),
  sidebarProjectGroupingMode: Schema.optionalKey(SidebarProjectGroupingMode),
  sidebarProjectGroupingOverrides: Schema.optionalKey(
    Schema.Record(TrimmedNonEmptyString, SidebarProjectGroupingMode),
  ),
  sidebarProjectSortOrder: Schema.optionalKey(SidebarProjectSortOrder),
  sidebarThreadSortOrder: Schema.optionalKey(SidebarThreadSortOrder),
  sidebarThreadPreviewCount: Schema.optionalKey(SidebarThreadPreviewCount),
  timestampFormat: Schema.optionalKey(TimestampFormat),
  uiAccentColor: Schema.optionalKey(UiAccentColor),
  uiCodeFontSize: Schema.optionalKey(UiCodeFontSize),
  uiFontFamily: Schema.optionalKey(UiFontFamily),
  uiFontSize: Schema.optionalKey(UiFontSize),
  uiMonoFontFamily: Schema.optionalKey(UiMonoFontFamily),
  uiSecondaryColor: Schema.optionalKey(UiSecondaryColor),
  wordWrap: Schema.optionalKey(Schema.Boolean),
});
export type ClientSettingsPatch = typeof ClientSettingsPatch.Type;
