import type {
  ServerProvider,
  ServerProviderSkill,
  ServerProviderSlashCommand,
} from "@t3tools/contracts";
import { fromYaml } from "@t3tools/shared/schemaYaml";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const SKILL_FILE_NAME = "SKILL.md";
const T3_METADATA_FILE_NAME = "t3.json";
const OPENAI_INTERFACE_FILE_PATH = ["agents", "openai.yaml"] as const;

const SKILL_NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const SLASH_COMMAND_NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const LEADING_SLASH_COMMAND_PATTERN = /^(\s*)\/([a-zA-Z][a-zA-Z0-9:_-]*)(?=\s|$)([\s\S]*)$/;
const SKILL_TOKEN_PATTERN = /(^|[\s([{"'])\$([a-zA-Z][a-zA-Z0-9:_-]*)(?=$|[\s.,;:!?)}\]"'])/g;

const APP_NATIVE_SLASH_COMMANDS = new Set(["plan", "default", "compact", "clear"]);

const SkillFrontmatter = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  metadata: Schema.optional(
    Schema.Struct({
      "short-description": Schema.optional(Schema.String),
      short_description: Schema.optional(Schema.String),
      shortDescription: Schema.optional(Schema.String),
    }),
  ),
});

const OpenAiInterfaceMetadata = Schema.Struct({
  interface: Schema.optional(
    Schema.Struct({
      display_name: Schema.optional(Schema.String),
      short_description: Schema.optional(Schema.String),
    }),
  ),
});

const RepoSkillSlashCommandMetadata = Schema.Struct({
  name: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  inputHint: Schema.optional(Schema.String),
});

const RepoSkillT3Metadata = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  displayName: Schema.optional(Schema.String),
  shortDescription: Schema.optional(Schema.String),
  slashCommand: Schema.optional(Schema.Union([Schema.Boolean, RepoSkillSlashCommandMetadata])),
});

const decodeFrontmatter = Schema.decodeUnknownEffect(fromYaml(SkillFrontmatter));
const decodeOpenAiInterfaceMetadata = Schema.decodeUnknownEffect(fromYaml(OpenAiInterfaceMetadata));
const decodeT3Metadata = Schema.decodeUnknownEffect(Schema.fromJsonString(RepoSkillT3Metadata));

export interface RepoSkillCatalog {
  readonly rootPath: string;
  readonly skills: ReadonlyArray<RepoSkillCatalogEntry>;
  readonly diagnostics: ReadonlyArray<RepoSkillCatalogDiagnostic>;
}

export interface RepoSkillCatalogEntry {
  readonly name: string;
  readonly directoryPath: string;
  readonly skillPath: string;
  readonly enabled: boolean;
  readonly description: string;
  readonly displayName?: string;
  readonly shortDescription?: string;
  readonly instructions: string;
  readonly slashCommand?: ServerProviderSlashCommand;
}

export interface RepoSkillCatalogDiagnostic {
  readonly path: string;
  readonly issue: string;
}

export function emptyRepoSkillCatalog(rootPath = ""): RepoSkillCatalog {
  return { rootPath, skills: [], diagnostics: [] };
}

function trimOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeSkillName(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return SKILL_NAME_PATTERN.test(normalized) ? normalized : null;
}

function normalizeSlashCommandName(value: string): string | null {
  const normalized = value.trim().replace(/^\/+/, "").toLowerCase();
  return SLASH_COMMAND_NAME_PATTERN.test(normalized) && !APP_NATIVE_SLASH_COMMANDS.has(normalized)
    ? normalized
    : null;
}

function parseSkillMarkdown(value: string): {
  readonly frontmatter: string;
  readonly body: string;
} | null {
  const normalized = value.replace(/^\uFEFF/, "");
  if (!normalized.startsWith("---\n") && !normalized.startsWith("---\r\n")) {
    return null;
  }

  const lineEnding = normalized.startsWith("---\r\n") ? "\r\n" : "\n";
  const frontmatterStart = 3 + lineEnding.length;
  const endMarker = `${lineEnding}---${lineEnding}`;
  const end = normalized.indexOf(endMarker, 3);
  if (end < 0) {
    return null;
  }

  return {
    frontmatter: normalized.slice(frontmatterStart, end),
    body: normalized.slice(end + endMarker.length).trim(),
  };
}

function shortDescriptionFromFrontmatter(
  frontmatter: typeof SkillFrontmatter.Type,
): string | undefined {
  return trimOptional(
    frontmatter.metadata?.["short-description"] ??
      frontmatter.metadata?.short_description ??
      frontmatter.metadata?.shortDescription,
  );
}

function buildSlashCommand(input: {
  readonly skillName: string;
  readonly description: string;
  readonly metadata: typeof RepoSkillT3Metadata.Type | null;
}): ServerProviderSlashCommand | undefined {
  const metadata = input.metadata?.slashCommand;
  if (metadata === undefined || metadata === false) {
    return undefined;
  }

  const slashMetadata = typeof metadata === "object" ? metadata : null;
  const name = normalizeSlashCommandName(slashMetadata?.name ?? input.skillName);
  if (!name) {
    return undefined;
  }

  const description = trimOptional(slashMetadata?.description) ?? input.description;
  const inputHint = trimOptional(slashMetadata?.inputHint);

  return {
    name,
    scope: "repo",
    ...(description ? { description } : {}),
    ...(inputHint ? { input: { hint: inputHint } } : {}),
  };
}

function providerSkillFromRepoSkill(skill: RepoSkillCatalogEntry): ServerProviderSkill {
  return {
    name: skill.name,
    path: skill.skillPath,
    scope: "repo",
    enabled: skill.enabled,
    description: skill.description,
    ...(skill.displayName ? { displayName: skill.displayName } : {}),
    ...(skill.shortDescription ? { shortDescription: skill.shortDescription } : {}),
  };
}

const readOptionalText = (filePath: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.readFileString(filePath).pipe(
      Effect.map(Option.some),
      Effect.catchTags({
        PlatformError: (cause) =>
          cause.reason._tag === "NotFound" ? Effect.succeedNone : Effect.fail(cause),
      }),
    );
  });

