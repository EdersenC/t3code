import {
  EMPTY_T3_CAPABILITY_SNAPSHOT,
  type ServerProvider,
  type ServerProviderSkill,
  type ServerSettings,
  type T3CapabilityActivation,
  type T3CapabilityOverride,
  type T3CapabilitySnapshot,
  type T3CapabilitySnapshotEntry,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";

export type OpenCodeSkillPermissionAction = "allow" | "deny";

export interface OpenCodeCapabilityRuntime {
  readonly skillPaths: ReadonlyArray<string>;
  readonly skillPermissions: Readonly<Record<string, OpenCodeSkillPermissionAction>>;
  readonly preloadSystemPrompt?: string;
}

export interface T3CapabilityDefinition extends T3CapabilitySnapshotEntry {
  readonly content?: string;
  readonly preloadText?: string;
}

export interface T3CapabilityRegistry {
  readonly definitions: ReadonlyArray<T3CapabilityDefinition>;
  readonly snapshot: T3CapabilitySnapshot;
  readonly preloadSystemPrompt?: string;
}

export class T3CapabilityRegistryError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(message);
    this.name = "T3CapabilityRegistryError";
    this.path = path;
  }
}

const VALID_SKILL_NAME = /^[a-z][a-z0-9_-]{0,63}$/;
const ACTIVATIONS = new Set<T3CapabilityActivation>(["preload", "on-demand", "command", "hidden"]);

function activationAllowedForKind(
  kind: T3CapabilityDefinition["kind"],
  activation: T3CapabilityActivation,
): boolean {
  switch (kind) {
    case "skill":
      return activation === "preload" || activation === "on-demand" || activation === "hidden";
    case "slash-command":
      return activation === "command" || activation === "hidden";
    case "tool":
    case "subagent":
      return activation === "on-demand" || activation === "hidden";
  }
}

const BUILT_IN_CAPABILITIES: ReadonlyArray<T3CapabilityDefinition> = [
  {
    id: "t3:tool:subagent",
    name: "t3_subagent",
    kind: "tool",
    activation: "on-demand",
    source: "t3",
    enabled: true,
    readonly: false,
    displayName: "Subagent",
    shortDescription: "Run a T3-owned subagent for a focused task.",
    description:
      "T3-owned callable tool for delegating scoped work to a general-purpose child agent through the shared MCP bridge.",
    sourceDetail: "built-in:subagent",
    toolName: "t3_subagent",
  },
  {
    id: "t3:skill:random-subagent-test",
    name: "random-subagent-test",
    kind: "skill",
    activation: "on-demand",
    source: "t3",
    enabled: true,
    readonly: true,
    displayName: "Random Subagent Test",
    shortDescription: "Verify T3 subagent wiring with a harmless random task.",
    description: "Call t3_subagent with a deliberately random, low-risk verification task.",
    sourceDetail: "built-in:skill",
    content: [
      "Use this only to verify that the T3 Subagent MCP tool works end to end.",
      "",
      "Call `t3_subagent` with a short, harmless, deliberately random task.",
      "Ask the subagent to avoid file edits and network calls unless the user explicitly asks for them.",
      "After the call returns, show the parent user the child thread id, the original input, and the full output.",
    ].join("\n"),
  },
  {
    id: "t3:command:tools",
    name: "tools",
    kind: "slash-command",
    activation: "command",
    source: "t3",
    enabled: true,
    readonly: false,
    displayName: "Subagent",
    shortDescription: "Open the T3 subagent registry.",
    description: "T3-owned command capability for the subagent tool surface.",
    sourceDetail: "built-in",
    commandName: "tools",
  },
];

function normalizePath(input: string, cwd: string): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  if (input === "~") return home;
  if (input.startsWith("~/")) return `${home}/${input.slice(2)}`;
  return input.startsWith("/") ? input : `${cwd}/${input}`;
}

function parseFrontmatter(raw: string): {
  readonly metadata: Readonly<Record<string, string>>;
  readonly body: string;
} {
  const normalized = raw.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { metadata: {}, body: normalized.trim() };
  }

  const end = normalized.indexOf("\n---", 4);
  if (end === -1) {
    return { metadata: {}, body: normalized.trim() };
  }

  const frontmatter = normalized.slice(4, end).trim();
  const bodyStart = normalized.indexOf("\n", end + 4);
  const body = bodyStart === -1 ? "" : normalized.slice(bodyStart + 1).trim();
  const metadata: Record<string, string> = {};

  for (const line of frontmatter.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf(":");
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) metadata[key] = value;
  }

  return { metadata, body };
}

