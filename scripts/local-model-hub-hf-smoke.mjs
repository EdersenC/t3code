import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { downloadHuggingFaceModelSnapshot } from "../apps/server/src/localModelHub/LocalModelHub.ts";

function readArg(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  return process.argv[index + 1] ?? null;
}

async function directoryHasFile(path) {
  try {
    const entries = await NodeFSP.readdir(path, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile()) return true;
      if (entry.isDirectory() && (await directoryHasFile(NodePath.join(path, entry.name)))) {
        return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

const modelId = readArg("--model") ?? "sshleifer/tiny-gpt2";
const root = readArg("--root") ?? NodePath.join(NodeOS.tmpdir(), "t3code-local-model-hub-smoke");
const targetPath = NodePath.join(root, "huggingface", ...modelId.split("/"));

console.log(`Downloading ${modelId} into ${targetPath}`);
await NodeFSP.rm(targetPath, { recursive: true, force: true });
await downloadHuggingFaceModelSnapshot({
  modelId,
  targetPath,
  token: process.env.HF_TOKEN,
  onLog: (line) => console.log(line),
});

if (!(await directoryHasFile(targetPath))) {
  throw new Error(`Smoke download finished without any files under ${targetPath}`);
}

console.log(`Smoke download verified: ${targetPath}`);