export const loadRepoSkillCatalog = Effect.fn("loadRepoSkillCatalog")(function* (
  rootPath: string,
): Effect.fn.Return<RepoSkillCatalog, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const diagnostics: RepoSkillCatalogDiagnostic[] = [];

  const rootExists = yield* fileSystem.exists(rootPath).pipe(Effect.orElseSucceed(() => false));
  if (!rootExists) {
    return { rootPath, skills: [], diagnostics };
  }

  const entries = yield* fileSystem.readDirectory(rootPath).pipe(
    Effect.catchTags({
      PlatformError: (cause) => {
        diagnostics.push({ path: rootPath, issue: "Failed to read repo skills directory." });
        return Effect.logWarning("Failed to read repo skills directory.", { rootPath, cause }).pipe(
          Effect.as([] as string[]),
        );
      },
    }),
  );

  const skills: RepoSkillCatalogEntry[] = [];
  const seenSkillNames = new Set<string>();
  const seenSlashCommandNames = new Set<string>();

  for (const entry of entries.toSorted()) {
    const directoryPath = path.join(rootPath, entry);
    const stat = yield* fileSystem.stat(directoryPath).pipe(Effect.orElseSucceed(() => null));
    if (stat?.type !== "Directory") {
      continue;
    }

    const skillPath = path.join(directoryPath, SKILL_FILE_NAME);
    const skillText = yield* fileSystem.readFileString(skillPath).pipe(
      Effect.catchTags({
        PlatformError: (cause) => {
          diagnostics.push({ path: skillPath, issue: "Missing or unreadable SKILL.md." });
          return Effect.logWarning("Failed to read repo skill file.", { skillPath, cause }).pipe(
            Effect.as(null),
          );
        },
      }),
    );
    if (skillText === null) {
      continue;
    }

    const parsedMarkdown = parseSkillMarkdown(skillText);
    if (!parsedMarkdown) {
      diagnostics.push({ path: skillPath, issue: "SKILL.md must start with YAML frontmatter." });
      continue;
    }

    const frontmatter = yield* decodeFrontmatter(parsedMarkdown.frontmatter).pipe(
      Effect.catch((cause) => {
        diagnostics.push({ path: skillPath, issue: "Invalid SKILL.md frontmatter." });
        return Effect.logWarning("Invalid repo skill frontmatter.", { skillPath, cause }).pipe(
          Effect.as(null),
        );
      }),
    );
    if (!frontmatter) {
      continue;
    }

    const normalizedName = normalizeSkillName(frontmatter.name);
    if (!normalizedName) {
      diagnostics.push({ path: skillPath, issue: "Skill name must be lower-case hyphen-case." });
      continue;
    }
    if (normalizedName !== entry) {
      diagnostics.push({
        path: skillPath,
        issue: "Skill folder name must match SKILL.md name.",
      });
      continue;
    }
    if (seenSkillNames.has(normalizedName)) {
      diagnostics.push({ path: skillPath, issue: "Duplicate repo skill name." });
      continue;
    }

    const t3MetadataPath = path.join(directoryPath, T3_METADATA_FILE_NAME);
    const t3MetadataText = yield* readOptionalText(t3MetadataPath).pipe(
      Effect.catch((cause) => {
        diagnostics.push({ path: t3MetadataPath, issue: "Failed to read t3.json metadata." });
        return Effect.logWarning("Failed to read repo skill T3 metadata.", {
          t3MetadataPath,
          cause,
        }).pipe(Effect.as(Option.none<string>()));
      }),
    );
    const t3Metadata = Option.isSome(t3MetadataText)
      ? yield* decodeT3Metadata(t3MetadataText.value).pipe(
          Effect.catch((cause) => {
            diagnostics.push({ path: t3MetadataPath, issue: "Invalid t3.json metadata." });
            return Effect.logWarning("Invalid repo skill T3 metadata.", {
              t3MetadataPath,
              cause,
            }).pipe(Effect.as(null));
          }),
        )
      : null;
    if (Option.isSome(t3MetadataText) && !t3Metadata) {
      continue;
    }

    const openAiMetadataPath = path.join(directoryPath, ...OPENAI_INTERFACE_FILE_PATH);
    const openAiMetadataText = yield* readOptionalText(openAiMetadataPath).pipe(
      Effect.catch(() => Effect.succeedNone),
    );
    const openAiMetadata = Option.isSome(openAiMetadataText)
      ? yield* decodeOpenAiInterfaceMetadata(openAiMetadataText.value).pipe(
          Effect.catch((cause) => {
            diagnostics.push({ path: openAiMetadataPath, issue: "Invalid agents/openai.yaml." });
            return Effect.logWarning("Invalid repo skill interface metadata.", {
              openAiMetadataPath,
              cause,
            }).pipe(Effect.as(null));
          }),
        )
      : null;

    const description = frontmatter.description.trim();
    const enabled = t3Metadata?.enabled ?? true;
    const slashCommand = enabled
      ? buildSlashCommand({
          skillName: normalizedName,
          description,
          metadata: t3Metadata,
        })
      : undefined;
    if (slashCommand && seenSlashCommandNames.has(slashCommand.name)) {
      diagnostics.push({ path: t3MetadataPath, issue: "Duplicate repo slash command name." });
      continue;
    }

    seenSkillNames.add(normalizedName);
    if (slashCommand) {
      seenSlashCommandNames.add(slashCommand.name);
    }

    const displayName = trimOptional(
      t3Metadata?.displayName ?? openAiMetadata?.interface?.display_name,
    );
    const shortDescription = trimOptional(
      t3Metadata?.shortDescription ??
        openAiMetadata?.interface?.short_description ??
        shortDescriptionFromFrontmatter(frontmatter),
    );

    skills.push({
      name: normalizedName,
      directoryPath,
      skillPath,
      enabled,
      description,
      instructions: parsedMarkdown.body || description,
      ...(displayName ? { displayName } : {}),
      ...(shortDescription ? { shortDescription } : {}),
      ...(slashCommand ? { slashCommand } : {}),
    });
  }

  return {
    rootPath,
    skills,
    diagnostics,
  };
});

