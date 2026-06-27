import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import {
  type ChatAttachment,
  type ClientOrchestrationCommand,
  type OrchestrationCommand,
  OrchestrationDispatchCommandError,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@t3tools/contracts";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import { createAttachmentId, resolveAttachmentPath } from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import {
  inferImageMimeTypeFromFileName,
  parseBase64DataUrl,
  sniffImageMimeType,
} from "../imageMime.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";

const CODEX_CLIPBOARD_IMAGE_BASENAME_PATTERN =
  /^codex-clipboard-[a-z0-9_-]+\.(?:bmp|gif|jpe?g|png|webp)$/i;

interface MarkdownImageToken {
  readonly markdown: string;
  readonly alt: string;
  readonly rawDestination: string;
}

export interface LocalMarkdownImageReference {
  readonly markdown: string;
  readonly alt: string;
  readonly destination: string;
  readonly localPath: string;
  readonly name: string;
  readonly mimeType: string;
}

function findUnescaped(text: string, needle: string, startIndex: number): number {
  for (let index = startIndex; index < text.length; index += 1) {
    if (text[index] !== needle) continue;
    let slashCount = 0;
    for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) {
      slashCount += 1;
    }
    if (slashCount % 2 === 0) return index;
  }
  return -1;
}

function findMarkdownImageTokens(text: string): ReadonlyArray<MarkdownImageToken> {
  const tokens: Array<MarkdownImageToken> = [];
  let cursor = 0;

  while (cursor < text.length) {
    const start = text.indexOf("![", cursor);
    if (start === -1) break;

    const altEnd = findUnescaped(text, "]", start + 2);
    if (altEnd === -1 || text[altEnd + 1] !== "(") {
      cursor = start + 2;
      continue;
    }

    const destinationStart = altEnd + 2;
    let destinationEnd = -1;
    if (text[destinationStart] === "<") {
      const angleEnd = findUnescaped(text, ">", destinationStart + 1);
      if (angleEnd !== -1) {
        destinationEnd = findUnescaped(text, ")", angleEnd + 1);
      }
    } else {
      let nestedParens = 0;
      for (let index = destinationStart; index < text.length; index += 1) {
        const char = text[index];
        if (char === "\\") {
          index += 1;
          continue;
        }
        if (char === "(") {
          nestedParens += 1;
          continue;
        }
        if (char === ")") {
          if (nestedParens === 0) {
            destinationEnd = index;
            break;
          }
          nestedParens -= 1;
        }
      }
    }

    if (destinationEnd === -1) {
      cursor = start + 2;
      continue;
    }

    tokens.push({
      markdown: text.slice(start, destinationEnd + 1),
      alt: text.slice(start + 2, altEnd).trim(),
      rawDestination: text.slice(destinationStart, destinationEnd),
    });
    cursor = destinationEnd + 1;
  }

  return tokens;
}

