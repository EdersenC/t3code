// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect, it } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { localModelHubTestExports } from "./LocalModelHub.ts";

const hubPaths = {
  modelRoot: "/models",
  defaultModelRoot: "/state/models",
  huggingFaceRoot: "/models/huggingface",
  ollamaRoot: "/models/ollama",
};

describe("LocalModelHub Hugging Face metadata", () => {
  it("reports installed Hugging Face model sizes from local files", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-local-model-hub-"));
    try {
      const modelPath = NodePath.join(root, "huggingface", "owner", "model");
      await NodeFSP.mkdir(modelPath, { recursive: true });
      await NodeFSP.writeFile(NodePath.join(modelPath, "model.safetensors"), Buffer.alloc(10));
      await NodeFSP.mkdir(NodePath.join(modelPath, ".cache"), { recursive: true });
      await NodeFSP.writeFile(NodePath.join(modelPath, ".cache", "ignored.bin"), Buffer.alloc(50));

      const models = await localModelHubTestExports.listHuggingFaceModels({
        modelRoot: root,
        defaultModelRoot: root,
        huggingFaceRoot: NodePath.join(root, "huggingface"),
        ollamaRoot: NodePath.join(root, "ollama"),
      });

      expect(models).toHaveLength(1);
      expect(models[0]?.modelId).toBe("owner/model");
      expect(models[0]?.sizeBytes).toBe(10);
      expect(models[0]?.metadata.totalSizeBytes).toBe(10);
      expect(models[0]?.metadata.fileCount).toBe(1);
      expect(models[0]?.format).toBe("safetensors");
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("maps remote Hugging Face detail size and release date", () => {
    const model = localModelHubTestExports.mapHuggingFaceApiModel(
      {
        id: "openai/gpt-oss-20b",
        createdAt: "2025-08-04T22:33:29.000Z",
        lastModified: "2025-08-26T17:25:47.000Z",
        usedStorage: 41_382_448_021,
        siblings: [{ rfilename: "model.safetensors" }],
      },
      hubPaths,
      new Set(),
    );

    expect(model?.sizeBytes).toBe(41_382_448_021);
    expect(model?.metadata.totalSizeBytes).toBe(41_382_448_021);
    expect(model?.metadata.releaseDate).toBe("2025-08-04T22:33:29.000Z");
    expect(model?.metadata.updatedAt).toBe("2025-08-26T17:25:47.000Z");
  });

  it("falls back to sibling file sizes when usedStorage is missing", () => {
    const model = localModelHubTestExports.mapHuggingFaceApiModel(
      {
        id: "owner/model",
        siblings: [
          { rfilename: "model-00001-of-00002.safetensors", size: 10 },
          { rfilename: "model-00002-of-00002.safetensors", size: 15 },
          { rfilename: "README.md" },
        ],
      },
      hubPaths,
      new Set(),
    );

    expect(model?.sizeBytes).toBe(25);
    expect(model?.metadata.totalSizeBytes).toBe(25);
    expect(model?.metadata.fileCount).toBe(3);
  });
});
