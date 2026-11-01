import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  DefaultPackageManager,
  type ResolvedPaths,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

type Scope = "user" | "project";

export type PackageInfo = {
  source: string;
  scope: Scope;
  enabled: boolean;
  filtered: boolean;
  installedPath?: string;
};

type Options = {
  dataRoot: string;
  projectId?: string;
  cwd?: string;
};

// 项目之间共享全局包配置，必须使用同一队列避免并发写入互相覆盖。
const operations = new Map<string, Promise<unknown>>();

function readText(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, text, { mode: 0o600 });
  renameSync(temporary, path);
}

/** Pi 的项目作用域放在 Dai 数据根，避免修改用户工作目录或 ~/.pi。 */
export function createPackageService({ dataRoot, projectId, cwd }: Options) {
  if (!isAbsolute(dataRoot)) throw new Error("数据目录必须是绝对路径。");
  if (projectId !== undefined && !/^[a-zA-Z0-9_-]{1,128}$/.test(projectId)) {
    throw new Error("无效的项目 ID。");
  }
  const root = resolve(dataRoot);
  const packageRoot = join(root, "packages");
  const projectRoot = join(packageRoot, "projects", projectId ?? "_global");
  const globalSettings = join(packageRoot, "settings.json");
  const projectSettings = join(projectRoot, "settings.json");
  const disabledPath = join(packageRoot, "disabled.json");
  const settings = SettingsManager.fromStorage(
    {
      withLock(scope, update) {
        const path = scope === "global" ? globalSettings : projectSettings;
        const current = readText(path);
        const next = update(current);
        if (next !== undefined && next !== current) writeText(path, next);
      },
    },
    { projectTrusted: true },
  );
  // Pi 的 project package 安装目录依赖 cwd；此处使用受控目录，绝不写用户项目下的 .pi。
  const manager = new DefaultPackageManager({
    cwd: join(projectRoot, "workspace"),
    agentDir: join(packageRoot, "agent"),
    settingsManager: settings,
  });

  function scopeOptions(scope: Scope) {
    if (scope !== "user" && scope !== "project") throw new Error("无效的包作用域。");
    if (scope === "project" && !projectId) throw new Error("项目作用域需要项目 ID。");
    return { local: scope === "project" };
  }

  function normalizeSource(source: string): string {
    const value = source.trim();
    if (!value) throw new Error("包来源不能为空。");
    if (value.startsWith("./") || value.startsWith("../")) {
      if (!cwd) throw new Error("相对路径需要项目工作目录。");
      return resolve(cwd, value);
    }
    return value;
  }

  function disabledKey(source: string, scope: Scope): string {
    return JSON.stringify(scope === "user" ? [scope, source] : [scope, projectId, source]);
  }

  function displaySource(source: string, scope: Scope): string {
    // Pi 将本地包写成相对设置目录的路径；对应用展示和索引使用稳定绝对路径。
    if (source === "." || source.startsWith("./") || source.startsWith("../")) {
      return resolve(
        scope === "user" ? join(packageRoot, "agent") : join(projectRoot, "workspace", ".pi"),
        source,
      );
    }
    return source;
  }

  function disabled(): Set<string> {
    const value: unknown = JSON.parse(readText(disabledPath) ?? "[]");
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
      throw new Error("包启用状态文件损坏。");
    }
    return new Set(value);
  }

  function checkErrors(): void {
    const errors = settings.drainErrors();
    if (errors.length) throw new Error(errors.map(({ error }) => error.message).join("\n"));
  }

  function run<T>(fn: () => Promise<T> | T): Promise<T> {
    const result = (operations.get(root) ?? Promise.resolve()).then(async () => {
      await settings.reload();
      checkErrors();
      return fn();
    });
    const pending = result.then(
      () => undefined,
      () => undefined,
    );
    operations.set(root, pending);
    void pending.then(() => {
      if (operations.get(root) === pending) operations.delete(root);
    });
    return result;
  }

  function configured(): PackageInfo[] {
    const stopped = disabled();
    return manager.listConfiguredPackages().map((entry) => {
      const source = displaySource(entry.source, entry.scope);
      return { ...entry, source, enabled: !stopped.has(disabledKey(source, entry.scope)) };
    });
  }

  async function flush(): Promise<void> {
    await settings.flush();
    checkErrors();
  }

  return {
    list(): Promise<PackageInfo[]> {
      return run(() => configured());
    },

    install(source: string, scope: Scope): Promise<void> {
      return run(async () => {
        const options = scopeOptions(scope);
        await manager.installAndPersist(normalizeSource(source), options);
        await flush();
      });
    },

    remove(source: string, scope: Scope): Promise<boolean> {
      return run(async () => {
        const options = scopeOptions(scope);
        const normalized = normalizeSource(source);
        if (!configured().some((entry) => entry.source === normalized && entry.scope === scope))
          return false;
        const removed = await manager.removeAndPersist(normalized, options);
        await flush();
        const stopped = disabled();
        if (stopped.delete(disabledKey(normalized, scope)))
          writeText(disabledPath, JSON.stringify([...stopped]));
        return removed;
      });
    },

    setEnabled(source: string, scope: Scope, enabled: boolean): Promise<void> {
      return run(() => {
        scopeOptions(scope);
        const normalized = normalizeSource(source);
        if (!configured().some((entry) => entry.source === normalized && entry.scope === scope)) {
          throw new Error("找不到指定作用域的包。");
        }
        const stopped = disabled();
        const key = disabledKey(normalized, scope);
        if (enabled) stopped.delete(key);
        else stopped.add(key);
        writeText(disabledPath, JSON.stringify([...stopped]));
      });
    },

    resolve(): Promise<ResolvedPaths> {
      return run(async () => {
        const stopped = disabled();
        // 禁止资源发现阶段隐式联网安装缺失的包。
        const resources = await manager.resolve(async () => "skip");
        const visible = (items: ResolvedPaths["extensions"]) =>
          items.filter(
            (item) =>
              item.metadata.origin !== "package" ||
              item.metadata.scope === "temporary" ||
              !stopped.has(
                disabledKey(
                  displaySource(item.metadata.source, item.metadata.scope),
                  item.metadata.scope,
                ),
              ),
          );
        return {
          extensions: visible(resources.extensions),
          skills: visible(resources.skills),
          prompts: visible(resources.prompts),
          themes: visible(resources.themes),
        };
      });
    },

    update(source?: string): Promise<void> {
      return run(async () => {
        await manager.update(source ? normalizeSource(source) : undefined);
        await flush();
      });
    },

    async dispose(): Promise<void> {
      await run(flush);
    },
  };
}
