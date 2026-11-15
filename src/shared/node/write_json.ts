import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";

/** 调用方负责目录和写入排队；失败时不留下半份配置或临时文件。 */
export async function writeJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
