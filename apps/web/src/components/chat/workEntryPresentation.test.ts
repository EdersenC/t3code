import { describe, expect, it } from "vite-plus/test";

import type { WorkLogEntry } from "../../session-logic";
import { buildWorkEntryDetailSections } from "./workEntryPresentation";

describe("buildWorkEntryDetailSections", () => {
  it("deduplicates identical command and output text", () => {
    const entry: WorkLogEntry = {
      id: "work-1",
      createdAt: "2026-06-30T00:00:00.000Z",
      label: "Bash",
      tone: "tool",
      command: "rg -n TODO src",
      detail: "rg -n TODO src",
    };

    expect(buildWorkEntryDetailSections(entry, undefined)).toEqual([
      {
        id: "command",
        label: "Command",
        text: "rg -n TODO src",
      },
    ]);
  });

  it("keeps command and output as separate labeled sections", () => {
    const entry: WorkLogEntry = {
      id: "work-2",
      createdAt: "2026-06-30T00:00:00.000Z",
      label: "Bash",
      tone: "tool",
      command: "rg -n TODO src",
      detail: "src/index.ts:12:// TODO",
    };

    expect(buildWorkEntryDetailSections(entry, undefined)).toEqual([
      {
        id: "command",
        label: "Command",
        text: "rg -n TODO src",
      },
      {
        id: "output",
        label: "Output",
        text: "src/index.ts:12:// TODO",
      },
    ]);
  });
});
