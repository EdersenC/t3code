import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type { ServerProvider } from "@t3tools/contracts";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  emptyRepoSkillCatalog,
  enrichProviderWithRepoSkills,
  expandRepoSkillPrompt,
  loadRepoSkillCatalog,
  type RepoSkillCatalog,
} from "./repoSkills.ts";

const layer = NodeServices.layer;

const makeProvider = (input?: Partial<ServerProvider>): ServerProvider => ({
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  displayName: "Codex",
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-04-11T00:00:00.000Z",
  models: [],
  skills: [],
  slashCommands: [],
  ...input,
});

const writeSkill = (input: {
  readonly root: string;
  readonly name: string;
  readonly description?: string;
  readonly body?: string;
  readonly t3Json?: string;
  readonly openAiYaml?: string;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const skillDir = path.join(input.root, input.name);
    yield* fs.makeDirectory(path.join(skillDir, "agents"), { recursive: true });
    yield* fs.writeFileString(
      path.join(skillDir, "SKILL.md"),
      `---\nname: ${input.name}\ndescription: ${input.description ?? "Use for testing repo skills."}\nmetadata:\n  short-description: Frontmatter short copy\n---\n\n${input.body ?? "Follow the repo skill instructions."}\n`,
    );
    if (input.t3Json !== undefined) {
      yield* fs.writeFileString(path.join(skillDir, "t3.json"), input.t3Json);
    }
    if (input.openAiYaml !== undefined) {
      yield* fs.writeFileString(path.join(skillDir, "agents", "openai.yaml"), input.openAiYaml);
    }
  });

const makeCatalog = (skills: RepoSkillCatalog["skills"]): RepoSkillCatalog => ({
  ...emptyRepoSkillCatalog("/repo/skills"),
  skills,
});

