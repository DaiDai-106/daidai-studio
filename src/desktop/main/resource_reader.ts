import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, realpathSync } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { DataRootIdentity, ResourceLocation } from "../../contracts/process.ts";

const MAX_RESOURCE_BYTES = 256 * 1024 * 1024;
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

type Hooks = {
  beforeDirectoryOpen?: (name: string) => void | Promise<void>;
  afterDirectoryOpen?: (name: string) => void | Promise<void>;
  afterFileOpen?: () => void | Promise<void>;
};

/** 把已配置的数据根固定为目录句柄，后续不再按可变的绝对路径寻找资源。 */
export function createSceneResourceReader(
  dataRoot: string,
  hooks: Hooks = {},
  fixedRootFd?: number,
) {
  if (process.platform !== "linux") {
    return {
      identity: undefined as DataRootIdentity | undefined,
      async read(
        _resource: ResourceLocation,
        _hash: string,
        _signal?: AbortSignal,
      ): Promise<Buffer> {
        throw new Error("当前系统暂不支持安全的场景资源读取。");
      },
      close() {},
    };
  }

  let root: number;
  if (fixedRootFd !== undefined) {
    // 复制已固定的目录句柄，不重新解析配置路径。
    root = openSync(`/proc/self/fd/${fixedRootFd}/.`, directoryFlags);
  } else {
    const canonical = realpathSync(dataRoot);
    if (!isAbsolute(canonical)) throw new Error("数据根目录无效。");
    root = openSync("/", directoryFlags);
    try {
      for (const part of canonical.split("/").filter(Boolean)) {
        const next = openSync(`/proc/self/fd/${root}/${part}`, directoryFlags);
        closeSync(root);
        root = next;
      }
    } catch (error) {
      closeSync(root);
      throw error;
    }
  }
  const rootStat = fstatSync(root, { bigint: true });
  const identity: DataRootIdentity = { dev: rootStat.dev.toString(), ino: rootStat.ino.toString() };
  let closed = false;
  let active = 0;
  let rootClosed = false;

  function closeRootIfIdle() {
    if (closed && !active && !rootClosed) {
      closeSync(root);
      rootClosed = true;
    }
  }

  return {
    identity,
    async read(resource: ResourceLocation, hash: string, signal?: AbortSignal): Promise<Buffer> {
      if (closed) throw new Error("场景资源读取器已关闭。");
      if (!/^[a-f0-9-]{36}$/.test(resource.projectId) || !/^[a-f0-9]{64}$/.test(hash))
        throw new Error("场景资源身份无效。");
      if (
        !Number.isSafeInteger(resource.byteLength) ||
        resource.byteLength < 0 ||
        resource.byteLength > MAX_RESOURCE_BYTES
      )
        throw new Error("场景资源大小无效。");
      if (active >= 2) throw new Error("场景资源读取繁忙，请重试。");

      active++;
      const handles: FileHandle[] = [];
      try {
        signal?.throwIfAborted();
        let directory = root;
        for (const part of ["projects", resource.projectId, "scene", "resources"]) {
          await hooks.beforeDirectoryOpen?.(part);
          signal?.throwIfAborted();
          const handle = await open(`/proc/self/fd/${directory}/${part}`, directoryFlags);
          handles.push(handle);
          directory = handle.fd;
          await hooks.afterDirectoryOpen?.(part);
          signal?.throwIfAborted();
        }

        const file = await open(
          `/proc/self/fd/${directory}/${hash}.glb`,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        handles.push(file);
        const info = await file.stat();
        if (!info.isFile() || info.size !== resource.byteLength)
          throw new Error("场景资源大小不匹配。");
        await hooks.afterFileOpen?.();
        signal?.throwIfAborted();
        // 先把受控大小的数据拷入独立缓冲并校验，再向前端发送；不在校验后重读同一 inode。
        const buffer = Buffer.alloc(resource.byteLength);
        let offset = 0;
        while (offset < buffer.length) {
          signal?.throwIfAborted();
          const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
          if (!bytesRead) throw new Error("场景资源读取不完整。");
          offset += bytesRead;
        }

        const after = await file.stat();
        if (
          after.size !== resource.byteLength ||
          createHash("sha256").update(buffer).digest("hex") !== hash
        )
          throw new Error("场景资源完整性校验失败。");
        signal?.throwIfAborted();
        return buffer;
      } finally {
        try {
          await Promise.all(handles.reverse().map((handle) => handle.close()));
        } finally {
          active--;
          closeRootIfIdle();
        }
      }
    },

    close() {
      if (closed) return;
      closed = true;
      // 仍有读取时保留根句柄，避免描述符被其他目录重用。
      closeRootIfIdle();
    },
  };
}
