import { mkdir, realpath, stat } from "node:fs/promises";
import {
  type ApplicationEvent,
  type Arguments,
  type Method,
  type Results,
  validateRequest,
} from "../contracts/application.ts";
import type { DataRootIdentity, ResourceLocation } from "../contracts/process.ts";
import { openDirectoryRoot } from "../shared/node/file_access.ts";
import { createConversations } from "./agent/conversations.ts";
import { createExtensionUi } from "./agent/extension_ui.ts";
import { createShellApproval } from "./agent/shell_approval.ts";
import { createCodingFileService } from "./coding/file_service.ts";
import { createCodingGitService } from "./coding/git_service.ts";
import { createPackageHandlers } from "./extensions/package_handlers.ts";
import { createSkillHandlers } from "./extensions/skill_handlers.ts";
import { openProjectStore } from "./projects/store.ts";
import { requestPolicy } from "./request_policy.ts";
import { createScenePythonService } from "./scene/python_service.ts";
import { openOrCreateSceneDataRoot } from "./scene/scene_paths.ts";
import { createSceneService } from "./scene/scene_service.ts";
import { createSettingsService } from "./settings/service.ts";
import type { Handlers } from "./types.ts";

/** 独立应用数据、项目 Runtime 与 Pi 会话的组合入口。 */
export async function openApplication(options: {
  dataRoot: string;
  expectedRoot?: DataRootIdentity;
  publish: (event: ApplicationEvent) => void;
  workerPath?: string;
  sceneSkillPath?: string;
  pythonExecutable?: string;
}) {
  const { publish } = options;
  const configuredRoot = options.dataRoot;
  let dataRoot: string;
  let rootIdentity: DataRootIdentity | undefined;
  if (process.platform === "linux") {
    const root = options.expectedRoot
      ? await openDirectoryRoot(configuredRoot, options.expectedRoot)
      : await openOrCreateSceneDataRoot(configuredRoot);
    try {
      const info = await root.handle.stat({ bigint: true });
      rootIdentity = { dev: info.dev.toString(), ino: info.ino.toString() };
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
  const codingGit = createCodingGitService(store, coding);
  let settings: Awaited<ReturnType<typeof createSettingsService>>;
  try {
    settings = await createSettingsService({ dataRoot, publish });
  } catch (error) {
    store.close();
    throw error;
  }
  const scenePython = createScenePythonService({
    dataRoot,
    publish,
    ...(options.pythonExecutable ? { pythonExecutable: options.pythonExecutable } : {}),
    ...(options.workerPath ? { workerPath: options.workerPath } : {}),
  });
  const scenes = createSceneService({
    store,
    changed: (view) =>
      publish({ type: "scene.changed", projectId: view.projectId, revision: view.revision }),
    dataRoot: configuredRoot,
    ...(rootIdentity ? { expectedRoot: rootIdentity } : {}),
    pythonExecutable: scenePython.executable,
    ...(options.workerPath ? { workerPath: options.workerPath } : {}),
  });
  const shellApproval = createShellApproval(publish);
  const extensionUi = createExtensionUi(publish);
  const conversations = createConversations({
    store,
    dataRoot,
    settings,
    scenes,
    publish,
    shellApproval,
    extensionUi,
    ...(options.sceneSkillPath ? { sceneSkillPath: options.sceneSkillPath } : {}),
  });
  const packages = createPackageHandlers({ dataRoot, store, changed: conversations.invalidate });
  const skills = createSkillHandlers({
    dataRoot,
    store,
    changed: conversations.invalidate,
    ...(options.sceneSkillPath ? { sceneSkillPath: options.sceneSkillPath } : {}),
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
    ...settings.handlers,
    ...packages,
    ...skills,
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
      await scenes.release(id);
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

    async "scene.get"({ projectId }) {
      return scenes.get(projectId);
    },

    async "scene.pythonStatus"() {
      return scenePython.check();
    },

    async "scene.installPython"() {
      return scenePython.install();
    },

    async "scene.cancelImport"({ projectId }) {
      scenes.cancelImport(projectId);
      return null;
    },

    async "scene.import"(input) {
      if (conversations.isProjectBusy(input.projectId))
        throw new Error("此项目有会话正在运行，请先停止或等待后再导入场景。");
      const result = await scenes.import(input);
      return result;
    },

    async "scene.relocateSource"(input) {
      const result = await scenes.relocateSource(input);
      return result;
    },

    async "scene.setTransform"(input) {
      const result = scenes.setTransform(input);
      return result;
    },

    async "scene.deleteObject"(input) {
      const result = scenes.deleteObject(input);
      return result;
    },

    async "scene.confirmJoint"(input) {
      const result = scenes.confirmJoint(input);
      return result;
    },

    async "scene.discardJointDraft"(input) {
      const result = scenes.discardJointDraft(input);
      return result;
    },

    async "scene.removeConfirmedJoint"(input) {
      const result = scenes.removeConfirmedJoint(input);
      return result;
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

    async "conversation.send"(input) {
      const conversation = store.getConversation(input.id);
      if (conversation && scenes.isImporting(conversation.projectId))
        throw new Error("此项目正在导入场景，请等待或取消导入后再发送消息。");
      return conversations.send(input);
    },

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
  const imports = new Set<Promise<unknown>>();
  return {
    // 处理请求，方法名与参数作为输入，返回值作为输出。 区分串行并行处理。
    async request<K extends Method>(method: K, args: Arguments<K>): Promise<Results[K]> {
      if (closing) throw new Error("应用正在退出。");
      validateRequest(method, args);
      const policy = requestPolicy[method];
      if (policy === "interrupt" || policy === "read") return handlers[method](args);
      if (policy === "long-running") {
        const result = handlers[method](args);
        imports.add(result);
        void result.then(
          () => imports.delete(result),
          () => imports.delete(result),
        );
        return result;
      }
      const result = mutations.then(() => handlers[method](args));
      mutations = result.then(
        () => {},
        () => {},
      );
      return result;
    },

    async resolveResource(group: string, resourceId: string): Promise<ResourceLocation> {
      const result = scenes.resolveResource(group, resourceId);
      if (!result) throw new Error("场景资源不存在。");
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
          () => scenePython.close(),
          () => conversations.close(),
          () => scenes.dispose(),
          async () => {
            await Promise.allSettled([...imports]);
          },
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
