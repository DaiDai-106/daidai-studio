import { lstat, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";

/** Resolve a project-owned data directory without trusting a model-supplied path. */
export async function projectDataDirectory(dataRoot: string, projectId: string) {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(projectId)) throw new Error("项目身份无效。");
  let path = await realpath(dataRoot);
  for (const name of ["projects", projectId]) {
    path = join(path, name);
    await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("项目数据目录不可用。");
  }
  return path;
}
