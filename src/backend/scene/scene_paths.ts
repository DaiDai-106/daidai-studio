import { constants, lstatSync, realpathSync, statSync } from "node:fs";
import { type FileHandle, lstat, mkdir, open } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { DataRootIdentity } from "../../contracts/process.ts";
import { openDirectoryRoot } from "../../shared/node/file_access.ts";

export type RootIdentity = DataRootIdentity;

/** 首次创建数据根时，从已固定的现存祖先逐级创建，避免递归路径 mkdir 的竞态。 */
export async function openOrCreateSceneDataRoot(
  dataRoot: string,
): Promise<{ path: string; handle: FileHandle }> {
  let ancestor = resolve(dataRoot);
  const missing: string[] = [];
  let root: Awaited<ReturnType<typeof openDirectoryRoot>>;
  for (;;) {
    try {
      root = await openDirectoryRoot(ancestor);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(ancestor) === ancestor)
        throw error;
      missing.unshift(basename(ancestor));
      ancestor = dirname(ancestor);
    }
  }
  const handles: { path: string; handle: FileHandle }[] = [root];
  const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  try {
    let parent = root;
    for (const part of missing) {
      const pinned = `/proc/self/fd/${parent.handle.fd}/${part}`;
      try {
        await mkdir(pinned, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const handle = await open(pinned, flags);
      parent = { path: join(parent.path, part), handle };
      handles.push(parent);
    }
    for (const entry of handles) {
      const [expected, actual] = await Promise.all([entry.handle.stat(), lstat(entry.path)]);
      if (
        !actual.isDirectory() ||
        actual.isSymbolicLink() ||
        expected.dev !== actual.dev ||
        expected.ino !== actual.ino
      )
        throw new Error("数据根目录在创建期间发生变化。");
    }
    for (const entry of handles.slice(0, -1)) await entry.handle.close();
    return parent;
  } catch (error) {
    await Promise.allSettled(handles.map(({ handle }) => handle.close()));
    throw error;
  }
}

/** 数据根可以由用户指定；其下各级必须是真实目录，不能通过链接跳出根目录。 */
export async function ensureSceneDirectory(
  dataRoot: string,
  projectId: string,
  expectedRoot?: RootIdentity,
): Promise<string> {
  if (!/^[a-f0-9-]{36}$/.test(projectId)) throw new Error("项目身份无效。");
  const root = await openDirectoryRoot(dataRoot, expectedRoot);
  let path = root.path;
  const handles: { handle: FileHandle; path: string }[] = [];
  const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  try {
    handles.push({ handle: root.handle, path });
    let parent = root.handle;
    for (const part of ["projects", projectId, "scene"]) {
      const pinned = `/proc/self/fd/${parent.fd}/${part}`;
      try {
        await mkdir(pinned);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      let child: FileHandle;
      try {
        child = await open(pinned, flags);
      } catch {
        throw new Error("场景数据目录包含符号链接或不可用。");
      }
      path = join(path, part);
      handles.push({ handle: child, path });
      parent = child;
    }
    // 目录创建均相对于固定句柄；路径被移动后不返回可能指向别处的路径。
    for (const entry of handles) {
      const [expected, actual] = await Promise.all([entry.handle.stat(), lstat(entry.path)]);
      if (
        !actual.isDirectory() ||
        actual.isSymbolicLink() ||
        expected.dev !== actual.dev ||
        expected.ino !== actual.ino
      )
        throw new Error("场景数据目录在创建期间发生变化。");
    }
    return path;
  } finally {
    await Promise.allSettled(handles.reverse().map(({ handle }) => handle.close()));
  }
}

/** 受控资源交给桌面协议之前，重新验证文件及每级父目录。 */
export function validateSceneResource(
  dataRoot: string,
  projectId: string,
  file: string,
  hash: string,
  expectedRoot?: RootIdentity,
): void {
  if (!/^[a-f0-9-]{36}$/.test(projectId) || !/^[a-f0-9]{64}$/.test(hash))
    throw new Error("场景资源身份无效。");
  let parent = realpathSync(dataRoot);
  if (expectedRoot) {
    const rootInfo = statSync(parent, { bigint: true });
    if (
      rootInfo.dev.toString() !== expectedRoot.dev ||
      rootInfo.ino.toString() !== expectedRoot.ino
    )
      throw new Error("场景数据根目录身份已变化，请重启应用检查配置。");
  }
  for (const part of ["projects", projectId, "scene", "resources"]) {
    const path = join(parent, part);
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isDirectory() || realpathSync(path) !== path)
      throw new Error("场景资源目录包含符号链接或不可用。");
    parent = path;
  }
  const expected = join(parent, `${hash}.glb`);
  if (basename(file) !== `${hash}.glb` || realpathSync(dirname(file)) !== parent)
    throw new Error("场景资源不在受控目录中。");
  const info = lstatSync(expected);
  if (info.isSymbolicLink() || !info.isFile() || realpathSync(expected) !== expected)
    throw new Error("场景资源包含符号链接或不可用。");
}