function requireValidSkillName(path: string, name: string): void {
  if (!VALID_SKILL_NAME.test(name)) {
    throw new T3CapabilityRegistryError(
      path,
      `Invalid skill name '${name}'. Use lowercase letters, numbers, hyphen, or underscore, starting with a letter.`,
    );
  }
}

function normalizeActivation(
  path: string,
  value: string | undefined,
  fallback: T3CapabilityActivation,
): T3CapabilityActivation {
  if (value === undefined || value.trim().length === 0) return fallback;
  const activation = value.trim() as T3CapabilityActivation;
  if (!ACTIVATIONS.has(activation)) {
    throw new T3CapabilityRegistryError(path, `Invalid activation '${value}'.`);
  }
  return activation;
}

export function parseSkillCapabilityDefinition(input: {
  readonly path: string;
  readonly content: string;
}): T3CapabilityDefinition {
  const parsed = parseFrontmatter(input.content);
  const name = parsed.metadata.name?.trim();
  if (!name) {
    throw new T3CapabilityRegistryError(input.path, "SKILL.md must define a frontmatter name.");
  }
  requireValidSkillName(input.path, name);
  const commandName = parsed.metadata.commandName?.trim();
  const kind = commandName ? "slash-command" : "skill";
  const activation = normalizeActivation(
    input.path,
    parsed.metadata.activation,
    kind === "slash-command" ? "command" : "on-demand",
  );
  if (!activationAllowedForKind(kind, activation)) {
    throw new T3CapabilityRegistryError(
      input.path,
      `Activation '${activation}' is not valid for ${kind} capabilities.`,
    );
  }
  const displayName = parsed.metadata.displayName?.trim();
  const description = parsed.metadata.description?.trim();
  const shortDescription = parsed.metadata.shortDescription?.trim();
  const id = parsed.metadata.id?.trim() || `t3:user-skill:${name}`;

  return {
    id,
    name,
    kind,
    activation,
    source: "t3",
    enabled: true,
    readonly: false,
    ...(displayName ? { displayName } : {}),
    ...(description ? { description } : {}),
    ...(shortDescription ? { shortDescription } : {}),
    path: input.path,
    sourceDetail: input.path,
    ...(commandName ? { commandName } : {}),
    content: parsed.body,
  };
}

const pathExists = Effect.fn("pathExists")(function* (
  path: string,
): Effect.fn.Return<boolean, PlatformError.PlatformError, FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.exists(path);
});

const collectSkillFiles = Effect.fn("collectSkillFiles")(function* (
  root: string,
): Effect.fn.Return<
  ReadonlyArray<string>,
  PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path
> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const stat = yield* fs.stat(root);
  if (stat.type === "File") {
    return path.basename(root) === "SKILL.md" ? [root] : [];
  }
  if (stat.type !== "Directory") {
    return [];
  }

  const directSkill = path.join(root, "SKILL.md");
  if (yield* pathExists(directSkill)) {
    return [directSkill];
  }

  const entries = yield* fs.readDirectory(root);
  const existing: Array<string> = [];
  for (const entry of entries) {
    const candidateDirectory = path.join(root, entry);
    const candidateStat = yield* fs.stat(candidateDirectory).pipe(Effect.result);
    if (Result.isFailure(candidateStat) || candidateStat.success.type !== "Directory") {
      continue;
    }
    const candidate = path.join(candidateDirectory, "SKILL.md");
    if (yield* pathExists(candidate)) existing.push(candidate);
  }
  return existing.toSorted();
});

const loadSkillRootDefinitions = Effect.fn("loadSkillRootDefinitions")(function* (input: {
  readonly skillRoots: ReadonlyArray<string>;
  readonly cwd: string;
  readonly strict: boolean;
}): Effect.fn.Return<
  ReadonlyArray<T3CapabilityDefinition>,
  PlatformError.PlatformError | T3CapabilityRegistryError,
  FileSystem.FileSystem | Path.Path
> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const definitions: Array<T3CapabilityDefinition> = [];
  for (const rawRoot of input.skillRoots) {
    const root = path.resolve(normalizePath(rawRoot, input.cwd));
    const loaded = yield* Effect.gen(function* () {
      const skillFiles = yield* collectSkillFiles(root);
      for (const skillFile of skillFiles) {
        const content = yield* fs.readFileString(skillFile);
        const definition = yield* Effect.try({
          try: () => parseSkillCapabilityDefinition({ path: skillFile, content }),
          catch: (cause) =>
            cause instanceof T3CapabilityRegistryError
              ? cause
              : new T3CapabilityRegistryError(skillFile, String(cause)),
        });
        definitions.push(definition);
      }
      return true;
    }).pipe(Effect.result);
    if (Result.isFailure(loaded) && input.strict) {
      return yield* Effect.fail(loaded.failure);
    }
  }
  return definitions;
});