describe("loadRepoSkillCatalog", () => {
  it.effect("loads repo skills with normalized skill and slash command metadata", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory();
      yield* writeSkill({
        root,
        name: "code-review",
        description: "Review code changes for bugs and regressions.",
        body: "Prioritize correctness, tests, and user-visible regressions.",
        t3Json:
          '{"displayName":"Code Review","shortDescription":"Review changes for bugs","slashCommand":{"name":"/review","description":"Review the current changes","inputHint":"optional focus area"}}',
        openAiYaml:
          "interface:\n  display_name: Ignored OpenAI Name\n  short_description: Ignored OpenAI copy\n",
      });

      const catalog = yield* loadRepoSkillCatalog(root);

      assert.equal(catalog.diagnostics.length, 0);
      assert.equal(catalog.skills.length, 1);
      const skill = catalog.skills[0];
      assert.equal(skill?.name, "code-review");
      assert.equal(skill?.skillPath, path.join(root, "code-review", "SKILL.md"));
      assert.equal(skill?.displayName, "Code Review");
      assert.equal(skill?.shortDescription, "Review changes for bugs");
      assert.equal(skill?.slashCommand?.name, "review");
      assert.equal(skill?.slashCommand?.input?.hint, "optional focus area");
      assert.match(skill?.instructions ?? "", /Prioritize correctness/);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("skips invalid t3 metadata without failing the catalog", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectory();
      yield* writeSkill({
        root,
        name: "bad-metadata",
        t3Json: "{not-json",
      });

      const catalog = yield* loadRepoSkillCatalog(root);

      assert.equal(catalog.skills.length, 0);
      assert.equal(catalog.diagnostics.length, 1);
      assert.match(catalog.diagnostics[0]?.issue ?? "", /Invalid t3\.json/);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("drops duplicate repo slash command names after normalization", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectory();
      yield* writeSkill({
        root,
        name: "first-skill",
        t3Json: '{"slashCommand":{"name":"/shared"}}',
      });
      yield* writeSkill({
        root,
        name: "second-skill",
        t3Json: '{"slashCommand":{"name":"shared"}}',
      });

      const catalog = yield* loadRepoSkillCatalog(root);

      assert.deepEqual(
        catalog.skills.map((skill) => skill.name),
        ["first-skill"],
      );
      assert.equal(catalog.diagnostics.length, 1);
      assert.match(catalog.diagnostics[0]?.issue ?? "", /Duplicate repo slash command/);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("does not let disabled skills expose or reserve slash command names", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectory();
      yield* writeSkill({
        root,
        name: "disabled-skill",
        t3Json: '{"enabled":false,"slashCommand":{"name":"/shared"}}',
      });
      yield* writeSkill({
        root,
        name: "enabled-skill",
        t3Json: '{"slashCommand":{"name":"/shared"}}',
      });

      const catalog = yield* loadRepoSkillCatalog(root);

      assert.equal(catalog.diagnostics.length, 0);
      assert.deepEqual(
        catalog.skills.map((skill) => skill.name),
        ["disabled-skill", "enabled-skill"],
      );
      assert.equal(catalog.skills[0]?.enabled, false);
      assert.equal(catalog.skills[0]?.slashCommand, undefined);
      assert.equal(catalog.skills[1]?.slashCommand?.name, "shared");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("parses CRLF skill frontmatter", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory();
      const skillDir = path.join(root, "windows-lines");
      yield* fs.makeDirectory(skillDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(skillDir, "SKILL.md"),
        "---\r\nname: windows-lines\r\ndescription: Handles CRLF metadata.\r\n---\r\n\r\nFollow CRLF instructions.\r\n",
      );

      const catalog = yield* loadRepoSkillCatalog(root);

      assert.equal(catalog.diagnostics.length, 0);
      assert.equal(catalog.skills[0]?.name, "windows-lines");
      assert.equal(catalog.skills[0]?.description, "Handles CRLF metadata.");
      assert.equal(catalog.skills[0]?.instructions, "Follow CRLF instructions.");
    }).pipe(Effect.provide(layer)),
  );
});

describe("enrichProviderWithRepoSkills", () => {
  it("adds repo skills and commands while preserving native duplicates", () => {
    const catalog = makeCatalog([
      {
        name: "code-review",
        directoryPath: "/repo/skills/code-review",
        skillPath: "/repo/skills/code-review/SKILL.md",
        enabled: true,
        description: "Repo review skill",
        instructions: "Review carefully.",
        slashCommand: { name: "review", description: "Repo review" },
      },
      {
        name: "fix-ci",
        directoryPath: "/repo/skills/fix-ci",
        skillPath: "/repo/skills/fix-ci/SKILL.md",
        enabled: true,
        description: "Fix CI",
        instructions: "Fix failing checks.",
        slashCommand: { name: "fix-ci", description: "Fix CI" },
      },
    ]);
    const provider = makeProvider({
      skills: [
        {
          name: "code-review",
          path: "/native/code-review/SKILL.md",
          scope: "user",
          enabled: true,
          description: "Native review skill",
        },
      ],
      slashCommands: [{ name: "review", description: "Native review" }],
    });

    const enriched = enrichProviderWithRepoSkills(provider, catalog);

    assert.deepEqual(
      enriched.skills.map((skill) => skill.name),
      ["code-review", "fix-ci"],
    );
    assert.deepEqual(
      enriched.slashCommands.map((command) => command.name),
      ["review", "fix-ci"],
    );
    assert.equal(enriched.skills[0]?.path, "/native/code-review/SKILL.md");
  });

  it("removes stale repo-scoped entries before adding the current repo catalog", () => {
    const catalog = makeCatalog([
      {
        name: "current-skill",
        directoryPath: "/repo/skills/current-skill",
        skillPath: "/repo/skills/current-skill/SKILL.md",
        enabled: true,
        description: "Current repo skill",
        instructions: "Use current instructions.",
        slashCommand: { name: "current", scope: "repo", description: "Current command" },
      },
    ]);
    const provider = makeProvider({
      skills: [
        {
          name: "stale-skill",
          path: "/repo/skills/stale-skill/SKILL.md",
          scope: "repo",
          enabled: true,
          description: "Stale repo skill",
        },
        {
          name: "native-skill",
          path: "/native/native-skill/SKILL.md",
          scope: "user",
          enabled: true,
          description: "Native skill",
        },
      ],
      slashCommands: [
        { name: "stale", scope: "repo", description: "Stale command" },
        { name: "native", description: "Native command" },
      ],
    });

    const enriched = enrichProviderWithRepoSkills(provider, catalog);

    assert.deepEqual(
      enriched.skills.map((skill) => skill.name),
      ["native-skill", "current-skill"],
    );
    assert.deepEqual(
      enriched.slashCommands.map((command) => command.name),
      ["native", "current"],
    );
  });
});

describe("expandRepoSkillPrompt", () => {
  const catalog = makeCatalog([
    {
      name: "code-review",
      directoryPath: "/repo/skills/code-review",
      skillPath: "/repo/skills/code-review/SKILL.md",
      enabled: true,
      description: "Review changes for bugs.",
      displayName: "Code Review",
      instructions: "Review instruction body.",
      slashCommand: { name: "review", description: "Review changes" },
    },
    {
      name: "fix-ci",
      directoryPath: "/repo/skills/fix-ci",
      skillPath: "/repo/skills/fix-ci/SKILL.md",
      enabled: true,
      description: "Fix failing checks.",
      instructions: "Fix CI instruction body.",
    },
  ]);

  it("expands a leading slash command into repo skill instructions", () => {
    const expanded = expandRepoSkillPrompt({ input: "/review focus tests", catalog });

    assert.match(expanded ?? "", /<t3_repo_skill name="code-review" trigger="\/review">/);
    assert.match(expanded ?? "", /Review instruction body/);
    assert.match(expanded ?? "", /User prompt:\nfocus tests/);
  });

  it("expands skill mentions anywhere and neutralizes provider-native skill syntax", () => {
    const expanded = expandRepoSkillPrompt({
      input: "please use $fix-ci, then $code-review.",
      catalog,
    });

    assert.match(expanded ?? "", /<t3_repo_skill name="fix-ci" trigger="\$fix-ci">/);
    assert.match(expanded ?? "", /<t3_repo_skill name="code-review" trigger="\$code-review">/);
    assert.match(expanded ?? "", /please use fix-ci, then Code Review\./);
  });

  it("only expands repo skills and commands visible on the routed provider", () => {
    const providerWithNativeCollisions = makeProvider({
      skills: [
        {
          name: "fix-ci",
          path: "/native/fix-ci/SKILL.md",
          scope: "user",
          enabled: true,
          description: "Native fix skill",
        },
      ],
      slashCommands: [{ name: "review", description: "Native review command" }],
    });

    assert.equal(
      expandRepoSkillPrompt({
        input: "/review focus tests",
        catalog,
        provider: providerWithNativeCollisions,
      }),
      "/review focus tests",
    );
    assert.equal(
      expandRepoSkillPrompt({
        input: "please use $fix-ci",
        catalog,
        provider: providerWithNativeCollisions,
      }),
      "please use $fix-ci",
    );

    const providerWithRepoEntries = makeProvider({
      skills: [
        {
          name: "fix-ci",
          path: "/repo/skills/fix-ci/SKILL.md",
          scope: "repo",
          enabled: true,
          description: "Fix CI",
        },
      ],
      slashCommands: [{ name: "review", scope: "repo", description: "Repo review" }],
    });

    assert.match(
      expandRepoSkillPrompt({
        input: "/review focus tests",
        catalog,
        provider: providerWithRepoEntries,
      }) ?? "",
      /<t3_repo_skill name="code-review" trigger="\/review">/,
    );
    assert.match(
      expandRepoSkillPrompt({
        input: "please use $fix-ci",
        catalog,
        provider: providerWithRepoEntries,
      }) ?? "",
      /<t3_repo_skill name="fix-ci" trigger="\$fix-ci">/,
    );
  });

  it("leaves unknown tokens, disabled skills, and app-native commands unchanged", () => {
    const disabledCatalog = makeCatalog([
      {
        name: "disabled-skill",
        directoryPath: "/repo/skills/disabled-skill",
        skillPath: "/repo/skills/disabled-skill/SKILL.md",
        enabled: false,
        description: "Disabled skill",
        instructions: "Disabled instruction body.",
        slashCommand: { name: "disabled", scope: "repo", description: "Disabled" },
      },
    ]);

    assert.equal(expandRepoSkillPrompt({ input: "/unknown hello", catalog }), "/unknown hello");
    assert.equal(expandRepoSkillPrompt({ input: "$unknown hello", catalog }), "$unknown hello");
    assert.equal(
      expandRepoSkillPrompt({ input: "/disabled hello", catalog: disabledCatalog }),
      "/disabled hello",
    );
    assert.equal(
      expandRepoSkillPrompt({ input: "$disabled-skill hello", catalog: disabledCatalog }),
      "$disabled-skill hello",
    );
    assert.equal(expandRepoSkillPrompt({ input: "/plan", catalog }), "/plan");
    assert.equal(expandRepoSkillPrompt({ input: "/default", catalog }), "/default");
    assert.equal(expandRepoSkillPrompt({ input: "/compact", catalog }), "/compact");
    assert.equal(expandRepoSkillPrompt({ input: "/clear", catalog }), "/clear");
  });
});