export function enrichProviderWithRepoSkills(
  provider: ServerProvider,
  catalog: RepoSkillCatalog,
): ServerProvider {
  if (catalog.skills.length === 0) {
    return provider;
  }

  const nativeSkills = provider.skills.filter((skill) => skill.scope !== "repo");
  const nativeSlashCommands = provider.slashCommands.filter((command) => command.scope !== "repo");
  const existingSkillNames = new Set(nativeSkills.map((skill) => skill.name));
  const existingSlashCommandNames = new Set(nativeSlashCommands.map((command) => command.name));
  const repoSkills = catalog.skills
    .filter((skill) => !existingSkillNames.has(skill.name))
    .map(providerSkillFromRepoSkill);
  const repoSlashCommands = catalog.skills
    .flatMap((skill) => (skill.enabled && skill.slashCommand ? [skill.slashCommand] : []))
    .filter((command) => !existingSlashCommandNames.has(command.name));

  return {
    ...provider,
    skills: [...nativeSkills, ...repoSkills],
    slashCommands: [...nativeSlashCommands, ...repoSlashCommands],
  };
}

function uniqueInvocations(invocations: ReadonlyArray<RepoSkillInvocation>): RepoSkillInvocation[] {
  const seen = new Set<string>();
  const result: RepoSkillInvocation[] = [];
  for (const invocation of invocations) {
    if (seen.has(invocation.skill.name)) {
      continue;
    }
    seen.add(invocation.skill.name);
    result.push(invocation);
  }
  return result;
}