function providerDisplayName(provider: ServerProvider): string {
  return provider.displayName ?? provider.badgeLabel ?? provider.driver;
}

function providerSkillCapability(
  provider: ServerProvider,
  skill: ServerProviderSkill,
): T3CapabilityDefinition {
  const sourceDetail = skill.scope ?? skill.path;
  return {
    id: `provider:${provider.instanceId}:skill:${skill.name}`,
    name: skill.name,
    kind: "skill",
    activation: skill.enabled ? "on-demand" : "hidden",
    source: "provider-native",
    enabled: provider.enabled && skill.enabled,
    readonly: true,
    ...(skill.displayName ? { displayName: skill.displayName } : {}),
    ...(skill.description ? { description: skill.description } : {}),
    ...(skill.shortDescription ? { shortDescription: skill.shortDescription } : {}),
    path: skill.path,
    sourceDetail,
    providerInstanceId: provider.instanceId,
    provider: provider.driver,
    providerDisplayName: providerDisplayName(provider),
    harnessName: providerDisplayName(provider),
  };
}

function providerSlashCommandCapabilities(
  provider: ServerProvider,
): ReadonlyArray<T3CapabilityDefinition> {
  return provider.slashCommands.map((command) => ({
    id: `provider:${provider.instanceId}:slash-command:${command.name}`,
    name: command.name,
    kind: "slash-command",
    activation: "command",
    source: "provider-native",
    enabled: provider.enabled,
    readonly: true,
    ...(command.description ? { description: command.description } : {}),
    commandName: command.name,
    sourceDetail: providerDisplayName(provider),
    providerInstanceId: provider.instanceId,
    provider: provider.driver,
    providerDisplayName: providerDisplayName(provider),
    harnessName: providerDisplayName(provider),
  }));
}

function applyOverride(
  definition: T3CapabilityDefinition,
  override: T3CapabilityOverride | undefined,
): T3CapabilityDefinition {
  if (definition.source !== "t3" || override === undefined) return definition;
  const activation =
    override.activation !== undefined &&
    activationAllowedForKind(definition.kind, override.activation)
      ? override.activation
      : undefined;
  return {
    ...definition,
    ...(override.enabled !== undefined ? { enabled: override.enabled } : {}),
    ...(activation !== undefined ? { activation } : {}),
  };
}

function snapshotEntry(definition: T3CapabilityDefinition): T3CapabilitySnapshotEntry {
  const { content: _content, preloadText: _preloadText, ...metadata } = definition;
  return metadata;
}

function buildPreloadSystemPrompt(
  definitions: ReadonlyArray<T3CapabilityDefinition>,
): string | undefined {
  const lines = definitions
    .filter(
      (definition) =>
        definition.source === "t3" &&
        definition.kind === "skill" &&
        definition.enabled &&
        definition.activation === "preload",
    )
    .map((definition) => {
      const label = definition.displayName ?? definition.name;
      const guidance =
        definition.preloadText ??
        definition.shortDescription ??
        definition.description ??
        "Use this T3-owned capability when relevant.";
      return `- ${label}: ${guidance}`;
    });

  if (lines.length === 0) return undefined;
  return ["T3 capability preload:", ...lines].join("\n");
}

function mergeDefinitions(input: {
  readonly settings: ServerSettings;
  readonly userDefinitions: ReadonlyArray<T3CapabilityDefinition>;
  readonly providers: ReadonlyArray<ServerProvider>;
}): ReadonlyArray<T3CapabilityDefinition> {
  const providerDefinitions = input.providers.flatMap((provider) => [
    ...provider.skills.map((skill) => providerSkillCapability(provider, skill)),
    ...providerSlashCommandCapabilities(provider),
  ]);
  const allDefinitions = [
    ...BUILT_IN_CAPABILITIES,
    ...input.userDefinitions,
    ...providerDefinitions,
  ].map((definition) =>
    applyOverride(definition, input.settings.capabilityRegistry.overrides[definition.id]),
  );
  const byId = new Map<string, T3CapabilityDefinition>();
  for (const definition of allDefinitions) {
    if (!byId.has(definition.id)) byId.set(definition.id, definition);
  }
  return [...byId.values()].toSorted((left, right) => left.id.localeCompare(right.id));
}

