import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
// 安装前复核绕过元数据缓存，仍可能与搜索同时访问同一裸仓库。
const requests = new Map<string, Promise<unknown>>();

function gitUrl(source: string) {
  const url = new URL(source.slice(4));
  const valid =
    url.protocol === "https:"
      ? !url.username
      : url.protocol === "ssh:" && (!url.username || url.username === "git");
  if (!valid || url.password || url.search || url.hash || url.pathname === "/")
    throw new Error("Git 来源需要不含密码的 HTTPS 或 SSH 仓库地址。");
  return url.href;
}

export function companyCatalogUrl(source: string) {
  const value = source.trim();
  if (!value) return "";
  if (value.startsWith("git:")) return `git:${gitUrl(value)}`;
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search)
    throw new Error("公司目录需要 HTTPS JSON 地址或 git:HTTPS/SSH 仓库地址。");
  return url.href;
}

export function allowedCompanyPackage(source: string) {
  if (source.startsWith("npm:"))
    return /^npm:(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[\w.+-]+)?$/.test(source);
  try {
    gitUrl(source.startsWith("git:") ? source : `git:${source}`);
    return true;
  } catch {
    return false;
  }
}

/** 裸仓库只读取 catalog.json，不检出文件、不执行包代码；认证沿用系统 Git。 */
export function readGitCatalog(root: string, source: string): Promise<unknown> {
  const url = gitUrl(source);
  const directory = join(root, "git", createHash("sha256").update(url).digest("hex"));
  const current = requests.get(directory);
  if (current) return current;

  const request = (async () => {
    const signal = AbortSignal.timeout(20_000);
    const options = {
      signal,
      maxBuffer: 4_000_000,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GCM_INTERACTIVE: "never",
        SSH_ASKPASS_REQUIRE: "never",
      },
    };
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await execute("git", ["init", "--bare", "--quiet", directory], options);
      await execute(
        "git",
        ["-C", directory, "fetch", "--quiet", "--depth=1", "--no-tags", "--", url, "HEAD"],
        options,
      );
      const { stdout } = await execute(
        "git",
        ["-C", directory, "show", "FETCH_HEAD:catalog.json"],
        options,
      );
      return JSON.parse(stdout);
    } catch (error) {
      throw new Error(
        "无法读取公司 Git 目录，请检查系统 Git 凭据、网络及仓库根目录的 catalog.json。",
        { cause: error },
      );
    }
  })();
  requests.set(directory, request);
  void request.finally(() => requests.delete(directory)).catch(() => {});
  return request;
}
