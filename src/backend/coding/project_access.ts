import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join } from "node:path";
import {
  directoryHandlesAvailable,
  openDirectoryRoot,
  openRelativeDirectory,
  readBoundedFile,
  readFileResource,
} from "../../shared/node/file_access.ts";

const windows = process.platform === "win32";

function validName(name: string) {
  if (!name || name === "." || name === ".." || name.includes("\0")) return false;
  return (
    !windows ||
    (!/[\\:<>"|?*]|[. ]$/.test(name) &&
      !/^(?:con|prn|aux|nul|conin\$|conout\$|(?:com|lpt)[0-9¹²³])(?: *\.|$)/i.test(name))
  );
}

export function projectPathParts(path: string) {
  const parts = path ? path.split("/") : [];
  if (!parts.every(validName)) throw new Error("文件路径无效。");
  return parts;
}

function sameEntry(a: { dev: bigint; ino: bigint }, b: typeof a) {
  return a.dev === b.dev && a.ino === b.ino;
}

function linkedPath() {
  return Object.assign(new Error("路径不能经过符号链接。"), { code: "ELOOP" });
}

async function openProjectRoot(root: string) {
  const { path, handle } = await openDirectoryRoot(root);
  if (path === root) return handle;
  await handle.close();
  throw linkedPath();
}

/** 项目保存的是规范路径。拒绝被替换的根和经过链接或 Windows 联接的子路径。 */
async function inspect(path: string) {
  const info = await lstat(path, { bigint: true });
  if (info.isSymbolicLink() || (await realpath(path)) !== path) throw linkedPath();
  return info;
}

export async function withProjectDirectory<T>(
  root: string,
  parts: readonly string[],
  run: (path: string) => Promise<T>,
) {
  if (directoryHandlesAvailable) {
    const handle = await openProjectRoot(root);
    try {
      const directory = await openRelativeDirectory(handle, parts);
      try {
        return await run(`/proc/self/fd/${directory.fd}`);
      } finally {
        if (directory !== handle) await directory.close();
      }
    } finally {
      await handle.close();
    }
  }
  const path = join(root, ...parts);
  const before = await inspect(path);
  if (!before.isDirectory()) throw Object.assign(new Error("请选择目录。"), { code: "ENOTDIR" });
  const result = await run(path);
  if (!sameEntry(before, await inspect(path))) throw new Error("目录已变化，请刷新后重试。");
  return result;
}

export async function readProjectFile(root: string, parts: readonly string[], maxBytes: number) {
  if (directoryHandlesAvailable) {
    const handle = await openProjectRoot(root);
    try {
      return await readFileResource(handle, parts, maxBytes);
    } finally {
      await handle.close();
    }
  }
  const path = join(root, ...parts);
  const before = await inspect(path);
  if (!before.isFile()) throw new Error("只支持读取普通文件。");
  const flags = windows
    ? constants.O_RDONLY
    : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const file = await open(path, flags);
  try {
    if (!sameEntry(before, await file.stat({ bigint: true })))
      throw new Error("文件已变化，请刷新后重试。");
    const data = await readBoundedFile(file, maxBytes);
    if (!sameEntry(before, await inspect(path))) throw new Error("文件已变化，请刷新后重试。");
    return data;
  } finally {
    await file.close();
  }
}
