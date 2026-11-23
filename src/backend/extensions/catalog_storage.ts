import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { writeJson } from "../../shared/node/write_json.ts";

type Cached<T> = { data: T; at: number };

/** 仅来源配置和安装来源落盘；目录元数据只在本进程复用。 */
export function createCatalogStorage(dataRoot: string) {
  const root = join(dataRoot, "catalog");
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
    await writeJson(join(root, name), value);
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