interface RepoSkillInvocation {
  readonly trigger: string;
  readonly skill: RepoSkillCatalogEntry;
}

function visibleRepoExpansionNames(provider: ServerProvider | undefined): {
  readonly skillNames: ReadonlySet<string>;
  readonly slashCommandNames: ReadonlySet<string>;
} | null {
  if (!provider) {
    return null;
  }

  return {
    skillNames: new Set(
      provider.skills.filter((skill) => skill.scope === "repo").map((skill) => skill.name),
    ),
    slashCommandNames: new Set(
      provider.slashCommands
        .filter((command) => command.scope === "repo")
        .map((command) => command.name),
    ),
  };
}

function formatRepoSkillInstructionBlock(invocations: ReadonlyArray<RepoSkillInvocation>): string {
  const blocks = invocations.map(
    (invocation) => `<t3_repo_skill name="${invocation.skill.name}" trigger="${invocation.trigger}">
Description: ${invocation.skill.description}
Source: ${invocation.skill.skillPath}

${invocation.skill.instructions}
</t3_repo_skill>`,
  );

  return `The user invoked the following T3 Code repo skills. Follow these skill instructions while responding.

${blocks.join("\n\n")}`;
}

export function expandRepoSkillPrompt(input: {
  readonly input: string | undefined;
  readonly catalog: RepoSkillCatalog;
  readonly provider?: ServerProvider | undefined;
}): string | undefined {
  if (!input.input || input.catalog.skills.length === 0) {
    return input.input;
  }

  const enabledSkills = input.catalog.skills.filter((skill) => skill.enabled);
  const visibleNames = visibleRepoExpansionNames(input.provider);
  const skillByName = new Map(
    enabledSkills
      .filter((skill) => !visibleNames || visibleNames.skillNames.has(skill.name))
      .map((skill) => [skill.name, skill] as const),
  );
  const slashCommandByName = new Map(
    enabledSkills.flatMap((skill) =>
      skill.slashCommand &&
      (!visibleNames || visibleNames.slashCommandNames.has(skill.slashCommand.name))
        ? [[skill.slashCommand.name, skill] as const]
        : [],
    ),
  );
  const invocations: RepoSkillInvocation[] = [];
  let userPrompt = input.input;

  const slashMatch = LEADING_SLASH_COMMAND_PATTERN.exec(userPrompt);
  if (slashMatch) {
    const rawName = slashMatch[2] ?? "";
    const normalizedName = rawName.toLowerCase();
    if (!APP_NATIVE_SLASH_COMMANDS.has(normalizedName)) {
      const skill = slashCommandByName.get(normalizedName);
      if (skill) {
        invocations.push({ trigger: `/${normalizedName}`, skill });
        userPrompt = (slashMatch[3] ?? "").replace(/^\s+/, "");
      }
    }
  }

  userPrompt = userPrompt.replace(
    SKILL_TOKEN_PATTERN,
    (match: string, prefix: string, rawName: string) => {
      const normalizedName = rawName.toLowerCase();
      const skill = skillByName.get(normalizedName);
      if (!skill) {
        return match;
      }
      invocations.push({ trigger: `$${normalizedName}`, skill });
      return `${prefix}${skill.displayName ?? skill.name}`;
    },
  );

  const unique = uniqueInvocations(invocations);
  if (unique.length === 0) {
    return input.input;
  }

  const prompt = userPrompt.trim();
  return `${formatRepoSkillInstructionBlock(unique)}

User prompt:
${prompt || "Use the invoked repo skill."}`;
}
