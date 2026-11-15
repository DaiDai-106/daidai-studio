import { mkdir, realpath, stat } from "node:fs/promises";
import {
  type ApplicationEvent,
  type Arguments,
  type Method,
  type Results,
  validateRequest,
} from "../contracts/application.ts";
import type { DataRootIdentity } from "../contracts/process.ts";
import { openDirectoryRoot } from "../shared/node/file_access.ts";
import { createConversations } from "./agent/conversations.ts";
import { createExtensionUi } from "./agent/extension_ui.ts";
import { createShellApproval } from "./agent/shell_approval.ts";
import { createCodingFileService } from "./coding/file_service.ts";
import { createCodingGitService } from "./coding/git_service.ts";
import { openOrCreateDataRoot } from "./data_root.ts";
import { createCatalogService } from "./extensions/catalog_service.ts";
import { relocateCatalog } from "./extensions/catalog_storage.ts";
import { createPackageService, relocateModulePackages } from "./extensions/package_service.ts";
import { createSkillHandlers } from "./extensions/skill_handlers.ts";
import { openProjectStore } from "./projects/store.ts";
import { requestPolicy } from "./request_policy.ts";
import { createSettingsService } from "./settings/service.ts";
import type { Handlers } from "./types.ts";

/** 应用数据、Coding 服务与 Pi 会话的组合入口。 */
export async function openApplication(options: {
  dataRoot: string;
  expectedRoot?: DataRootIdentity;
  publish: (event: ApplicationEvent) => void;
}) {
  const { publish } = options;
  const configuredRoot = options.dataRoot;
  let dataRoot: string;
  if (process.platform === "linux") {
    const root = options.expectedRoot
      ? await openDirectoryRoot(configuredRoot, options.expectedRoot)
      : await openOrCreateDataRoot(configuredRoot);
    try {
      dataRoot = root.path;
    } finally {
      await root.handle.close();
    }
  } else {
    if (!options.expectedRoot) await mkdir(configuredRoot, { recursive: true, mode: 0o700 });
    dataRoot = await realpath(configuredRoot);
  }
  await relocateCatalog(dataRoot);
  relocateModulePackages(dataRoot);
  const store = openProjectStore(dataRoot);
  const coding = createCodingFileService(store);
  const codingGit = createCodingGitService(store, coding);
  let settings: Awaited<ReturnType<typeof createSettingsService>>;
  try {
    settings = await createSettingsService({ dataRoot, publish });
  } catch (error) {
    store.close();
    throw error;
  }
  const shellApproval = createShellApproval(publish);
  const extensionUi = createExtensionUi(publish);
  const conversations = createConversations({
    store,
    dataRoot,
    settings,
    publish,
    shellApproval,
    extensionUi,
    onPackageLoad: (moduleId, entries) => catalog.recordLoad(moduleId, entries),
  });
  const catalog = createCatalogService({
    dataRoot,
    publish,
    changed: (moduleId) => conversations.invalidate(undefined, moduleId),
  });
  const skills = createSkillHandlers({
    dataRoot,
    changed: conversations.invalidate,
  });
  const changed = () => publish({ type: "workspace" });

  async function projectInfo(id: string) {
    const project = store.getProject(id);
    if (!project) throw new Error("项目不存在。");
    let available = false;
    try {
      available = (await stat(project.path)).isDirectory();
    } catch {
      /* 目录被移动或删除。 */
    }
    return { ...project, available };
  }

  let closing = false;
  const handlers: Handlers = {
    "package.list": ({ moduleId = "coding", host = "pi" }) =>
      createPackageService({ dataRoot, moduleId, host }).inspect(),
    ...settings.handlers,
    ...skills,
    "catalog.sources": () => catalog.configuration(),
    "catalog.search": (input) => catalog.search(input),
    "catalog.detail": ({ sourceId, id, refresh }) => catalog.detail(sourceId, id, refresh),
    "catalog.configure": async ({ url }) => {
      await catalog.configure(url);
      return null;
    },
    "catalog.installed": ({ moduleId }) => catalog.installed(moduleId),
    "catalog.tasks": async () => catalog.taskList(),
    "catalog.install": (input) => catalog.install(input),
    "catalog.packageAction": async (input) => catalog.start(input),
    async "provider.save"(input) {
      await conversations.invalidate();
      return settings.handlers["provider.save"](input);
    },

    async "provider.remove"(input) {
      await conversations.invalidate();
      return settings.handlers["provider.remove"](input);
    },

    async "workspace.get"({ cursor }) {
      let position: { createdAt: number; id: string } | undefined;
      if (cursor) {
        try {
          const value: unknown = JSON.parse(cursor);
          if (
            !value ||
            typeof value !== "object" ||
            !Number.isSafeInteger((value as { createdAt?: number }).createdAt) ||
            typeof (value as { id?: string }).id !== "string"
          )
            throw new Error();
          position = value as { createdAt: number; id: string };
        } catch {
          throw new Error("会话分页游标无效。");
        }
      }
      // 启动仅返回注册信息；选择项目后由 project.refresh 检查目录。
      const projects = store.listProjects().map((project) => ({ ...project, available: null }));
      const page = store.listConversationPage(position);
      return {
        settings: await settings.info(),
        projects,
        conversations: page.items.map(conversations.metadata),
        nextCursor: page.next ? JSON.stringify(page.next) : null,
        dataRoot,
        busyConversationId: conversations.busyId(),
        shellApproval: shellApproval.pending(),
        extensionUiRequests: extensionUi.pending(),
      };
    },

    async "project.create"(input) {
      if (store.listProjects().length >= 100)
        throw new Error("最多可打开 100 个项目，请先移除其他项目。");
      const project = store.createProject(input);
      changed();
      return projectInfo(project.id);
    },

    async "project.refresh"({ id }) {
      return projectInfo(id);
    },

    async "project.remove"({ id }) {
      await conversations.invalidate(id);
      store.hideProject(id);
      changed();
      return null;
    },

    async "project.hidden"() {
      return store.listHiddenProjects().map((project) => ({ ...project, available: null }));
    },

    async "project.restore"({ id }) {
      if (store.listProjects().length >= 100)
        throw new Error("最多可打开 100 个项目，请先移除其他项目。");
      const project = store.restoreProject(id);
      changed();
      return { ...project, available: null };
    },

    async "coding.list"({ projectId, path, offset, snapshot }) {
      return coding.list(projectId, path, offset, snapshot);
    },

    async "coding.changes"({ projectId }) {
      return codingGit.changes(projectId);
    },

    async "coding.diff"({ projectId, path, kind }) {
      return codingGit.diff(projectId, path, kind);
    },

    async "coding.search"({ projectId, query }) {
      return coding.search(projectId, query);
    },

    async "coding.read"({ projectId, path }) {
      return coding.read(projectId, path);
    },

    async "conversation.create"({ projectId }) {
      return conversations.create(projectId);
    },

    async "conversation.fork"({ id }) {
      return conversations.fork(id);
    },

    async "conversation.update"(input) {
      return conversations.update(input);
    },

    async "conversation.watch"({ id }) {
      return conversations.watch(id);
    },

    "conversation.trace": async ({ id }) => conversations.trace(id),
    "conversation.traceDetail": async ({ id, entryId }) => conversations.traceDetail(id, entryId),

    async "conversation.send"(input) {
      return conversations.send(input);
    },

    "conversation.cancelQueued": async ({ id, messageId }) =>
      conversations.cancelQueued(id, messageId),
    "conversation.promoteQueued": async ({ id, messageId }) =>
      conversations.promoteQueued(id, messageId),
    "conversation.resumeQueue": async ({ id }) => conversations.resumeQueue(id),

    async "conversation.stop"({ id }) {
      return conversations.stop(id);
    },

    async "conversation.delete"({ id }) {
      return conversations.remove(id);
    },

    async "shell.respond"({ id, approved }) {
      shellApproval.respond(id, approved);
      return null;
    },

    async "extension.ui.respond"(input) {
      extensionUi.respond(input);
      return null;
    },
  };
  let mutations = Promise.resolve();
  let closePromise: Promise<void> | undefined;
  return {
    // 处理请求，方法名与参数作为输入，返回值作为输出。 区分串行并行处理。
    async request<K extends Method>(method: K, args: Arguments<K>): Promise<Results[K]> {
      if (closing) throw new Error("应用正在退出。");
      validateRequest(method, args);
      const policy = requestPolicy[method];
      if (policy === "interrupt" || policy === "read") return handlers[method](args);
      const result = mutations.then(() => handlers[method](args));
      mutations = result.then(
        () => {},
        () => {},
      );
      return result;
    },

    close() {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = (async () => {
        shellApproval.close();
        extensionUi.close();
        await mutations;
        const errors: unknown[] = [];
        for (const cleanup of [
          () => catalog.close(),
          () => conversations.close(),
          () => settings.close(),
        ]) {
          try {
            await cleanup();
          } catch (error) {
            errors.push(error);
          }
        }
        try {
          store.close();
        } catch (error) {
          errors.push(error);
        }
        if (errors.length) throw new AggregateError(errors, "后端资源未全部正常关闭。");
      })();
      return closePromise;
    },
  };
}
