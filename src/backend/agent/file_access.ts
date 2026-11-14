import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

type Options = {
  cwd: string;
  skillRoots?: readonly string[] | (() => readonly string[]);
  fullAccess?: () => boolean;
};

const SPECIAL_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

function normalizeInput(input: string, cwd: string): string {
  let path = input.replace(SPECIAL_SPACES, " ");
  if (path.startsWith("@")) path = path.slice(1);

  if (process.platform === "win32" && !path.includes("\\")) {
    const match = path.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
    if (match) path = `${match[1]?.toUpperCase()}:\\${(match[2] ?? "").replaceAll("/", "\\")}`;
  }
  if (path === "~") path = homedir();
  else if (path.startsWith("~/") || (process.platform === "win32" && path.startsWith("~\\")))
    path = join(homedir(), path.slice(2));
  if (path.startsWith("file://")) path = fileURLToPath(path);

  return resolve(cwd, path);
}

function isWithinRoot(root: string, path: string) {
  const value = relative(root, path);
  return value === "" || (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

async function canonicalTarget(path: string, allowMissing: boolean): Promise<string> {
  const suffix: string[] = [];
  let cursor = path;

  for (;;) {
    try {
      await lstat(cursor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !allowMissing) throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      suffix.unshift(basename(cursor));
      cursor = parent;
      continue;
    }

    // 已存在但目标缺失的符号链接不能当作普通待创建路径。
    return resolve(await realpath(cursor), ...suffix);
  }
}

/** 只约束 Pi 基础文件工具；它不是已批准 shell 或第三方包的沙箱。 */
export async function validateFileToolPath(options: Options & { path: string; write: boolean }) {
  if (!options.path || options.path.includes("\0")) throw new Error("文件路径无效。");
  const cwd = await realpath(options.cwd);
  const target = await canonicalTarget(normalizeInput(options.path, cwd), options.write);
  if (isWithinRoot(cwd, target)) return;

  if (!options.write) {
    const roots =
      typeof options.skillRoots === "function" ? options.skillRoots() : (options.skillRoots ?? []);
    for (const path of roots) {
      try {
        if (isWithinRoot(await realpath(path), target)) return;
      } catch {
        /* 失效的技能不授予访问。 */
      }
    }
  }

  throw new Error("文件路径不在项目目录或明确授权的文件范围内。");
}

export function createFileAccess(options: Options): ExtensionFactory {
  return (pi) => {
    pi.on("tool_call", async (event) => {
      const reading = ["read", "ls", "find", "grep"].includes(event.toolName);
      const writing = ["write", "edit"].includes(event.toolName);
      if (!reading && !writing) return;
      const raw = (event.input as Record<string, unknown>).path;
      const path = raw === undefined && ["ls", "find", "grep"].includes(event.toolName) ? "." : raw;
      if (typeof path !== "string") return { block: true, reason: "文件路径无效。" };
      if (options.fullAccess?.()) return;
      try {
        await validateFileToolPath({ ...options, path, write: writing });
      } catch {
        return { block: true, reason: "文件路径不在项目目录或明确授权的文件范围内。" };
      }
    });
  };
}
