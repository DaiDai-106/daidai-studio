import { createHash } from "node:crypto";
import { constants, type Dirent } from "node:fs";
import { type FileHandle, open, readdir } from "node:fs/promises";
import { openDirectoryRoot, readFileResource } from "../../shared/node/file_access.ts";
import type { openProjectStore } from "../projects/store.ts";

const MAX_FILE_BYTES = 2 * 1024 * 1024;

function accessCode(error: unknown) {
  return error instanceof Error && "code" in error ? error.code : undefined;
}

function accessError(error: unknown, path: string): never {
  switch (accessCode(error)) {
    case "ENOENT":
      throw new Error(`文件或目录已不存在，请刷新后重试：${path || "项目根目录"}`);
    case "ENOTDIR":
    case "ELOOP":
      throw new Error(`路径不是可访问的目录或包含符号链接：${path || "项目根目录"}`);
    case "EACCES":
    case "EPERM":
      throw new Error(`没有权限访问：${path || "项目根目录"}`);
    default:
      throw error;
  }
}

function parts(path: string): string[] {
  if (!path) return [];
  const values = path.split("/");
  if (values.some((value) => !value || value === "." || value === ".." || value.includes("\0")))
    throw new Error("文件路径无效。");
  return values;
}

/** 目录句柄固定路径，并拒绝穿过符号链接。 */
async function directory(root: string, names: string[]): Promise<FileHandle> {
  if (process.platform !== "linux") throw new Error("当前系统暂不支持安全的代码文件访问。");
  const opened = await openDirectoryRoot(root);
  let handle = opened.handle;
  try {
    for (const name of names) {
      const child = await open(
        `/proc/self/fd/${handle.fd}/${name}`,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      await handle.close();
      handle = child;
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export function createCodingFileService(store: ReturnType<typeof openProjectStore>) {
  function project(id: string) {
    const value = store.getProject(id);
    if (value?.mode !== "coding") throw new Error("Coding 项目不存在。");
    return value;
  }

  async function listDirectory(projectId: string, path: string, offset: number, snapshot?: string) {
    const parent = await directory(project(projectId).path, parts(path));
    try {
      const entries = await readdir(`/proc/self/fd/${parent.fd}`, { withFileTypes: true });
      const visible = entries
        .filter((entry) => entry.isFile() || entry.isDirectory())
        .sort(
          (a, b) =>
            Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name),
        )
        .map((entry) => ({ name: entry.name, directory: entry.isDirectory() }));
      const revision = createHash("sha256").update(JSON.stringify(visible)).digest("hex");
      if (offset && snapshot !== revision) throw new Error("目录已变化，请重新展开以刷新。");
      return {
        snapshot: revision,
        entries: visible.slice(offset, offset + 200),
        nextOffset: offset + 200 < visible.length ? offset + 200 : null,
      };
    } finally {
      await parent.close();
    }
  }

  async function readFile(projectId: string, path: string) {
    const names = parts(path);
    if (!names.length) throw new Error("请选择文件。");
    const root = await openDirectoryRoot(project(projectId).path);
    try {
      const data = await readFileResource(root.handle, names, MAX_FILE_BYTES);
      if (data.includes(0)) throw new Error("不支持查看二进制文件。");
      let content: string;
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(data);
      } catch {
        throw new Error("仅支持 UTF-8 文本文件。");
      }
      return { content, version: createHash("sha256").update(data).digest("hex") };
    } finally {
      await root.handle.close();
    }
  }

  async function search(projectId: string, query: string) {
    const root = project(projectId).path;
    const needle = query.trim().toLowerCase();
    const pending = [""];
    const paths: string[] = [];
    let scanned = 0;
    const deadline = Date.now() + 1000;
    const ignored = new Set([
      ".git",
      "node_modules",
      ".venv",
      "venv",
      "dist",
      "build",
      "__pycache__",
    ]);
    while (pending.length) {
      if (Date.now() > deadline) return { paths, truncated: true };
      const path = pending.shift() ?? "";
      let entries: Dirent[];
      try {
        const parent = await directory(root, parts(path));
        try {
          entries = await readdir(`/proc/self/fd/${parent.fd}`, { withFileTypes: true });
        } finally {
          await parent.close();
        }
      } catch (error) {
        // 扫描中的子目录可能已删除、换成链接或不可读；根目录失败仍需告知用户。
        if (
          path &&
          ["ENOENT", "ENOTDIR", "ELOOP", "EACCES", "EPERM"].includes(String(accessCode(error)))
        )
          continue;
        accessError(error, path);
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (++scanned > 10_000 || paths.length >= 100 || Date.now() > deadline)
          return { paths, truncated: true };
        const child = path ? `${path}/${entry.name}` : entry.name;
        if (entry.isDirectory() && !ignored.has(entry.name) && child.split("/").length < 32)
          pending.push(child);
        else if (entry.isFile() && child.toLowerCase().includes(needle)) paths.push(child);
      }
    }
    return { paths, truncated: false };
  }

  async function list(projectId: string, path: string, offset: number, snapshot?: string) {
    try {
      return await listDirectory(projectId, path, offset, snapshot);
    } catch (error) {
      accessError(error, path);
    }
  }

  async function read(projectId: string, path: string) {
    try {
      return await readFile(projectId, path);
    } catch (error) {
      accessError(error, path);
    }
  }

  return { list, read, search };
}
