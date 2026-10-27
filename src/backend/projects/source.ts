import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";

export { resolveStepPath } from "../../../resources/mcp/scene-profiles/steps.ts";

// Hash the actual bounded source bytes; callers freeze this version for one run.
export async function fileHash(path: string, limit: number, signal?: AbortSignal) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit)
    throw new Error("文件类型或大小不符合限制。");
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(path, signal ? { signal } : {})) {
    size += chunk.length;
    if (size > limit) throw new Error("读取期间文件超过大小限制。");
    hash.update(chunk);
  }
  return { sha256: hash.digest("hex"), size };
}
