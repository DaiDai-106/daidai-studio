import { randomUUID } from "node:crypto";
import {
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  DefaultPackageManager,
  type ResolvedPaths,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  type CatalogResource,
  type InstalledPackage,
  type PluginHost,
  type PluginModule,
  pluginModules,
  type PluginScope as Scope,
} from "../../contracts/catalog.ts";
import { packageManifest } from "./package_manifest.ts";

type Options = {
  dataRoot: string;
  host?: PluginHost;
  moduleId?: PluginModule;
  progress?: (message: string) => void;
  beforeAgentChange?: () => Promise<void>;
};
type PackageLocation = Pick<InstalledPackage, "source" | "scope" | "installedPath" | "enabled">;

// 同宿主的各模块共享全局设置和 npm 目录，读写必须跨服务实例排队。
// 两个宿主使用不同队列，安装桌面主题不会阻塞 Agent 的资源读取。
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

/** 在任务登记前统一来源，避免索引使用别名，或把 URL 密码写入任务与日志。 */
export function normalizePackageSource(source: string): string {
  const trimmed = source.trim();
  const value = /^~[\\/]/.test(trimmed) ? resolve(homedir(), trimmed.slice(2)) : trimmed;
  if (!value) throw new Error("包来源不能为空。");
  if (!isAbsolute(value) && !/^(npm:|git:|https?:\/\/|ssh:\/\/)/i.test(value))
    throw new Error("请使用本地插件的绝对路径或 ~/ 路径。");
  if (/^(git:)?(https?|ssh):\/\//i.test(value)) {
    let url: URL;
    try {
      url = new URL(value.replace(/^git:/i, ""));
    } catch {
      throw new Error("Git 地址格式无效。");
    }
    if (url.password || (url.username && url.protocol !== "ssh:"))
      throw new Error("请通过系统 Git 凭据配置认证，不要把凭据写入包地址。");
  }
  return value;
}

function absolutePackageSource(source: string, base: string): string {
  return source === "." || source.startsWith("./") || source.startsWith("../")
    ? resolve(base, source)
    : source;
}

