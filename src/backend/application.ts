import { mkdir, realpath, stat } from "node:fs/promises";
import {
  type ApplicationEvent,
  type Arguments,
  type Method,
  type Results,
  validateRequest,
} from "../contracts/application.ts";
import type { DataRootIdentity } from "../contracts/process.ts";
import { requestPolicy } from "../contracts/request_policy.ts";
import { openDirectoryRoot } from "../shared/node/file_access.ts";
import { createConversations } from "./agent/conversations.ts";
import { createExtensionUi } from "./agent/extension_ui.ts";
import { createShellApproval } from "./agent/shell_approval.ts";
import { usageDashboard } from "./agent/usage_dashboard.ts";
import { openOrCreateDataRoot } from "./data_root.ts";
import { createCatalogService } from "./extensions/catalog_service.ts";
import { createPackageService } from "./extensions/package_service.ts";
import { createSkillHandlers } from "./extensions/skill_handlers.ts";
import { createCodingFileService } from "./module/coding/file_service.ts";
import { createCodingGitService } from "./module/coding/git_service.ts";
import { createPlanningService } from "./module/planning/service.ts";
import { createSceneService } from "./module/scene/service.ts";
import { openProjectStore } from "./projects/store.ts";
import { createSettingsService } from "./settings/service.ts";
import type { Handlers } from "./types.ts";

const queueTimeout = () => new Error("后端请求排队超时，未执行。");

/** 应用数据、Coding 服务与 Pi 会话的组合入口。 */
export async function openApplication(options: {
  dataRoot: string;
  expectedRoot?: DataRootIdentity;
  stepWorkerDirectory?: string;
  planningWorkerDirectory?: string;
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
  const store = openProjectStore(dataRoot);
  const coding = createCodingFileService(store);
  const codingGit = createCodingGitService(coding);
  const planning = createPlanningService(options.planningWorkerDirectory, (projectId, snapshot) =>
    publish({ type: "planning.scene", projectId, snapshot }),
  );
  const scene = createSceneService({
    dataRoot,
    store,
    publish,
    ...(options.stepWorkerDirectory ? { stepWorkerDirectory: options.stepWorkerDirectory } : {}),
  });
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
    codingFiles: coding,
    scene,
    planning,
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
  function requirePlanningProject(id: string) {
    if (store.getProject(id)?.mode !== "planning") throw new Error("规划项目不存在。");
  }
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
      const settingsInfo = await settings.info();
      // 启动仅返回注册信息；选择项目后由 project.refresh 检查目录。
      const projects = store.listProjects().map((project) => ({ ...project, available: null }));
      const page = store.listConversationPage(position);
      return {
        settings: settingsInfo,
        projects,
        conversations: page.items.map(conversations.metadata),
        nextCursor: page.next ? JSON.stringify(page.next) : null,
        dataRoot,
        busyConversationIds: conversations.busyIds(),
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

    "usage.dashboard": async () =>
      usageDashboard(store, dataRoot, (provider, model) =>
        settings.modelRuntime.getModel(provider, model),
      ),

    async "project.remove"({ id }) {
      await conversations.invalidate(id);
      store.hideProject(id);
      scene.forget(id);
      planning.forget(id);
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

    "conversation.history": async ({ id, turnId, before }) =>
      conversations.readHistory(id, turnId, before),
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

    "scene.get": ({ projectId }) => scene.get(projectId),
    "scene.apply": ({ projectId, expectedRevision, operation }) =>
      scene.apply(projectId, expectedRevision, operation),
    "scene.import": ({ projectId, expectedRevision, path }) =>
      scene.importUrdf(projectId, expectedRevision, path),
    "scene.importStep": ({ projectId, expectedRevision, path, sourceOnly }) =>
      scene.importStep(projectId, expectedRevision, path, { sourceOnly }),
    "scene.cancelStep": async ({ projectId }) => scene.cancelStep(projectId),
    "scene.export": ({ projectId, directory, expectedRevision }) =>
      scene.exportUrdf(projectId, directory, expectedRevision),
    "scene.asset": async ({ projectId, asset }) =>
      (await scene.readAsset(projectId, asset)).toString("base64"),

    async "planning.load"({ projectId, kind, path }) {
      requirePlanningProject(projectId);
      await planning.load(projectId, kind, path);
      return null;
    },
    async "planning.get"({ projectId }) {
      requirePlanningProject(projectId);
      return planning.get(projectId);
    },
    async "planning.asset"({ projectId, revision, asset }) {
      requirePlanningProject(projectId);
      return planning.readAsset(projectId, revision, asset);
    },
    async "planning.source.check"({ requestId, kind }) {
      extensionUi.checkPlanningSource(requestId, kind);
      return null;
    },
    async "planning.source.respond"({ requestId, kind, path }) {
      extensionUi.respondPlanningSource(requestId, kind, path);
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
    async request<K extends Method>(
      method: K,
      args: Arguments<K>,
      deadline?: number,
    ): Promise<Results[K]> {
      if (closing) throw new Error("应用正在退出。");
      validateRequest(method, args);
      if (deadline !== undefined && Date.now() >= deadline) throw queueTimeout();
      const policy = requestPolicy[method];
      if (policy === "interrupt" || policy === "read") return handlers[method](args);
      let expired = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const dispatched = mutations.then(async () => {
        clearTimeout(timer);
        if (expired || (deadline !== undefined && Date.now() >= deadline)) throw queueTimeout();
        const response = handlers[method](args);
        // 发送先在队列中占用会话，再独立等待 Pi 接受输入，避免插件交互阻塞其他会话。
        return { response: policy === "start" ? response : await response };
      });
      mutations = dispatched.then(
        () => {},
        () => {},
      );
      const result = dispatched.then(({ response }) => response);
      if (deadline === undefined) return result;
      // 等待期间可以放弃；一旦开始执行，调用方等待真实结果。
      return new Promise((resolve, reject) => {
        timer = setTimeout(
          () => {
            expired = true;
            reject(queueTimeout());
          },
          Math.max(0, deadline - Date.now()),
        );
        void result.then(resolve, reject);
      });
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
          () => scene.close(),
          () => planning.close(),
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
