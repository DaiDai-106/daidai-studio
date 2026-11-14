import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

type Cached<T> = { data: T; at: number };

// 市场目录只有这一处定义；查询、来源关联和迁移都使用相同位置。
const catalogRoot = (dataRoot: string) => join(dataRoot, "catalog");

/** 启动时搬迁旧的共用目录；已有新目录时保留两边内容，不合并或覆盖配置。 */
export async function relocateCatalog(dataRoot: string) {
  const root = catalogRoot(dataRoot);
  try {
    await lstat(root);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    await rename(join(dataRoot, "agent", "catalog"), root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** 仅来源配置和安装来源落盘；目录元数据只在本进程复用。 */
export function createCatalogStorage(dataRoot: string) {
  const root = catalogRoot(dataRoot);
  const cache = new Map<string, Cached<unknown>>();
  const inflight = new Map<string, Promise<Cached<unknown>>>();
  async function read<T>(name: string, fallback: T): Promise<T> {
    try {
      return JSON.parse(await readFile(join(root, name), "utf8")) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
      throw new Error("插件目录配置损坏。", { cause: error });
    }
  }

  async function write(name: string, value: unknown) {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const temp = join(root, `${name}.${randomUUID()}.tmp`);
    await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
    await rename(temp, join(root, name));
  }

  async function cached<T>(key: string, refresh: boolean, load: () => Promise<T>) {
    const previous = cache.get(key) as Cached<T> | undefined;
    if (!refresh && previous && Date.now() - previous.at < 300_000)
      return { ...previous, stale: false, error: "" };

    // 同一条目共享进行中的请求，刷新失败时保留本进程的旧结果。
    let request = inflight.get(key) as Promise<Cached<T>> | undefined;
    if (!request) {
      request = Promise.resolve()
        .then(load)
        .then((data) => {
          const result = { data, at: Date.now() };
          cache.delete(key);
          cache.set(key, result);
          if (cache.size > 100) cache.delete(cache.keys().next().value as string);
          return result;
        });
      inflight.set(key, request);
    }
    try {
      return { ...(await request), stale: false, error: "" };
    } catch (error) {
      if (!previous) throw error;
      const message = error instanceof Error ? error.message : "操作失败。";
      return { ...previous, stale: true, error: message.slice(0, 2000) };
    } finally {
      if (inflight.get(key) === request) inflight.delete(key);
    }
  }

  return { root, read, write, cached };
}
