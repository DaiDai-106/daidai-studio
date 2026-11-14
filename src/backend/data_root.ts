import { constants } from "node:fs";
import { type FileHandle, lstat, mkdir, open } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { openDirectoryRoot } from "../shared/node/file_access.ts";

/** 首次创建数据根时，从已固定的现存祖先逐级创建，避免递归路径 mkdir 的竞态。 */
export async function openOrCreateDataRoot(
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
