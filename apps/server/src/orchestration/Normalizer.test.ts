import { describe, expect, it } from "vite-plus/test";

import {
  extractLocalMarkdownImageReferences,
  resolveLocalMarkdownImagePath,
} from "./Normalizer.ts";

describe("Normalizer local markdown images", () => {
  it("maps Windows Codex clipboard image paths to WSL-readable local paths", () => {
    expect(
      resolveLocalMarkdownImagePath(
        "C:\\Users\\theki\\AppData\\Local\\Temp\\codex-clipboard-local.png",
        "linux",
      ),
    ).toBe("/mnt/c/Users/theki/AppData/Local/Temp/codex-clipboard-local.png");
  });

  it("maps WSL UNC Codex clipboard image paths to Linux local paths", () => {
    expect(
      resolveLocalMarkdownImagePath(
        "\\\\wsl.localhost\\Ubuntu\\tmp\\codex-clipboard-unc.png",
        "linux",
      ),
    ).toBe("/tmp/codex-clipboard-unc.png");
    expect(
      resolveLocalMarkdownImagePath(
        "file://wsl.localhost/Ubuntu/tmp/codex-clipboard-file-url.png",
        "linux",
      ),
    ).toBe("/tmp/codex-clipboard-file-url.png");
  });

  it("rejects non-Codex clipboard local image paths", () => {
    expect(resolveLocalMarkdownImagePath("/etc/codex-clipboard-secret.png", "linux")).toBeNull();
    expect(
      resolveLocalMarkdownImagePath(
        "C:\\Users\\theki\\Pictures\\codex-clipboard-secret.png",
        "linux",
      ),
    ).toBeNull();
    expect(resolveLocalMarkdownImagePath("/tmp/random-screenshot.png", "linux")).toBeNull();
  });

  it("extracts local markdown image references without treating remote images as files", () => {
    const references = extractLocalMarkdownImageReferences(
      "see ![clipboard](<C:/Users/theki/AppData/Local/Temp/codex-clipboard-1.png>) and ![remote](https://example.com/image.png)",
      "linux",
    );

    expect(references).toHaveLength(1);
    expect(references[0]?.alt).toBe("clipboard");
    expect(references[0]?.mimeType).toBe("image/png");
    expect(references[0]?.localPath).toBe(
      "/mnt/c/Users/theki/AppData/Local/Temp/codex-clipboard-1.png",
    );
  });
});
