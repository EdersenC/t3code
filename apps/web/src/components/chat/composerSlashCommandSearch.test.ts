import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind } from "@t3tools/contracts";

import type { ComposerCommandItem } from "./ComposerCommandMenu";
import { searchSlashCommandItems } from "./composerSlashCommandSearch";

describe("searchSlashCommandItems", () => {
  const claudeDriver = ProviderDriverKind.make("claudeAgent");

  it("moves exact provider command matches ahead of broader description matches", () => {
    const items = [
      {
        id: "slash:default",
        type: "slash-command",
        command: "default",
        label: "/default",
        description: "Switch this thread back to normal build mode",
      },
      {
        id: "provider-slash-command:claudeAgent:ui",
        type: "provider-slash-command",
        provider: claudeDriver,
        command: { name: "ui" },
        label: "/ui",
        description: "Explore, build, and refine UI.",
      },
      {
        id: "provider-slash-command:claudeAgent:frontend-design",
        type: "provider-slash-command",
        provider: claudeDriver,
        command: { name: "frontend-design" },
        label: "/frontend-design",
        description: "Create distinctive, production-grade frontend interfaces",
      },
    ] satisfies Array<
      Extract<
        ComposerCommandItem,
        { type: "slash-command" | "provider-slash-command" | "capability-slash-command" }
      >
    >;

    expect(searchSlashCommandItems(items, "ui").map((item) => item.id)).toEqual([
      "provider-slash-command:claudeAgent:ui",
      "slash:default",
    ]);
  });

  it("supports fuzzy provider command matches", () => {
    const items = [
      {
        id: "provider-slash-command:claudeAgent:gh-fix-ci",
        type: "provider-slash-command",
        provider: claudeDriver,
        command: { name: "gh-fix-ci" },
        label: "/gh-fix-ci",
        description: "Fix failing GitHub Actions",
      },
      {
        id: "provider-slash-command:claudeAgent:github",
        type: "provider-slash-command",
        provider: claudeDriver,
        command: { name: "github" },
        label: "/github",
        description: "General GitHub help",
      },
    ] satisfies Array<
      Extract<
        ComposerCommandItem,
        { type: "slash-command" | "provider-slash-command" | "capability-slash-command" }
      >
    >;

    expect(searchSlashCommandItems(items, "gfc").map((item) => item.id)).toEqual([
      "provider-slash-command:claudeAgent:gh-fix-ci",
    ]);
  });

  it("searches T3 command capabilities by command name and description", () => {
    const items = [
      {
        id: "slash:compact",
        type: "slash-command",
        command: "compact",
        label: "/compact",
        description: "Ask the provider to compact the conversation context",
      },
      {
        id: "capability-slash-command:t3:command:tools",
        type: "capability-slash-command",
        capability: {
          id: "t3:command:tools",
          name: "tools",
          kind: "slash-command",
          activation: "command",
          source: "t3",
          enabled: true,
          readonly: false,
          commandName: "tools",
          description: "Open the T3 subagent registry.",
        },
        commandName: "tools",
        label: "/tools",
        description: "Open the T3 subagent registry.",
        sourceLabel: "T3",
      },
    ] satisfies Array<
      Extract<
        ComposerCommandItem,
        { type: "slash-command" | "provider-slash-command" | "capability-slash-command" }
      >
    >;

    expect(searchSlashCommandItems(items, "sub").map((item) => item.id)).toEqual([
      "capability-slash-command:t3:command:tools",
    ]);
  });
});
