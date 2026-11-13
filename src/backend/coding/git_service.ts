import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { openDirectoryRoot } from "../../shared/node/file_access.ts";
import type { openProjectStore } from "../projects/store.ts";
import type { createCodingFileService } from "./file_service.ts";

const execute = promisify(execFile);
const MAX_FILES = 200;
const MAX_OUTPUT = 2 * 1024 * 1024;

function safeRelativePath(path: string) {
  if (
    !path ||
    path.split("/").some((part) => !part || part === "." || part === ".." || part.includes("\0"))
  )
    throw new Error("文件路径无效。");
  return path;
}

/** Git 只读取项目范围内的状态与差异，不启用外部 diff、textconv 或 shell。 */
export function createCodingGitService(
  store: ReturnType<typeof openProjectStore>,
  files: ReturnType<typeof createCodingFileService>,
) {
  async function withGit<T>(
    projectId: string,
    run: (git: (args: string[]) => Promise<string>) => Promise<T>,
  ) {
    const project = store.getProject(projectId);
    if (project?.mode !== "coding") throw new Error("Coding 项目不存在。");
    if (process.platform !== "linux") throw new Error("当前系统暂不支持安全的 Git 差异读取。");
    const root = await openDirectoryRoot(project.path);
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
    );
    Object.assign(env, {
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
    });
    let filterOverrides: string[] = [];
    const git = async (args: string[], allowNoMatch = false) => {
      try {
        const result = await execute(
          "git",
          [
            "--literal-pathspecs",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.hooksPath=/dev/null",
            ...filterOverrides,
            ...args,
          ],
          {
            cwd: `/proc/self/fd/${root.handle.fd}`,
            env,
            timeout: 10_000,
            maxBuffer: MAX_OUTPUT,
            encoding: "utf8",
          },
        );
        return result.stdout;
      } catch (error) {
        const value = error as NodeJS.ErrnoException & { stderr?: string; killed?: boolean };
        if (allowNoMatch && Number(value.code) === 1 && !value.stderr?.trim()) return "";
        if (value.code === "ENOENT") throw new Error("找不到 Git，无法查看工作区差异。");
        if (value.killed || value.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
          throw new Error("Git 结果过大或读取超时。");
        throw new Error(`无法读取 Git 状态或差异：${value.stderr?.trim() || value.message}`);
      }
    };
    try {
      // status 和 diff 可能调用 clean/process。配置了过滤器时先检查项目文件的属性；
      // 属性读取自身不会运行过滤器，无法安全检查时拒绝继续。
      const filters = await git(
        ["config", "--null", "--name-only", "--get-regexp", "^filter\\."],
        true,
      );
      if (filters) {
        const names = new Set<string>();
        for (const key of filters.split("\0").filter(Boolean)) {
          const match = /^filter\.(.+)\.(?:clean|smudge|process|required)$/iu.exec(key);
          if (!match) continue;
          const name = match[1];
          if (!name || !/^[a-z0-9_.-]{1,100}$/iu.test(name))
            throw new Error("Git 过滤器名称不受支持，无法安全读取差异。");
          names.add(name);
        }
        if (names.size > 100) throw new Error("Git 过滤器过多，无法安全读取差异。");
        filterOverrides = [...names].flatMap((name) => [
          "-c",
          `filter.${name}.clean=`,
          "-c",
          `filter.${name}.smudge=`,
          "-c",
          `filter.${name}.process=`,
          "-c",
          `filter.${name}.required=false`,
        ]);
        const listed = await git([
          "ls-files",
          "-z",
          "--cached",
          "--others",
          "--exclude-standard",
          "--",
          ".",
        ]);
        const paths = [...new Set(listed.split("\0").filter(Boolean))];
        if (paths.length > 5000) throw new Error("项目文件过多，无法安全检查 Git 过滤器。");
        let batch: string[] = [];
        let length = 0;
        async function checkBatch() {
          if (!batch.length) return;
          const output = await git(["check-attr", "-z", "filter", "--", ...batch]);
          const fields = output.split("\0");
          for (let i = 2; i < fields.length; i += 3) {
            if (fields[i] && fields[i] !== "unspecified" && fields[i] !== "unset")
              throw new Error("项目文件使用 Git 过滤器，暂不支持安全读取差异。");
          }
          batch = [];
          length = 0;
        }
        for (const path of paths) {
          safeRelativePath(path);
          if (batch.length >= 128 || length + path.length > 30_000) await checkBatch();
          batch.push(path);
          length += path.length;
        }
        await checkBatch();
      }
      return await run(git);
    } finally {
      await root.handle.close();
    }
  }

  async function changes(projectId: string) {
    return withGit(projectId, async (git) => {
      const prefix = (await git(["rev-parse", "--show-prefix"])).replace(/\n$/, "");
      const result = await git([
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--no-renames",
        "--",
        ".",
      ]);
      const rows = result.split("\0").filter(Boolean);
      const entries = rows.map((row) => {
        const status = row.slice(0, 2);
        const name = row.slice(3);
        if (!name.startsWith(prefix)) throw new Error("Git 返回了项目目录外的路径。");
        const path = safeRelativePath(name.slice(prefix.length));
        return {
          path,
          staged: status[0] !== " " && status[0] !== "?",
          unstaged: status[1] !== " " && status[1] !== "?",
          untracked: status === "??",
        };
      });
      return { entries: entries.slice(0, MAX_FILES), truncated: entries.length > MAX_FILES };
    });
  }

  async function diff(projectId: string, path: string, kind: "staged" | "unstaged" | "untracked") {
    safeRelativePath(path);
    if (kind === "untracked") {
      const current = await changes(projectId);
      if (!current.entries.some((entry) => entry.path === path && entry.untracked))
        throw new Error("文件不再是未跟踪文件，请刷新变更列表。");
      const file = await files.read(projectId, path);
      if (file.content.length > 200_000 || file.content.split("\n").length > 5000)
        throw new Error("未跟踪文件过大，无法显示差异。");
      const lines = file.content.split("\n");
      if (file.content.endsWith("\n")) lines.pop();
      return {
        patch: file.content ? lines.map((line) => `+${line}`).join("\n") : "",
        untracked: true,
      };
    }
    return withGit(projectId, async (git) => ({
      patch: await git([
        "diff",
        ...(kind === "staged" ? ["--cached"] : []),
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "--unified=3",
        "--",
        path,
      ]),
      untracked: false,
    }));
  }

  return { changes, diff };
}
