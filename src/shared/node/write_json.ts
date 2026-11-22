import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";

/** 调用方负责目录和写入排队；失败时不留下半份配置或临时文件。 */
export async function writeAtomic(
  path: string,
  content: string | Uint8Array,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, {
      mode: 0o600,
      flag: "wx",
      signal,
    });
    signal?.throwIfAborted();
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function writeJson(path: string, value: unknown, signal?: AbortSignal): Promise<void> {
  return writeAtomic(path, `${JSON.stringify(value, null, 2)}\n`, signal);
}
