import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, type Stats } from "node:fs";
import { lstat, mkdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { CadResource } from "../../../resources/mcp/cad/contract.ts";

// Resolve every component, refusing links on both the plugin and project side.
export async function localFile(root: string, path: string, byteLength?: number) {
  const base = await realpath(root);
  const local = relative(base, path);
  if (!local || isAbsolute(local) || local === ".." || local.startsWith(`..${sep}`))
    throw new Error("显示资源不在授权目录内。");
  let current = base;
  let info: Stats | undefined;
  const parts = local.split(sep);
  for (const part of parts) {
    current = join(current, part);
    info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error("显示资源路径不能包含符号链接。");
  }
  if (!info?.isFile() || (byteLength !== undefined && info.size !== byteLength))
    throw new Error("显示资源类型或大小不匹配。");
  return current;
}

export async function artifactDirectory(sceneRoot: string) {
  const current = join(await realpath(sceneRoot), "artifacts");
  try {
    await mkdir(current, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const info = await lstat(current);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("项目产物目录不可用。");
  return current;
}

export async function copyResource(
  path: string,
  destination: string,
  resource: CadResource,
  signal: AbortSignal,
) {
  const hash = createHash("sha256");
  let bytes = 0;
  await pipeline(
    createReadStream(path),
    new Transform({
      transform(chunk: Buffer, _encoding, next) {
        bytes += chunk.length;
        if (bytes > resource.byteLength) return next(new Error("显示资源读取时大小发生变化。"));
        hash.update(chunk);
        next(null, chunk);
      },
    }),
    createWriteStream(destination, { flags: "wx", mode: 0o600 }),
    { signal },
  );
  if (bytes !== resource.byteLength || hash.digest("hex") !== resource.sha256)
    throw new Error("显示资源大小或哈希不匹配。");
}

export async function readMetadata(path: string): Promise<unknown> {
  if ((await stat(path)).size > 32 * 1024 * 1024) throw new Error("显示清单超过大小限制。");
  return JSON.parse(await readFile(path, "utf8"));
}
