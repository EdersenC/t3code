import type { WorkLogEntry } from "../../session-logic";
import {
  workEntryIndicatesToolFailure,
  workEntryIndicatesToolNeutralStatus,
  workEntryIndicatesToolSuccess,
} from "../../session-logic";
import { formatWorkspaceRelativePath } from "../../filePathDisplay";
import { normalizeCompactToolLabel } from "./MessagesTimeline.logic";

export type WorkEntryStatus = "failed" | "completed" | "running" | "empty";

export interface WorkEntryDetailSection {
  readonly id: "mcp" | "command" | "output" | "files";
  readonly label: string;
  readonly text: string;
}

function capitalizePhrase(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return value;
  }
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
}

export function workEntryHeading(workEntry: WorkLogEntry): string {
  if (!workEntry.toolTitle) {
    return capitalizePhrase(normalizeCompactToolLabel(workEntry.label));
  }
  return capitalizePhrase(normalizeCompactToolLabel(workEntry.toolTitle));
}

export function workEntryPreview(
  workEntry: Pick<WorkLogEntry, "detail" | "command" | "changedFiles">,
  workspaceRoot: string | undefined,
) {
  if (workEntry.command) return workEntry.command;
  if (workEntry.detail) return workEntry.detail;
  if ((workEntry.changedFiles?.length ?? 0) === 0) return null;
  const [firstPath] = workEntry.changedFiles ?? [];
  if (!firstPath) return null;
  const displayPath = formatWorkspaceRelativePath(firstPath, workspaceRoot);
  return workEntry.changedFiles!.length === 1
    ? displayPath
    : `${displayPath} +${workEntry.changedFiles!.length - 1} more`;
}

function workEntryRawCommand(
  workEntry: Pick<WorkLogEntry, "command" | "rawCommand">,
): string | null {
  const rawCommand = workEntry.rawCommand?.trim();
  if (!rawCommand || !workEntry.command) {
    return null;
  }
  return rawCommand === workEntry.command.trim() ? null : rawCommand;
}

function normalizeDetailText(value: string): string {
  return value.replace(/\r\n/g, "\n").trim();
}

function pushUniqueSection(
  sections: WorkEntryDetailSection[],
  section: WorkEntryDetailSection | null,
) {
  if (!section || section.text.trim().length === 0) {
    return;
  }
  const normalized = normalizeDetailText(section.text);
  if (
    sections.some((entry) =>
      entry.id === section.id ? normalizeDetailText(entry.text) === normalized : false,
    )
  ) {
    return;
  }
  if (
    section.id === "output" &&
    sections.some(
      (entry) => entry.id === "command" && normalizeDetailText(entry.text) === normalized,
    )
  ) {
    return;
  }
  sections.push(section);
}

export function buildWorkEntryDetailSections(
  workEntry: WorkLogEntry,
  workspaceRoot: string | undefined,
): WorkEntryDetailSection[] {
  const sections: WorkEntryDetailSection[] = [];
  if (workEntry.itemType === "mcp_tool_call" && workEntry.toolData !== undefined) {
    pushUniqueSection(sections, {
      id: "mcp",
      label: "MCP call",
      text: JSON.stringify(workEntry.toolData, null, 2),
    });
  }
  const raw = workEntryRawCommand(workEntry);
  if (raw?.trim()) {
    pushUniqueSection(sections, { id: "command", label: "Command", text: raw.trim() });
  } else if (workEntry.command?.trim()) {
    pushUniqueSection(sections, {
      id: "command",
      label: "Command",
      text: workEntry.command.trim(),
    });
  }
  if (workEntry.detail?.trim()) {
    pushUniqueSection(sections, { id: "output", label: "Output", text: workEntry.detail.trim() });
  }
  const changedFiles = workEntry.changedFiles ?? [];
  if (changedFiles.length > 0) {
    pushUniqueSection(sections, {
      id: "files",
      label: "Files",
      text: changedFiles
        .map((filePath) => formatWorkspaceRelativePath(filePath, workspaceRoot))
        .join("\n"),
    });
  }
  return sections;
}

export function buildWorkEntryExpandedBody(
  workEntry: WorkLogEntry,
  workspaceRoot: string | undefined,
): string | null {
  const sections = buildWorkEntryDetailSections(workEntry, workspaceRoot);
  return sections.length > 0
    ? sections.map((section) => `${section.label}\n${section.text}`).join("\n\n")
    : null;
}

export function resolveWorkEntryStatus(
  workEntry: WorkLogEntry,
  turnSettled: boolean,
): WorkEntryStatus {
  if (workEntryIndicatesToolFailure(workEntry)) {
    return "failed";
  }
  if (workEntryIndicatesToolSuccess(workEntry)) {
    return "completed";
  }
  if (!turnSettled && workEntryIndicatesToolNeutralStatus(workEntry)) {
    return "running";
  }
  return turnSettled && workEntryIndicatesToolNeutralStatus(workEntry) ? "completed" : "empty";
}

export function workEntryStatusLabel(status: WorkEntryStatus): string {
  switch (status) {
    case "failed":
      return "Failed";
    case "completed":
      return "Completed";
    case "running":
      return "Running";
    case "empty":
      return "No output";
  }
}
