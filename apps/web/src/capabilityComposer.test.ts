import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type T3CapabilitySnapshot,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  effectiveComposerSkills,
  providerCommandCapabilities,
  t3CommandCapabilities,
  toolRegistryCapabilities,
} from "./capabilityComposer";

const opencodeDriver = ProviderDriverKind.make("opencode");
const opencodeInstance = ProviderInstanceId.make("opencode");

const providerStatus: ServerProvider = {
  instanceId: opencodeInstance,
  driver: opencodeDriver,
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-04-10T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [
    {
      name: "provider-only",
      path: "/provider/skills/provider-only/SKILL.md",
      enabled: true,
      description: "Provider status skill.",
    },
  ],
};

const capabilities: T3CapabilitySnapshot = {
  capabilities: [
    {
      id: "t3:tool:subagent",
      name: "t3_subagent",
      kind: "tool",
      activation: "on-demand",
      source: "t3",
      enabled: true,
      readonly: false,
      description: "Run a T3-owned subagent.",
      sourceDetail: "built-in:tools",
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
      description: "Verify T3 subagent wiring.",
    },
    {
      id: "t3:user-skill:repo-workflow",
      name: "repo-workflow",
      kind: "skill",
      activation: "on-demand",
      source: "t3",
      enabled: true,
      readonly: false,
      description: "Repo-owned optional skill.",
      sourceDetail: "/repo/.t3/skills/repo-workflow/SKILL.md",
    },
    {
      id: "provider:opencode:skill:customize-opencode",
      name: "customize-opencode",
      kind: "skill",
      activation: "on-demand",
      source: "provider-native",
      enabled: true,
      readonly: true,
      path: "/provider/skills/customize-opencode/SKILL.md",
      providerInstanceId: opencodeInstance,
      provider: opencodeDriver,
      providerDisplayName: "OpenCode",
    },
    {
      id: "provider:other:skill:hidden",
      name: "other-provider-skill",
      kind: "skill",
      activation: "on-demand",
      source: "provider-native",
      enabled: true,
      readonly: true,
      path: "/provider/skills/other/SKILL.md",
      providerInstanceId: ProviderInstanceId.make("other"),
      provider: opencodeDriver,
    },
    {
      id: "t3:command:tools",
      name: "tools",
      kind: "slash-command",
      activation: "command",
      source: "t3",
      enabled: true,
      readonly: false,
      commandName: "tools",
    },
    {
      id: "provider:opencode:slash-command:compact",
      name: "compact",
      kind: "slash-command",
      activation: "command",
      source: "provider-native",
      enabled: true,
      readonly: true,
      commandName: "compact",
      providerInstanceId: opencodeInstance,
      provider: opencodeDriver,
    },
  ],
};

describe("capability composer helpers", () => {
  it("builds effective skill suggestions from T3 and selected provider capabilities", () => {
    expect(
      effectiveComposerSkills({
        capabilities,
        selectedProviderStatus: providerStatus,
      }).map((skill) => skill.name),
    ).toEqual(["random-subagent-test", "repo-workflow", "customize-opencode", "provider-only"]);
  });

  it("separates T3 and provider command capabilities", () => {
    expect(
      t3CommandCapabilities({ capabilities }).map((capability) => capability.commandName),
    ).toEqual(["tools"]);
    expect(
      providerCommandCapabilities({
        capabilities,
        selectedProviderStatus: providerStatus,
      }).map((capability) => capability.commandName),
    ).toEqual(["compact"]);
  });

  it("lists tools and subagents separately from dollar skills", () => {
    expect(toolRegistryCapabilities({ capabilities }).map((capability) => capability.id)).toEqual([
      "t3:tool:subagent",
    ]);
  });
});
