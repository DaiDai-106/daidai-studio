import type { Dirent } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

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

export async function listSteps(root: string) {
  const files: string[] = [];
  const pending = [root];
  let inspected = 0;
  let complete = true;
  while (pending.length && inspected < 2000 && files.length < 200) {
    const directory = pending.pop();
    if (!directory) break;
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (directory === root) throw error;
      complete = false;
      continue;
    }
    for (const entry of entries) {
      if (++inspected > 2000 || files.length >= 200) {
        complete = false;
        break;
      }
      if (entry.isSymbolicLink() || entry.name.startsWith(".") || entry.name === "node_modules")
        continue;
      const path = join(directory, entry.name);
      const local = relative(root, path);
      if (entry.isDirectory()) {
        if (local.split(sep).length < 6) pending.push(path);
        else complete = false;
      } else if (entry.isFile() && /\.(step|stp)$/i.test(entry.name)) {
        files.push(local.split(sep).join("/"));
      }
    }
  }
  return { files: files.sort(), complete: complete && pending.length === 0 };
}
