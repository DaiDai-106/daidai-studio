import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

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

export async function resolveStepPath(root: string, relativePath: string) {
  const parts = relativePath.split("/");
  if (
    isAbsolute(relativePath) ||
    relativePath.includes("\\") ||
    parts.some((part) => !part || part === "." || part === "..") ||
    !/\.(step|stp)$/i.test(relativePath)
  )
    throw new Error("请选择项目内的 STEP 相对路径。");
  let path = root;
  for (const part of parts) {
    path = join(path, part);
    if ((await lstat(path)).isSymbolicLink()) throw new Error("STEP 路径不能包含符号链接。");
  }
  if (!(await lstat(path)).isFile()) throw new Error("所选 STEP 不是普通文件。");
  const resolved = await realpath(path);
  const local = relative(await realpath(root), resolved);
  if (isAbsolute(local) || local === ".." || local.startsWith(`..${sep}`))
    throw new Error("STEP 不在当前项目内。");
  return { path: resolved, relativePath: local.split(sep).join("/") };
}
