import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
  isWithinPath,
  matchesProtectedFiles,
  nearestExistingPath,
} from "../../shared/node/file_access.ts";

type Options = {
  cwd: string;
  skillRoots?: readonly string[] | (() => readonly string[]);
  fullAccess?: () => boolean;
  protectedWriteDirectory?: string;
  protectedPrivateKeys?: ReadonlySet<string> | undefined;
  readableOutputs?: ReadonlySet<string>;
};

const SPECIAL_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const outsideProjectMessage = "文件路径不在项目目录或明确授权的文件范围内。";
const protectedWriteMessage = "应用管理的 MCP 配置不能由项目文件工具修改。";
const protectedKeyMessage = "项目文件工具无法访问 MCP 设备私钥。请缩小搜索范围。";

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

/** 校验工具路径，可按字面值保留文件名中的空格和前缀。 */
export async function validateFileToolPath(
  options: Options & {
    path: string;
    write: boolean;
    literal?: boolean;
    allowOutsideProject?: boolean;
    recursiveSearch?: boolean;
  },
) {
  if (!options.path || options.path.includes("\0")) throw new Error("文件路径无效。");
  const cwd = await realpath(options.cwd);
  const input = options.literal ? resolve(cwd, options.path) : normalizeInput(options.path, cwd);
  const { path: existing } = await nearestExistingPath(input, options.write);
  const target = resolve(await realpath(existing), relative(existing, input));
  if (await matchesProtectedFiles(target, options.protectedPrivateKeys, options.recursiveSearch))
    throw new Error(protectedKeyMessage);
  if (options.write && !options.allowOutsideProject && options.protectedWriteDirectory) {
    const directory = options.protectedWriteDirectory;
    if (isWithinPath(directory, input) || isWithinPath(directory, target))
      throw new Error(protectedWriteMessage);
  }
  if (options.allowOutsideProject || isWithinPath(cwd, target)) return target;

  if (!options.write) {
    if (options.readableOutputs?.has(target)) return target;
    const roots =
      typeof options.skillRoots === "function" ? options.skillRoots() : (options.skillRoots ?? []);
    for (const path of roots) {
      try {
        if (isWithinPath(await realpath(path), target)) return target;
      } catch {
        /* 失效的技能不授予访问。 */
      }
    }
  }

  throw new Error(outsideProjectMessage);
}

export function createFileAccess(
  options: Options & { literalFilePaths?: boolean },
): ExtensionFactory {
  const { readableOutputs, ...filePaths } = options;
  return (pi) => {
    pi.on("tool_call", async (event) => {
      const reading = ["read", "ls", "find", "grep"].includes(event.toolName);
      const writing = ["write", "edit"].includes(event.toolName);
      if (!reading && !writing) return;
      const input = event.input as Record<string, unknown>;
      const raw = input.path;
      const path = raw === undefined && reading && event.toolName !== "read" ? "." : raw;
      if (typeof path !== "string") return { block: true, reason: "文件路径无效。" };
      const literal = options.literalFilePaths === true && (writing || event.toolName === "read");
      const fullAccess = options.fullAccess?.() === true;
      if (fullAccess && !literal && !options.protectedPrivateKeys?.size) return;
      try {
        const target = await validateFileToolPath({
          ...filePaths,
          ...(event.toolName === "read" && readableOutputs ? { readableOutputs } : {}),
          path: literal && path.startsWith("file://") ? fileURLToPath(path) : path,
          write: writing,
          literal,
          allowOutsideProject: fullAccess,
          recursiveSearch: event.toolName === "grep",
        });
        // Pi 会先归一化空格再解码 file URL，编码后的路径能保留实际文件名。
        if (literal) input.path = pathToFileURL(target).href;
      } catch (error) {
        return {
          block: true,
          reason:
            error instanceof Error &&
            (error.message === protectedWriteMessage || error.message === protectedKeyMessage)
              ? error.message
              : outsideProjectMessage,
        };
      }
    });
  };
}
