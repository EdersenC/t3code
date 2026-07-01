import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  buildOpenCodeCapabilityRuntimeEffect,
  loadT3CapabilityRegistryEffect,
  parseSkillCapabilityDefinition,
  T3CapabilityRegistryError,
} from "./T3CapabilityRegistry.ts";

it.layer(NodeServices.layer)("T3CapabilityRegistry", (it) => {
  it.effect("loads built-in capabilities deterministically without client-visible bodies", () =>
    Effect.gen(function* () {
      const registry = yield* loadT3CapabilityRegistryEffect({
        settings: DEFAULT_SERVER_SETTINGS,
        cwd: process.cwd(),
      });

      assert.deepEqual(
        registry.snapshot.capabilities.map((capability) => capability.id),
        ["t3:command:tools", "t3:skill:random-subagent-test", "t3:tool:subagent"],
      );
      assert.isUndefined(registry.preloadSystemPrompt);
      assert.deepInclude(
        registry.snapshot.capabilities.find((capability) => capability.id === "t3:tool:subagent"),
        {
          kind: "tool",
          toolName: "t3_subagent",
        },
      );
      assert.deepInclude(
        registry.snapshot.capabilities.find(
          (capability) => capability.id === "t3:skill:random-subagent-test",
        ),
        {
          kind: "skill",
          activation: "on-demand",
          name: "random-subagent-test",
        },
      );
      for (const capability of registry.snapshot.capabilities) {
        assert.notProperty(capability as Record<string, unknown>, "content");
        assert.notProperty(capability as Record<string, unknown>, "preloadText");
      }
    }),
  );

  it.effect("parses SKILL.md manifests and rejects invalid metadata", () =>
    Effect.sync(() => {
      const parsed = parseSkillCapabilityDefinition({
        path: "/repo/.t3/skills/customize-opencode/SKILL.md",
        content: [
          "---",
          "name: customize-opencode",
          "displayName: Customize OpenCode",
          "description: Configure OpenCode harness behavior.",
          "activation: on-demand",
          "---",
          "# Customize OpenCode",
          "Use for OpenCode configuration work.",
        ].join("\n"),
      });

      assert.deepInclude(parsed, {
        id: "t3:user-skill:customize-opencode",
        name: "customize-opencode",
        activation: "on-demand",
        source: "t3",
      });
      assert.include(parsed.content ?? "", "OpenCode configuration");
      const command = parseSkillCapabilityDefinition({
        path: "/repo/.t3/commands/tools/SKILL.md",
        content: [
          "---",
          "name: tools",
          "commandName: tools",
          "description: Open tool registry.",
          "---",
          "# Tools",
        ].join("\n"),
      });
      assert.deepInclude(command, {
        id: "t3:user-skill:tools",
        kind: "slash-command",
        activation: "command",
        commandName: "tools",
      });
      assert.throws(() =>
        parseSkillCapabilityDefinition({
          path: "/repo/SKILL.md",
          content: "---\nname: Bad Name\n---\n# Invalid",
        }),
      );
      assert.throws(() =>
        parseSkillCapabilityDefinition({
          path: "/repo/SKILL.md",
          content: "---\nname: valid-name\nactivation: auto\n---\n# Invalid",
        }),
      );
      assert.throws(() =>
        parseSkillCapabilityDefinition({
          path: "/repo/SKILL.md",
          content: "---\nname: regular-skill\nactivation: command\n---\n# Invalid",
        }),
      );
    }),
  );

  it.effect("loads user skill roots in strict mode", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-capability-skills-" });
      const skillDir = path.join(root, "customize-opencode");
      const skillPath = path.join(skillDir, "SKILL.md");
      yield* fs.makeDirectory(skillDir, { recursive: true });
      yield* fs.writeFileString(
        skillPath,
        [
          "---",
          "name: customize-opencode",
          "description: Configure OpenCode itself.",
          "---",
          "# Customize OpenCode",
        ].join("\n"),
      );

      const registry = yield* loadT3CapabilityRegistryEffect({
        settings: {
          ...DEFAULT_SERVER_SETTINGS,
          capabilityRegistry: { skillRoots: [root], overrides: {} },
        },
        cwd: process.cwd(),
        strictSkillRoots: true,
      });

      assert.exists(
        registry.definitions.find(
          (definition) => definition.id === "t3:user-skill:customize-opencode",
        ),
      );
    }),
  );

  it.effect("applies T3 overrides without mutating source definitions", () =>
    Effect.gen(function* () {
      const overridden = yield* loadT3CapabilityRegistryEffect({
        settings: {
          ...DEFAULT_SERVER_SETTINGS,
          capabilityRegistry: {
            skillRoots: [],
            overrides: {
              "t3:skill:random-subagent-test": {
                enabled: false,
                activation: "hidden",
              },
            },
          },
        },
        cwd: process.cwd(),
      });
      const defaultRegistry = yield* loadT3CapabilityRegistryEffect({
        settings: DEFAULT_SERVER_SETTINGS,
        cwd: process.cwd(),
      });

      assert.deepInclude(
        overridden.snapshot.capabilities.find(
          (capability) => capability.id === "t3:skill:random-subagent-test",
        ),
        { enabled: false, activation: "hidden" },
      );
      assert.deepInclude(
        defaultRegistry.snapshot.capabilities.find(
          (capability) => capability.id === "t3:skill:random-subagent-test",
        ),
        { enabled: true, activation: "on-demand" },
      );
    }),
  );

  it.effect("ignores incompatible activation overrides for built-in tools", () =>
    Effect.gen(function* () {
      const registry = yield* loadT3CapabilityRegistryEffect({
        settings: {
          ...DEFAULT_SERVER_SETTINGS,
          capabilityRegistry: {
            skillRoots: [],
            overrides: {
              "t3:tool:subagent": {
                enabled: true,
                activation: "command",
              },
            },
          },
        },
        cwd: process.cwd(),
      });

      assert.deepInclude(
        registry.snapshot.capabilities.find((capability) => capability.id === "t3:tool:subagent"),
        { enabled: true, activation: "on-demand" },
      );
    }),
  );

  it.effect("materializes the built-in random subagent test skill", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const runtimeRoot = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-opencode-capabilities-",
      });

      const runtime = yield* buildOpenCodeCapabilityRuntimeEffect({
        settings: DEFAULT_SERVER_SETTINGS,
        cwd: process.cwd(),
        runtimeRoot,
      });

      const skillRoot = path.join(runtimeRoot, "skills");
      assert.deepEqual(runtime.skillPaths, [skillRoot]);
      assert.strictEqual(runtime.skillPermissions["random-subagent-test"], "allow");
      assert.isUndefined(runtime.preloadSystemPrompt);
      const skillBody = yield* fs.readFileString(
        path.join(skillRoot, "random-subagent-test", "SKILL.md"),
      );
      assert.include(skillBody, "Call `t3_subagent`");
    }),
  );

  it.effect("materializes user SKILL.md roots as OpenCode skills with permissions", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const userRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-user-skills-" });
      const skillDir = path.join(userRoot, "customize-opencode");
      const runtimeRoot = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-opencode-capabilities-",
      });
      yield* fs.makeDirectory(skillDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(skillDir, "SKILL.md"),
        [
          "---",
          "name: customize-opencode",
          "description: Configure OpenCode itself.",
          "---",
          "# Customize OpenCode",
        ].join("\n"),
      );

      const runtime = yield* buildOpenCodeCapabilityRuntimeEffect({
        settings: {
          ...DEFAULT_SERVER_SETTINGS,
          capabilityRegistry: { skillRoots: [userRoot], overrides: {} },
        },
        cwd: process.cwd(),
        runtimeRoot,
      });

      const skillRoot = path.join(runtimeRoot, "skills");
      assert.deepEqual(runtime.skillPaths, [skillRoot]);
      assert.strictEqual(runtime.skillPermissions["customize-opencode"], "allow");
      const skillBody = yield* fs.readFileString(
        path.join(skillRoot, "customize-opencode", "SKILL.md"),
      );
      assert.include(skillBody, "Customize OpenCode");
    }),
  );

  it.effect("merges provider-native skills and slash commands as read-only metadata", () =>
    Effect.gen(function* () {
      const registry = yield* loadT3CapabilityRegistryEffect({
        settings: DEFAULT_SERVER_SETTINGS,
        cwd: process.cwd(),
        providers: [
          {
            instanceId: ProviderInstanceId.make("opencode"),
            driver: ProviderDriverKind.make("opencode"),
            enabled: true,
            installed: true,
            version: "1.0.0",
            status: "ready",
            auth: { status: "authenticated" },
            checkedAt: "2026-04-10T00:00:00.000Z",
            models: [],
            skills: [
              {
                name: "customize-opencode",
                path: "/repo/.opencode/skill/SKILL.md",
                enabled: true,
                description: "Configure OpenCode.",
              },
            ],
            slashCommands: [{ name: "compact", description: "Compact context." }],
          },
        ],
      });

      assert.deepInclude(
        registry.snapshot.capabilities.find(
          (capability) => capability.id === "provider:opencode:skill:customize-opencode",
        ),
        { source: "provider-native", readonly: true, activation: "on-demand" },
      );
      assert.deepInclude(
        registry.snapshot.capabilities.find(
          (capability) => capability.id === "provider:opencode:slash-command:compact",
        ),
        { source: "provider-native", readonly: true, activation: "command" },
      );
    }),
  );

  it.effect("fails strict skill root loading on invalid manifests", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-invalid-capability-skills-" });
      yield* fs.writeFileString(path.join(root, "SKILL.md"), "---\nname: Bad Name\n---\n# Bad");

      const error = yield* loadT3CapabilityRegistryEffect({
        settings: {
          ...DEFAULT_SERVER_SETTINGS,
          capabilityRegistry: { skillRoots: [root], overrides: {} },
        },
        cwd: process.cwd(),
        strictSkillRoots: true,
      }).pipe(Effect.flip);

      assert.instanceOf(error, T3CapabilityRegistryError);
    }),
  );
});