/** 启动时迁移模块安装内容；在创建包服务和会话之前完成，避免运行中改变 SDK 路径。 */
export function relocateModulePackages(dataRoot: string): void {
  for (const moduleId of Object.keys(pluginModules)) {
    const root = join(dataRoot, "agent", "packages", "modules", moduleId);
    const workspace = join(root, "workspace");
    if (!existsSync(workspace)) continue;
    const previous = join(workspace, ".pi");
    const target = join(root, ".pi");
    if (existsSync(previous)) {
      if (existsSync(target))
        throw new Error(`模块 ${moduleId} 的新旧插件目录同时存在，请先检查，迁移不会覆盖内容。`);
      const path = join(root, "settings.json");
      const text = readText(path);
      if (text !== undefined) {
        const config: unknown = JSON.parse(text);
        if (!config || typeof config !== "object" || Array.isArray(config))
          throw new Error(`模块 ${moduleId} 的插件配置损坏。`);
        if ("packages" in config) {
          if (!Array.isArray(config.packages)) throw new Error("插件来源需要数组。");
          const packages = config.packages.map((entry: unknown) => {
            const item = typeof entry === "string" ? { source: entry } : entry;
            if (
              !item ||
              typeof item !== "object" ||
              !("source" in item) ||
              typeof item.source !== "string"
            )
              throw new Error("插件来源格式无效。");
            const source = absolutePackageSource(item.source, previous);
            return typeof entry === "string" ? source : { ...item, source };
          });
          // 先把相对来源固定到原目录；即使移动失败，重试也不会重复改变来源。
          if (JSON.stringify(packages) !== JSON.stringify(config.packages))
            writeText(path, JSON.stringify({ ...config, packages }, null, 2));
        }
      }
      renameSync(previous, target);
    }
    try {
      rmdirSync(workspace);
    } catch (error) {
      // 只删除空的旧容器，保留其中不属于安装器的其他文件。
      if (!["ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? ""))
        throw error;
    }
  }
}

/** 共用 Pi 的安装能力；配置目录决定宿主，包清单不能在更新时改变归属。 */
export function createPackageService({
  dataRoot,
  host = "pi",
  moduleId = "coding",
  progress,
  beforeAgentChange,
}: Options) {
  if (!isAbsolute(dataRoot)) throw new Error("数据目录必须是绝对路径。");
  if (host !== "pi" && host !== "desktop") throw new Error("无效的插件宿主。");
  if (!Object.hasOwn(pluginModules, moduleId)) throw new Error("无效的插件模块。");
  const packageRoot = join(resolve(dataRoot), host === "pi" ? "agent" : "desktop", "packages");
  const moduleRoot = join(packageRoot, "modules", moduleId);
  const globalSettings = join(packageRoot, "settings.json");
  const moduleSettings = host === "pi" ? join(moduleRoot, "settings.json") : undefined;
  const disabledPath = join(packageRoot, "disabled.json");
  const settings = SettingsManager.fromStorage(
    {
      withLock(scope, update) {
        const path = scope === "global" ? globalSettings : moduleSettings;
        // Desktop 仅全局生效，SDK 的 project 视图保持空，不读取遗留模块配置。
        if (!path) {
          update(undefined);
          return;
        }
        const current = readText(path);
        const next = update(current);
        if (next !== undefined && next !== current) writeText(path, next);
      },
    },
    { projectTrusted: true },
  );
  // SDK 的 project 作用域对应 Dai 模块，cwd 不指向用户项目。
  function packageManager(settingsManager: SettingsManager, root = packageRoot) {
    const manager = new DefaultPackageManager({
      cwd: host === "pi" ? join(root, "modules", moduleId) : root,
      agentDir: root,
      settingsManager,
    });
    if (progress)
      manager.setProgressCallback((event) =>
        progress(event.message ?? `${event.action}: ${event.source}`),
      );
    return manager;
  }
  const manager = packageManager(settings);

  function scopeOptions(scope: Scope) {
    if (scope !== "global" && scope !== "module") throw new Error("无效的包作用域。");
    if (host === "desktop" && scope !== "global") throw new Error("桌面插件需要全局安装。");
    return { local: scope === "module" };
  }

  function disabledKey(source: string, scope: Scope): string {
    return JSON.stringify(scope === "global" ? [scope, source] : [scope, moduleId, source]);
  }

  function displaySource(source: string, scope: Scope): string {
    // Pi 持久化本地相对路径，界面和索引统一使用绝对路径。
    return absolutePackageSource(
      source,
      scope === "global" ? packageRoot : join(moduleRoot, ".pi"),
    );
  }

  function disabled(): Set<string> {
    const value: unknown = JSON.parse(readText(disabledPath) ?? "[]");
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
      throw new Error("包启用状态文件损坏。");
    return new Set(value);
  }

  function saveEnabled(source: string, scope: Scope, enabled: boolean) {
    const stopped = disabled();
    const key = disabledKey(source, scope);
    if (stopped.has(key) === !enabled) return;
    if (enabled) stopped.delete(key);
    else stopped.add(key);
    writeText(disabledPath, JSON.stringify([...stopped]));
  }

  function checkErrors(): void {
    const errors = settings.drainErrors();
    if (errors.length) throw new Error(errors.map(({ error }) => error.message).join("\n"));
  }

  async function flush() {
    await settings.flush();
    checkErrors();
  }

  function run<T>(fn: () => Promise<T> | T): Promise<T> {
    const result = (operations.get(packageRoot) ?? Promise.resolve()).then(async () => {
      await settings.reload();
      checkErrors();
      return fn();
    });
    const pending = result.then(
      () => undefined,
      () => undefined,
    );
    operations.set(packageRoot, pending);
    void pending.then(() => {
      if (operations.get(packageRoot) === pending) operations.delete(packageRoot);
    });
    return result;
  }

  function configured(stopped = disabled()) {
    return manager.listConfiguredPackages().map((entry) => {
      const scope: Scope = entry.scope === "user" ? "global" : "module";
      const source = displaySource(entry.source, scope);
      return {
        source,
        scope,
        installedPath: entry.installedPath ?? "",
        enabled: !stopped.has(disabledKey(source, scope)),
      };
    });
  }

  // 清单边界只解析一次；列表展示和安装／加载校验复用同一结果。
  async function readManifest(installedPath: string) {
    let manifest: Record<string, unknown> = {};
    let manifestError = "";
    let resources: CatalogResource[] = [];
    try {
      if (!installedPath) throw new Error("插件安装内容暂不可用。");
      try {
        const value: unknown = JSON.parse(
          await readFile(join(installedPath, "package.json"), "utf8"),
        );
        if (!value || typeof value !== "object" || Array.isArray(value))
          throw new Error("包清单需要 JSON 对象。");
        manifest = value as Record<string, unknown>;
      } catch (error) {
        // Pi 支持无 package.json 的本地资源目录；Desktop 始终需要显式声明。
        if (host !== "pi" || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const parsed = packageManifest(manifest);
      resources = parsed.resources;
      if (parsed.host !== host)
        throw new Error("插件清单与安装宿主不匹配，请选择正确的插件类型重新安装。");
    } catch (error) {
      manifestError = (error instanceof Error ? error.message : "包清单读取失败。").slice(0, 2000);
    }
    return { manifest, resources, manifestError };
  }

  async function describe(item: PackageLocation): Promise<InstalledPackage> {
    const { manifest, resources, manifestError } = await readManifest(item.installedPath);
    const text = (value: unknown, limit = 4096) =>
      typeof value === "string" ? value.slice(0, limit) : "";
    return {
      ...item,
      host,
      ...(item.scope === "module" ? { moduleId } : {}),
      name: text(manifest.name, 500) || item.source,
      description: text(manifest.description),
      version: text(manifest.version, 100),
      resources,
      dai: manifest.dai ?? null,
      manifestError,
    };
  }

  async function validateSource(source: string, scope: Scope, installer = manager) {
    const path = installer.getInstalledPath(source, scope === "global" ? "user" : "project");
    const { manifest, manifestError } = await readManifest(path ?? "");
    if (manifestError) throw new Error(manifestError);
    return manifest;
  }

  const beforeChange = () => (host === "pi" ? beforeAgentChange?.() : undefined);

  async function stageInstall(
    source: string,
    scope: Scope,
    prepare: (root: string) => Promise<void>,
    commit?: () => Promise<void>,
  ) {
    await beforeChange();
    if (isAbsolute(source)) {
      await prepare(packageRoot);
      await commit?.();
      return;
    }

    // npm 更新会修改共享的依赖树和锁文件，一起交给 SDK 在临时目录处理。
    const kind = source.startsWith("npm:") ? "npm" : "git";
    const parts = scope === "global" ? [kind] : ["modules", moduleId, ".pi", kind];
    const live = join(packageRoot, ...parts);
    await mkdir(packageRoot, { recursive: true, mode: 0o700 });
    const temporary = await mkdtemp(join(packageRoot, ".dai-package-"));
    const staged = join(temporary, ...parts);
    const backup = join(temporary, "previous");
    let movedPrevious = false;
    let installed = false;
    let keepBackup = false;
    try {
      await mkdir(dirname(staged), { recursive: true });
      if (host === "pi") await mkdir(join(temporary, "modules", moduleId), { recursive: true });
      if (existsSync(live))
        await cp(live, staged, {
          recursive: true,
          verbatimSymlinks: true,
          mode: constants.COPYFILE_FICLONE,
        });
      await prepare(temporary);
      if (existsSync(staged)) {
        await mkdir(dirname(live), { recursive: true });
        if (existsSync(live)) {
          renameSync(live, backup);
          movedPrevious = true;
        }
        renameSync(staged, live);
        installed = true;
      }
      await commit?.();
    } catch (error) {
      try {
        if (installed) renameSync(live, staged);
        if (movedPrevious) renameSync(backup, live);
      } catch (restore) {
        keepBackup = true;
        throw new AggregateError([error, restore], `插件恢复失败，原文件保留在 ${temporary}。`);
      }
      throw error;
    } finally {
      if (!keepBackup)
        await rm(temporary, { recursive: true, force: true, maxRetries: 3 }).catch((error) =>
          console.error("Failed to clean staged package files.", error),
        );
    }
  }

  return {
    inspect: () => run(() => Promise.all(configured().map(describe))),
    checkChange: () => run(beforeChange),

    install(
      source: string,
      scope: Scope,
      replacement?: { source: string; version: string },
    ): Promise<void> {
      return run(async () => {
        const options = scopeOptions(scope);
        const normalized = normalizePackageSource(source);
        const previous =
          replacement &&
          configured().find((item) => item.source === replacement.source && item.scope === scope);
        if (replacement && !previous) throw new Error("原插件已变化，请刷新后重试。");
        const targetPath = manager.getInstalledPath(
          normalized,
          scope === "global" ? "user" : "project",
        );
        if (
          replacement &&
          (!previous?.installedPath || !targetPath || previous.installedPath !== targetPath)
        )
          throw new Error("市场中的安装来源已变化，请在详情中检查后手动安装。");
        await stageInstall(
          normalized,
          scope,
          async (root) => {
            const installer = packageManager(settings, root);
            await installer.install(normalized, options);
            const manifest = await validateSource(normalized, scope, installer);
            if (replacement && manifest.version !== replacement.version)
              throw new Error("安装后的版本与所选版本不一致，请检查已安装列表。");
          },
          async () => {
            const path = scope === "global" ? globalSettings : moduleSettings;
            const files = [path, disabledPath].flatMap((file) =>
              file ? [{ file, original: readText(file) }] : [],
            );
            try {
              manager.addSourceToSettings(normalized, options);
              await flush();
              if (replacement && replacement.source !== normalized)
                saveEnabled(replacement.source, scope, true);
              saveEnabled(normalized, scope, previous?.enabled ?? true);
            } catch (error) {
              for (const { file, original } of files) {
                if (readText(file) === original) continue;
                if (original === undefined) await rm(file, { force: true });
                else writeText(file, original);
              }
              throw error;
            }
          },
        );
      });
    },

    remove(source: string, scope: Scope): Promise<boolean> {
      return run(async () => {
        const options = scopeOptions(scope);
        const normalized = normalizePackageSource(source);
        if (!configured().some((item) => item.source === normalized && item.scope === scope))
          return false;
        await beforeChange();
        const removed = await manager.removeAndPersist(normalized, options);
        await flush();
        saveEnabled(normalized, scope, true);
        return removed;
      });
    },

    setEnabled(source: string, scope: Scope, enabled: boolean): Promise<void> {
      return run(async () => {
        scopeOptions(scope);
        const normalized = normalizePackageSource(source);
        if (!configured().some((item) => item.source === normalized && item.scope === scope))
          throw new Error("找不到指定作用域的包。");
        if (enabled) await validateSource(normalized, scope);
        await beforeChange();
        saveEnabled(normalized, scope, enabled);
      });
    },

    resolve(): Promise<ResolvedPaths> {
      if (host !== "pi") throw new Error("桌面插件不使用 Pi 资源加载器。");
      return run(async () => {
        const stopped = disabled();
        const packages = configured(stopped);
        // 停用或缺失的包不参与加载校验；加载阶段不构造界面展示字段。
        await Promise.all(
          packages
            .filter((item) => item.enabled && item.installedPath)
            .map((item) => validateSource(item.source, item.scope)),
        );
        // 这里只读取 Pi 安装空间，并禁止资源发现阶段隐式联网补装。
        const resources = await manager.resolve(async () => "skip");
        const visible = (items: ResolvedPaths["extensions"]) =>
          items.flatMap((item) => {
            const { origin, scope } = item.metadata;
            if (origin !== "package" || scope === "temporary") return [item];
            const packageScope = scope === "user" ? "global" : "module";
            const source = displaySource(item.metadata.source, packageScope);
            return stopped.has(disabledKey(source, packageScope))
              ? []
              : [{ ...item, metadata: { ...item.metadata, source } }];
          });
        return {
          extensions: visible(resources.extensions),
          skills: visible(resources.skills),
          prompts: visible(resources.prompts),
          themes: visible(resources.themes),
        };
      });
    },

    update(source: string, scope: Scope): Promise<void> {
      return run(async () => {
        scopeOptions(scope);
        const normalized = normalizePackageSource(source);
        if (!configured().some((item) => item.source === normalized && item.scope === scope))
          throw new Error("找不到指定作用域的包。");
        // SDK 按来源跨作用域匹配。仅把选中的安装传入其内存配置。
        const scoped = SettingsManager.inMemory(
          { ...settings.getGlobalSettings(), packages: scope === "global" ? [normalized] : [] },
          { projectTrusted: true },
        );
        if (scope === "module") scoped.setProjectPackages([normalized]);
        await stageInstall(normalized, scope, async (root) => {
          const installer = packageManager(scoped, root);
          await installer.update(normalized);
          await validateSource(normalized, scope, installer);
        });
      });
    },
  };
}
