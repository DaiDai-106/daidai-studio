import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { devNull } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import type { createCodingFileService } from "./file_service.ts";
import { projectPathParts, withProjectDirectory } from "./project_access.ts";

const execute = promisify(execFile);
const MAX_FILES = 200;
const MAX_OUTPUT = 2 * 1024 * 1024;
type Git = (args: string[]) => Promise<string>;

function status(git: Git, path: string) {
  return git([
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--no-renames",
    "--ignore-submodules=dirty",
    "--",
    path,
  ]);
}

function safeRelativePath(path: string) {
  if (!projectPathParts(path).length) throw new Error("文件路径无效。");
  return path;
}

async function gitExecutable() {
  if (process.platform !== "win32") return "git";
  // Git for Windows 只从 PATH 中的绝对目录查找，避免执行项目里的 git.exe。
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const path = directory.replace(/^"(.*)"$/, "$1");
    if (!isAbsolute(path)) continue;
    const executable = join(path, "git.exe");
    if ((await stat(executable).catch(() => undefined))?.isFile()) return executable;
  }
  throw new Error("找不到 Git。请安装 Git for Windows 并将它加入 PATH，然后重启应用。");
}

/** Git 只读取项目范围内的状态与差异，不启用外部 diff、textconv 或 shell。 */
export function createCodingGitService(files: ReturnType<typeof createCodingFileService>) {
  async function withGit<T>(
    projectId: string,
    path: string,
    run: (git: Git, prefix: string) => Promise<T>,
  ) {
    const root = files.projectPath(projectId);
    const executable = await gitExecutable();
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)),
    );
    Object.assign(env, {
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
      GIT_ALLOW_PROTOCOL: "",
      LC_ALL: "C",
    });
    return withProjectDirectory(root, [], async (cwd) => {
      let filterOverrides: string[] = [];
      const git = async (
        args: string[],
        { allowNoMatch = false, input }: { allowNoMatch?: boolean; input?: string } = {},
      ) => {
        try {
          const execution = execute(
            executable,
            [
              "--no-pager",
              "--literal-pathspecs",
              "-c",
              "core.fsmonitor=false",
              "-c",
              `core.hooksPath=${devNull}`,
              ...filterOverrides,
              ...args,
            ],
            {
              cwd,
              env,
              windowsHide: true,
              timeout: 10_000,
              maxBuffer: MAX_OUTPUT,
              encoding: "utf8",
            },
          );
          // 子进程提前退出时，执行结果负责报告错误。
          execution.child.stdin?.on("error", () => {});
          execution.child.stdin?.end(input);
          const result = await execution;
          return result.stdout;
        } catch (error) {
          const value = error as NodeJS.ErrnoException & { stderr?: string; killed?: boolean };
          const stderr = value.stderr?.trim();
          if (allowNoMatch && Number(value.code) === 1 && !stderr) return "";
          if (value.code === "ENOENT") throw new Error("找不到 Git，无法查看工作区差异。");
          if (stderr?.includes("not a git repository"))
            throw new Error("当前项目目录不在 Git 仓库中。");
          if (value.killed || value.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
            throw new Error("Git 结果过大或读取超时。");
          throw new Error(`无法读取 Git 状态或差异：${stderr || value.message}`);
        }
      };
      const location = await git(["rev-parse", "--is-inside-work-tree", "--show-prefix"]);
      const insideWorkTree = /^true\r?\n/.exec(location);
      if (!insideWorkTree) throw new Error("当前项目目录不在 Git 工作树中。");
      const prefix = location.slice(insideWorkTree[0].length).replace(/\r?\n$/, "");
      // status 和 diff 可能调用 clean/process。配置了过滤器时先检查项目文件的属性；
      // 属性读取自身不会运行过滤器，无法安全检查时拒绝继续。
      const filters = await git(["config", "--null", "--name-only", "--get-regexp", "^filter\\."], {
        allowNoMatch: true,
      });
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
          path,
        ]);
        const paths = [...new Set(listed.split("\0").filter(Boolean))];
        if (paths.length) {
          for (const path of paths) safeRelativePath(path);
          const output = await git(["check-attr", "--stdin", "-z", "filter"], {
            input: `${paths.join("\0")}\0`,
          });
          const fields = output.split("\0");
          if (fields.length !== paths.length * 3 + 1)
            throw new Error("未能检查全部 Git 文件属性。");
          for (let i = 2; i < fields.length; i += 3) {
            if (fields[i] !== "unspecified" && fields[i] !== "unset")
              throw new Error("项目文件使用 Git 过滤器，暂不支持安全读取差异。");
          }
        }
      }
      return run(git, prefix);
    });
  }

  async function changes(projectId: string) {
    return withGit(projectId, ".", async (git, prefix) => {
      const result = await status(git, ".");
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
      const untracked = await withGit(projectId, path, async (git, prefix) =>
        (await status(git, path)).split("\0").includes(`?? ${prefix}${path}`),
      );
      if (!untracked) throw new Error("文件不再是未跟踪文件，请刷新变更列表。");
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
    return withGit(projectId, path, async (git) => ({
      patch: await git([
        "diff",
        ...(kind === "staged" ? ["--cached"] : []),
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "--ignore-submodules=dirty",
        "--submodule=short",
        "--unified=3",
        "--",
        path,
      ]),
      untracked: false,
    }));
  }

  return { changes, diff };
}
