import { constants } from "node:fs";
import { type FileHandle, lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, sep } from "node:path";
import type { DataRootIdentity } from "../../contracts/process.ts";

const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
export const directoryHandlesAvailable =
  process.platform === "linux" && !!constants.O_NOFOLLOW && !!constants.O_DIRECTORY;

export function isWithinPath(root: string, target: string) {
  const path = relative(root, target);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

export async function matchesProtectedFiles(
  target: string,
  protectedFiles: ReadonlySet<string> | undefined,
  recursive = false,
) {
  if (!protectedFiles) return false;
  for (const path of protectedFiles) {
    if (!relative(target, path)) return true;
    const canonical = await realpath(path).catch(() => undefined);
    if (!canonical) continue;
    if (
      !relative(target, canonical) ||
      (recursive && (isWithinPath(target, canonical) || isWithinPath(target, path)))
    )
      return true;
  }
  return false;
}

/** 用 lstat 查找现有路径，保留悬空符号链接供调用方检查。 */
export async function nearestExistingPath(path: string, allowMissing: boolean) {
  for (let candidate = path; ; candidate = dirname(candidate)) {
    try {
      return { path: candidate, info: await lstat(candidate) };
    } catch (error) {
      if (
        !allowMissing ||
        (error as NodeJS.ErrnoException).code !== "ENOENT" ||
        candidate === dirname(candidate)
      )
        throw error;
    }
  }
}

/** 打开相对于已固定目录的子目录。空路径返回调用方的根句柄。 */
export async function openRelativeDirectory(root: FileHandle, parts: readonly string[]) {
  let handle = root;
  try {
    for (const part of parts) {
      const parent = handle;
      handle = await open(`/proc/self/fd/${parent.fd}/${part}`, directoryFlags);
      if (parent !== root) await parent.close();
    }
    return handle;
  } catch (error) {
    if (handle !== root) await handle.close();
    throw error;
  }
}

/** 从文件系统根逐级固定根目录，避免祖先目录在 realpath 后被替换为链接。 */
export async function openDirectoryRoot(
  dataRoot: string,
  expectedRoot?: DataRootIdentity,
): Promise<{ path: string; handle: FileHandle }> {
  if (!directoryHandlesAvailable) throw new Error("当前系统不支持安全的目录句柄。");
  const path = await realpath(dataRoot);
  const root = await open("/", directoryFlags);
  let handle = root;
  try {
    handle = await openRelativeDirectory(root, path.split("/").filter(Boolean));
    if (handle !== root) await root.close();
    if (expectedRoot) {
      const info = await handle.stat({ bigint: true });
      if (info.dev.toString() !== expectedRoot.dev || info.ino.toString() !== expectedRoot.ino)
        throw new Error("数据根目录身份已变化，请重启应用检查配置。");
    }
    return { path, handle };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** parts 由调用边界校验；根句柄归调用方，所有子句柄在读取完成后释放。 */
export async function readFileResource(
  root: FileHandle,
  parts: readonly string[],
  maxBytes: number,
  signal?: AbortSignal,
) {
  const parent = await openRelativeDirectory(root, parts.slice(0, -1));
  try {
    const name = parts.at(-1);
    if (!name) throw new Error("请选择文件。");
    const file = await open(
      `/proc/self/fd/${parent.fd}/${name}`,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      return await readBoundedFile(file, maxBytes, signal);
    } finally {
      await file.close();
    }
  } finally {
    if (parent !== root) await parent.close();
  }
}

export async function readBoundedFile(file: FileHandle, maxBytes: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const info = await file.stat();
  if (!info.isFile() || info.size > maxBytes)
    throw new Error(`文件不是普通文件或超过 ${maxBytes / 1024 / 1024} MiB。`);
  // 按已知尺寸分配。额外预留一个字节，检查读取期间是否增长。
  let data = Buffer.allocUnsafe(info.size + 1);
  let length = 0;
  for (;;) {
    signal?.throwIfAborted();
    const size = Math.min(data.length - length, 1024 * 1024);
    const { bytesRead } = await file.read(data, length, size, length);
    signal?.throwIfAborted();
    if (!bytesRead) return data.subarray(0, length);
    length += bytesRead;
    if (length > maxBytes) throw new Error(`文件超过 ${maxBytes / 1024 / 1024} MiB。`);
    if (length === data.length) {
      const grown = Buffer.allocUnsafe(Math.min(data.length * 2, maxBytes + 1));
      data.copy(grown);
      data = grown;
    }
  }
}