export const loadT3CapabilityRegistryEffect = Effect.fn("loadT3CapabilityRegistryEffect")(
  function* (input: {
    readonly settings: ServerSettings;
    readonly providers?: ReadonlyArray<ServerProvider>;
    readonly cwd: string;
    readonly strictSkillRoots?: boolean;
  }): Effect.fn.Return<
    T3CapabilityRegistry,
    PlatformError.PlatformError | T3CapabilityRegistryError,
    FileSystem.FileSystem | Path.Path
  > {
    const userDefinitions = yield* loadSkillRootDefinitions({
      skillRoots: input.settings.capabilityRegistry.skillRoots,
      cwd: input.cwd,
      strict: input.strictSkillRoots ?? false,
    });
    const definitions = mergeDefinitions({
      settings: input.settings,
      userDefinitions,
      providers: input.providers ?? [],
    });
    const preloadSystemPrompt = buildPreloadSystemPrompt(definitions);
    return {
      definitions,
      snapshot: {
        capabilities: definitions.map(snapshotEntry),
      },
      ...(preloadSystemPrompt ? { preloadSystemPrompt } : {}),
    };
  },
);

function openCodeSkillMarkdown(definition: T3CapabilityDefinition): string {
  const description =
    definition.description ??
    definition.shortDescription ??
    `T3-owned capability '${definition.name}'.`;
  return [
    "---",
    `name: ${JSON.stringify(definition.name)}`,
    `description: ${JSON.stringify(description)}`,
    "---",
    "",
    definition.content ?? definition.preloadText ?? description,
    "",
  ].join("\n");
}

function safeSkillDirectoryName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "-");
}

const materializeOpenCodeSkills = Effect.fn("materializeOpenCodeSkills")(function* (input: {
  readonly definitions: ReadonlyArray<T3CapabilityDefinition>;
  readonly runtimeRoot: string;
}): Effect.fn.Return<
  ReadonlyArray<string>,
  PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path
> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const skillsRoot = path.join(input.runtimeRoot, "skills");
  const materialized = input.definitions.filter(
    (definition) =>
      definition.source === "t3" &&
      definition.kind === "skill" &&
      definition.enabled &&
      definition.activation === "on-demand",
  );

  if (materialized.length === 0) return [];
  yield* fs.makeDirectory(skillsRoot, { recursive: true });
  for (const definition of materialized) {
    const skillDir = path.join(skillsRoot, safeSkillDirectoryName(definition.name));
    yield* fs.makeDirectory(skillDir, { recursive: true });
    yield* fs.writeFileString(path.join(skillDir, "SKILL.md"), openCodeSkillMarkdown(definition));
  }
  return [skillsRoot];
});

function openCodeSkillPermissions(
  definitions: ReadonlyArray<T3CapabilityDefinition>,
): Record<string, OpenCodeSkillPermissionAction> {
  const permissions: Record<string, OpenCodeSkillPermissionAction> = {};
  for (const definition of definitions) {
    if (definition.source !== "t3" || definition.kind !== "skill") continue;
    permissions[definition.name] =
      definition.enabled && definition.activation === "on-demand" ? "allow" : "deny";
  }
  return permissions;
}

export const buildOpenCodeCapabilityRuntimeEffect = Effect.fn(
  "buildOpenCodeCapabilityRuntimeEffect",
)(function* (input: {
  readonly settings: ServerSettings;
  readonly cwd: string;
  readonly runtimeRoot: string;
}): Effect.fn.Return<
  OpenCodeCapabilityRuntime,
  PlatformError.PlatformError | T3CapabilityRegistryError,
  FileSystem.FileSystem | Path.Path
> {
  const registry = yield* loadT3CapabilityRegistryEffect({
    settings: input.settings,
    cwd: input.cwd,
    strictSkillRoots: false,
  });
  const skillPaths = yield* materializeOpenCodeSkills({
    definitions: registry.definitions,
    runtimeRoot: input.runtimeRoot,
  }).pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
  return {
    skillPaths,
    skillPermissions: openCodeSkillPermissions(registry.definitions),
    ...(registry.preloadSystemPrompt ? { preloadSystemPrompt: registry.preloadSystemPrompt } : {}),
  };
});

export function emptyOpenCodeCapabilityRuntime(): OpenCodeCapabilityRuntime {
  return { skillPaths: [], skillPermissions: {} };
}

export function emptyCapabilityRegistry(): T3CapabilityRegistry {
  return {
    definitions: [],
    snapshot: EMPTY_T3_CAPABILITY_SNAPSHOT,
  };
}