function trimMarkdownImageDestination(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  if (trimmed.startsWith("<")) {
    const closeIndex = findUnescaped(trimmed, ">", 1);
    return closeIndex > 1 ? trimmed.slice(1, closeIndex).trim() || null : null;
  }

  const quote = trimmed[0];
  if (quote === '"' || quote === "'") {
    const closeIndex = findUnescaped(trimmed, quote, 1);
    return closeIndex > 1 ? trimmed.slice(1, closeIndex).trim() || null : null;
  }

  const firstToken = /^(\S+)/.exec(trimmed)?.[1] ?? "";
  const unquoted = firstToken.replace(/^(['"])(.*)\1$/, "$2").trim();
  return unquoted.length > 0 ? unquoted : null;
}

function isRemoteOrDataDestination(destination: string): boolean {
  if (/^[a-zA-Z]:[\\/]/.test(destination)) return false;
  return /^[a-z][a-z0-9+.-]*:/i.test(destination) && !/^file:/i.test(destination);
}

function windowsDrivePathToWslPath(pathName: string): string | null {
  const match = /^([a-zA-Z]):[\\/](.*)$/.exec(pathName);
  if (!match) return null;
  const drive = match[1]!.toLowerCase();
  const rest = match[2]!.replace(/[\\/]+/g, "/");
  return "/mnt/" + drive + "/" + rest;
}

function wslUncPathToLinuxPath(pathName: string): string | null {
  const normalized = pathName.replace(/^[\\/]+/, "").replace(/[\\/]+/g, "/");
  const match = /^(?:wsl\.localhost|wsl\$)\/[^/]+\/(.*)$/i.exec(normalized);
  return match?.[1] ? "/" + match[1] : null;
}

function fileUrlToLocalPath(destination: string, platform: NodeJS.Platform): string | null {
  try {
    const url = new URL(destination);
    if (url.protocol !== "file:") return null;
    if (url.hostname) {
      const unc = wslUncPathToLinuxPath("//" + url.hostname + decodeURIComponent(url.pathname));
      return platform === "win32" ? null : unc;
    }
    let localPath = decodeURIComponent(url.pathname);
    if (/^\/[a-zA-Z]:[/]/.test(localPath)) {
      localPath = localPath.slice(1);
    }
    return localPath;
  } catch {
    return null;
  }
}

function basenameFromPath(pathName: string): string {
  const normalized = pathName.replace(/[\\/]+$/, "");
  const basename = normalized.split(/[\\/]/).at(-1)?.trim();
  return basename && basename.length > 0 ? basename : "image";
}

function isAllowedCodexClipboardImagePath(localPath: string): boolean {
  const basename = basenameFromPath(localPath);
  if (!CODEX_CLIPBOARD_IMAGE_BASENAME_PATTERN.test(basename)) return false;

  const normalized = localPath.replace(/[\\/]+/g, "/").toLowerCase();
  return (
    /^\/tmp\/codex-clipboard-[^/]+\.(?:bmp|gif|jpe?g|png|webp)$/i.test(normalized) ||
    /^\/var\/folders\/[^/]+\/[^/]+\/t\/codex-clipboard-[^/]+\.(?:bmp|gif|jpe?g|png|webp)$/i.test(
      normalized,
    ) ||
    /^\/mnt\/[a-z]\/users\/[^/]+\/appdata\/local\/temp\/codex-clipboard-[^/]+\.(?:bmp|gif|jpe?g|png|webp)$/i.test(
      normalized,
    ) ||
    /^[a-z]:\/users\/[^/]+\/appdata\/local\/temp\/codex-clipboard-[^/]+\.(?:bmp|gif|jpe?g|png|webp)$/i.test(
      normalized,
    )
  );
}

export function resolveLocalMarkdownImagePath(
  rawDestination: string,
  platform: NodeJS.Platform,
): string | null {
  const destination = trimMarkdownImageDestination(rawDestination);
  if (!destination || isRemoteOrDataDestination(destination)) return null;

  let localPath = /^file:/i.test(destination)
    ? fileUrlToLocalPath(destination, platform)
    : (wslUncPathToLinuxPath(destination) ?? destination);
  if (!localPath) return null;

  const wslPath = windowsDrivePathToWslPath(localPath);
  if (wslPath) {
    localPath = platform === "win32" ? localPath.replaceAll("/", "\\") : wslPath;
  }

  if (!localPath.startsWith("/") && !/^[a-zA-Z]:[\\/]/.test(localPath)) return null;
  return isAllowedCodexClipboardImagePath(localPath) ? localPath : null;
}

export function extractLocalMarkdownImageReferences(
  text: string,
  platform: NodeJS.Platform,
): ReadonlyArray<LocalMarkdownImageReference> {
  const references: Array<LocalMarkdownImageReference> = [];
  for (const token of findMarkdownImageTokens(text)) {
    const destination = trimMarkdownImageDestination(token.rawDestination);
    if (!destination) continue;

    const localPath = resolveLocalMarkdownImagePath(destination, platform);
    if (!localPath) continue;

    const mimeType = inferImageMimeTypeFromFileName(localPath);
    if (!mimeType?.startsWith("image/")) continue;

    references.push({
      markdown: token.markdown,
      alt: token.alt,
      destination,
      localPath,
      name: basenameFromPath(localPath),
      mimeType,
    });
  }
  return references;
}

function rewriteLocalMarkdownImages(
  text: string,
  references: ReadonlyArray<LocalMarkdownImageReference>,
): string {
  let nextText = text;
  for (const reference of references) {
    const replacement = reference.alt
      ? "[attached image: " + reference.alt + "]"
      : "[attached image]";
    nextText = nextText.replace(reference.markdown, replacement);
  }
  return nextText;
}

export const normalizeDispatchCommand = (command: ClientOrchestrationCommand) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const serverConfig = yield* ServerConfig;
    const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
    const platform = yield* HostProcessPlatform;

    const normalizeProjectWorkspaceRoot = (workspaceRoot: string) =>
      workspacePaths.normalizeWorkspaceRoot(workspaceRoot).pipe(
        Effect.mapError(
          (cause) =>
            new OrchestrationDispatchCommandError({
              message: cause.message,
            }),
        ),
      );

    const normalizeProjectWorkspaceRootForCreate = (
      workspaceRoot: string,
      createIfMissing: boolean | undefined,
    ) =>
      workspacePaths
        .normalizeWorkspaceRoot(workspaceRoot, {
          createIfMissing: createIfMissing === true,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationDispatchCommandError({
                message: cause.message,
              }),
          ),
        );

    const persistImageAttachment = (input: {
      readonly name: string;
      readonly mimeType: string;
      readonly bytes: Uint8Array;
      readonly sourceLabel: string;
      readonly threadId: string;
    }): Effect.Effect<ChatAttachment, OrchestrationDispatchCommandError> =>
      Effect.gen(function* () {
        if (
          !input.mimeType.startsWith("image/") ||
          input.bytes.byteLength === 0 ||
          input.bytes.byteLength > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
        ) {
          return yield* new OrchestrationDispatchCommandError({
            message: "Image attachment '" + input.name + "' is empty, too large, or unsupported.",
          });
        }

        const attachmentId = createAttachmentId(input.threadId);
        if (!attachmentId) {
          return yield* new OrchestrationDispatchCommandError({
            message: "Failed to create a safe attachment id.",
          });
        }

        const persistedAttachment: ChatAttachment = {
          type: "image",
          id: attachmentId,
          name: input.name,
          mimeType: input.mimeType.toLowerCase(),
          sizeBytes: input.bytes.byteLength,
        };

        const attachmentPath = resolveAttachmentPath({
          attachmentsDir: serverConfig.attachmentsDir,
          attachment: persistedAttachment,
        });
        if (!attachmentPath) {
          return yield* new OrchestrationDispatchCommandError({
            message: "Failed to resolve persisted path for '" + input.sourceLabel + "'.",
          });
        }

        yield* fileSystem.makeDirectory(path.dirname(attachmentPath), { recursive: true }).pipe(
          Effect.mapError(
            () =>
              new OrchestrationDispatchCommandError({
                message: "Failed to create attachment directory for '" + input.sourceLabel + "'.",
              }),
          ),
        );
        yield* fileSystem.writeFile(attachmentPath, input.bytes).pipe(
          Effect.mapError(
            () =>
              new OrchestrationDispatchCommandError({
                message: "Failed to persist attachment '" + input.sourceLabel + "'.",
              }),
          ),
        );

        return persistedAttachment;
      });

    if (command.type === "project.create") {
      return {
        ...command,
        workspaceRoot: yield* normalizeProjectWorkspaceRootForCreate(
          command.workspaceRoot,
          command.createWorkspaceRootIfMissing,
        ),
        createWorkspaceRootIfMissing: command.createWorkspaceRootIfMissing === true,
      } satisfies OrchestrationCommand;
    }

    if (command.type === "project.meta.update" && command.workspaceRoot !== undefined) {
      return {
        ...command,
        workspaceRoot: yield* normalizeProjectWorkspaceRoot(command.workspaceRoot),
      } satisfies OrchestrationCommand;
    }

    if (command.type !== "thread.turn.start") {
      return command as OrchestrationCommand;
    }

    const localImageReferences = extractLocalMarkdownImageReferences(
      command.message.text,
      platform,
    );
    if (
      command.message.attachments.length + localImageReferences.length >
      PROVIDER_SEND_TURN_MAX_ATTACHMENTS
    ) {
      return yield* new OrchestrationDispatchCommandError({
        message:
          "Too many image attachments. Remove some pasted/uploaded images or local markdown image links and try again.",
      });
    }

    const uploadedAttachments = yield* Effect.forEach(
      command.message.attachments,
      (attachment) =>
        Effect.gen(function* () {
          const parsed = parseBase64DataUrl(attachment.dataUrl);
          if (!parsed || !parsed.mimeType.startsWith("image/")) {
            return yield* new OrchestrationDispatchCommandError({
              message: "Invalid image attachment payload for '" + attachment.name + "'.",
            });
          }

          return yield* persistImageAttachment({
            name: attachment.name,
            mimeType: parsed.mimeType,
            bytes: Buffer.from(parsed.base64, "base64"),
            sourceLabel: attachment.name,
            threadId: command.threadId,
          });
        }),
      { concurrency: 1 },
    );

    const markdownAttachments = yield* Effect.forEach(
      localImageReferences,
      (reference) =>
        Effect.gen(function* () {
          const bytes = yield* fileSystem.readFile(reference.localPath).pipe(
            Effect.mapError(
              () =>
                new OrchestrationDispatchCommandError({
                  message:
                    "Could not read local image at '" +
                    reference.destination +
                    "' (resolved to '" +
                    reference.localPath +
                    "'). Attach the image file directly, or use a path this server can read. Windows paths from WSL usually need to be available under /mnt/<drive>/.",
                }),
            ),
          );

          const sniffedMimeType = sniffImageMimeType(bytes);
          if (!sniffedMimeType) {
            return yield* new OrchestrationDispatchCommandError({
              message:
                "Local image at '" + reference.destination + "' is not a supported raster image.",
            });
          }

          return yield* persistImageAttachment({
            name: reference.name,
            mimeType: sniffedMimeType,
            bytes,
            sourceLabel: reference.destination,
            threadId: command.threadId,
          });
        }),
      { concurrency: 1 },
    );

    return {
      ...command,
      message: {
        ...command.message,
        text: rewriteLocalMarkdownImages(command.message.text, localImageReferences),
        attachments: [...uploadedAttachments, ...markdownAttachments],
      },
    } satisfies OrchestrationCommand;
  });
