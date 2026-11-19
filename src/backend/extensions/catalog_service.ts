import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import type { ApplicationEvent, Arguments } from "../../contracts/application.ts";
import type {
  CatalogInstalled,
  CatalogSourceId,
  CatalogTask,
  PackageLoad,
  PluginModule,
  PluginScope,
} from "../../contracts/catalog.ts";
import { createCatalogSources } from "./catalog_sources.ts";
import { createCatalogStorage } from "./catalog_storage.ts";
import { createPackageService, normalizePackageSource } from "./package_service.ts";

export function createCatalogService(options: {
  dataRoot: string;
  publish(event: ApplicationEvent): void;
  changed(moduleId?: PluginModule): Promise<void>;
}) {
  type PackageIdentity = Pick<CatalogInstalled, "source" | "host" | "scope" | "moduleId">;
  type Association = PackageIdentity & {
    sourceId: CatalogSourceId;
    entryId: string;
    catalogUrl?: string;
  };
  const tasks: CatalogTask[] = [];
  const loads = new Map<string, string>();
  // 查询与来源关联共享一个存储实例，路径和缓存的所有权留在存储模块。
  const storage = createCatalogStorage(options.dataRoot);
  const { read, write } = storage;
  const sources = createCatalogSources(storage);
  let pending = Promise.resolve();
  let closed = false;
  const loadKey = (moduleId: PluginModule, scope: PluginScope, source: string) =>
    `${moduleId}\0${scope}\0${source}`;

  // 来源相同的包可分属不同宿主和作用域；全局关联不带模块标识。
  function samePackage(a: PackageIdentity, b: PackageIdentity) {
    return (
      a.source === b.source &&
      a.host === b.host &&
      a.scope === b.scope &&
      a.moduleId === (b.scope === "module" ? b.moduleId : undefined)
    );
  }

  // 两类插件共用任务和进度协议；会话失效回调只由 Pi 安装空间调用。
  function manager(task: CatalogTask) {
    return createPackageService({
      dataRoot: options.dataRoot,
      host: task.host,
      ...(task.moduleId ? { moduleId: task.moduleId } : {}),
      progress(text) {
        task.message = text.slice(0, 2000);
        options.publish({ type: "catalog.task", task: { ...task } });
      },
      beforeAgentChange: async () => {
        const moduleId =
          task.action === "update" || task.scope === "global" ? undefined : task.moduleId;
        await options.changed(moduleId);
        // 模块变更只清除该模块的诊断；其他模块仍可展示最近加载结果。
        if (!moduleId) loads.clear();
        else for (const key of loads.keys()) if (key.startsWith(`${moduleId}\0`)) loads.delete(key);
      },
    });
  }

  function start(
    input: Arguments<"catalog.packageAction">,
    association?: Omit<Association, "source" | "host" | "scope" | "moduleId">,
    replacement?: { source: string; version: string; previousVersion: string },
  ): CatalogTask {
    const host = input.host ?? "pi";
    if (host === "desktop" && input.scope !== "global") throw new Error("桌面插件需要全局安装。");
    if (closed) throw new Error("应用正在退出。");
    if (input.scope === "module" && !input.moduleId) throw new Error("请选择插件模块。");
    const source = normalizePackageSource(input.source);
    if (tasks.some((t) => t.state === "running"))
      throw new Error("已有插件操作进行中，请等待完成。");
    const task: CatalogTask = {
      id: randomUUID(),
      host,
      source,
      scope: input.scope,
      action: input.action,
      state: "running",
      message: "正在准备…",
      startedAt: Date.now(),
      ...(input.moduleId ? { moduleId: input.moduleId } : {}),
    };
    tasks.unshift(task);
    tasks.splice(100);
    pending = pending.then(async () => {
      try {
        const service = manager(task);
        let updateMessage = "";
        if (input.action === "install") {
          await service.install(source, input.scope, replacement);
        } else if (input.action === "update") {
          const before = (await service.inspect()).find(
            (p) => p.source === source && p.scope === input.scope,
          );
          const local = isAbsolute(source);
          const pinned = /^npm:(?:@[^/]+\/)?[^@]+@v?\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(source);
          const offline = ["1", "true", "yes"].includes(
            (process.env.PI_OFFLINE ?? "").toLowerCase(),
          );
          if (!before || local || pinned || offline) {
            await service.checkChange();
            if (!before) throw new Error("找不到指定作用域的包。");
            updateMessage = local
              ? "本地目录不会自动下载更新，请直接更新目录内容。"
              : pinned
                ? "来源固定在指定版本，请通过市场详情选择其他版本。"
                : "当前处于离线模式，未执行更新。";
          } else {
            await service.update(source);
            const after = (await service.inspect()).find(
              (p) => p.source === source && p.scope === input.scope,
            );
            updateMessage =
              before?.version && after?.version && before.version !== after.version
                ? `版本已变化：${before.version} → ${after.version}。`
                : "未观察到版本变化；内容可能已更新，也可能没有更新。";
          }
        } else if (input.action === "remove") await service.remove(source, input.scope);
        else await service.setEnabled(source, input.scope, input.action === "enable");
        if (association || input.action === "remove") {
          const links = await read<Association[]>("origins.json", []);
          const next = links.filter(
            (a) =>
              !samePackage(a, task) &&
              !(replacement && samePackage(a, { ...task, source: replacement.source })),
          );
          if (association)
            next.push({
              ...association,
              host,
              source,
              scope: input.scope,
              ...(input.scope === "module" ? { moduleId: input.moduleId } : {}),
            });
          await write("origins.json", next);
        }
        task.state = "completed";
        task.message = replacement
          ? replacement.previousVersion === replacement.version
            ? `版本未变化：${replacement.version}。`
            : `已更新：${replacement.previousVersion || "未知版本"} → ${replacement.version}。`
          : input.action === "install"
            ? "已安装并启用。"
            : updateMessage || "操作已完成。";
      } catch (error) {
        task.state = "failed";
        task.message = (error instanceof Error ? error.message : "操作失败。").slice(0, 2000);
      } finally {
        options.publish({ type: "catalog.task", task: { ...task } });
        options.publish({ type: "workspace" });
      }
    });
    return { ...task };
  }

  async function installed(moduleId: PluginModule = "coding"): Promise<CatalogInstalled[]> {
    const [config, packages, links] = await Promise.all([
      sources.configuration(),
      Promise.all(
        (["pi", "desktop"] as const).map((host) =>
          createPackageService({ dataRoot: options.dataRoot, host, moduleId }).inspect(),
        ),
      ).then((groups) => groups.flat()),
      read<Association[]>("origins.json", []),
    ]);
    return packages.map((p) => {
      const { dai: _dai, installedPath: _path, manifestError, ...info } = p;
      const link = links.find((a) => samePackage(a, p));
      const loadError =
        manifestError ||
        (p.host === "pi" ? loads.get(loadKey(moduleId, p.scope, p.source)) : undefined);
      return {
        ...info,
        sourceId: link?.sourceId ?? "manual",
        entryId:
          link?.sourceId === "company" && link.catalogUrl !== config.companyUrl
            ? ""
            : (link?.entryId ?? ""),
        loadState: !p.enabled
          ? "disabled"
          : loadError
            ? "failed"
            : loadError === undefined
              ? "waiting"
              : "loaded",
        error: loadError ?? "",
      };
    });
  }

  return {
    search: sources.search,
    detail: sources.detail,
    installed,
    configuration: sources.configuration,
    recordLoad(moduleId: PluginModule, entries: PackageLoad[]) {
      const grouped = new Map<string, string[]>();
      for (const entry of entries) {
        const key = loadKey(moduleId, entry.scope, entry.source);
        const errors = grouped.get(key) ?? [];
        if (entry.error) errors.push(entry.error);
        grouped.set(key, errors);
      }
      for (const [key, errors] of grouped)
        loads.set(key, [...new Set(errors)].join("；").slice(0, 4000));
    },
    configure: sources.configure,
    taskList: () => tasks.map((t) => ({ ...t })),
    start,
    async install(input: Arguments<"catalog.install">) {
      const { entry, catalogUrl } = await sources.resolveInstall(input);
      const old =
        input.replaceSource &&
        (await installed(input.moduleId)).find(
          (p) =>
            p.source === normalizePackageSource(input.replaceSource ?? "") &&
            p.scope === input.scope &&
            p.sourceId === input.sourceId &&
            p.entryId === input.id &&
            p.host === entry.host,
        );
      if (input.replaceSource && !old) throw new Error("原插件或市场来源已变化，请刷新后重试。");
      return start(
        {
          action: "install",
          host: entry.host,
          source: entry.installSource,
          scope: input.scope,
          ...(input.moduleId ? { moduleId: input.moduleId } : {}),
        },
        {
          sourceId: input.sourceId,
          entryId: input.id,
          ...(input.sourceId === "company" ? { catalogUrl } : {}),
        },
        old
          ? { source: old.source, version: input.version, previousVersion: old.version }
          : undefined,
      );
    },
    async close() {
      closed = true;
      await pending;
    },
  };
}
