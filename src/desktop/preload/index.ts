import { contextBridge, ipcRenderer } from "electron";
import type { ApplicationEvent, Arguments, Method, Results } from "../../contracts/application.ts";
import {
  APP_INFO_CHANNEL,
  type DesktopBridge,
  EVENT_CHANNEL,
  PROJECT_CREATE_CHANNEL,
  PROJECT_DIRECTORY_CHANNEL,
  QUIT_FLUSH_CHANNEL,
  QUIT_FLUSH_READY_CHANNEL,
  QUIT_FLUSH_REGISTER_CHANNEL,
  REQUEST_CHANNEL,
  SKILL_IMPORT_CHANNEL,
  THEME_CHANNEL,
  THEMES_CHANNEL,
} from "../../contracts/desktop.ts";
import {
  PREVIEW_CONTROL_CHANNEL,
  PREVIEW_EVENT_CHANNEL,
  PREVIEW_OPEN_CHANNEL,
  PREVIEW_OPEN_FILE_CHANNEL,
  PREVIEW_SHOW_CHANNEL,
  type PreviewEvent,
} from "../../contracts/web_preview.ts";

// 前端只能使用下方显式开放的方法，实际请求由主进程转发给后端。
function call<K extends Method>(method: K, args: Arguments<K>): Promise<Results[K]> {
  return ipcRenderer.invoke(REQUEST_CHANNEL, method, args);
}

const desktop: DesktopBridge = {
  getAppInfo: () => ipcRenderer.invoke(APP_INFO_CHANNEL),
  getThemes: (selectedId) => ipcRenderer.invoke(THEMES_CHANNEL, selectedId),
  setTheme: (theme, palette) => ipcRenderer.invoke(THEME_CHANNEL, theme, palette),
  onBeforeQuit(flush) {
    // 退出前等待界面保存草稿，并将结果交回主进程决定是否继续退出。
    const receive = (_event: Electron.IpcRendererEvent, requestId: string) => {
      void flush().then(
        () => ipcRenderer.send(QUIT_FLUSH_READY_CHANNEL, requestId, true),
        () => ipcRenderer.send(QUIT_FLUSH_READY_CHANNEL, requestId, false),
      );
    };

    ipcRenderer.on(QUIT_FLUSH_CHANNEL, receive);
    ipcRenderer.send(QUIT_FLUSH_REGISTER_CHANNEL);
    return () => ipcRenderer.removeListener(QUIT_FLUSH_CHANNEL, receive);
  },
  preview: {
    open: (projectId, tabId, url) =>
      ipcRenderer.invoke(PREVIEW_OPEN_CHANNEL, { projectId, tabId, url }),
    openFile: (projectId, tabId, path) =>
      ipcRenderer.invoke(PREVIEW_OPEN_FILE_CHANNEL, { projectId, tabId, path }),
    show: (projectId, tabId, bounds) =>
      ipcRenderer.invoke(PREVIEW_SHOW_CHANNEL, { projectId, tabId, bounds }),
    control: (projectId, tabId, action) =>
      ipcRenderer.invoke(PREVIEW_CONTROL_CHANNEL, { projectId, tabId, action }),
    subscribe(listener) {
      const receive = (_event: Electron.IpcRendererEvent, value: PreviewEvent) => listener(value);
      ipcRenderer.on(PREVIEW_EVENT_CHANNEL, receive);
      return () => ipcRenderer.removeListener(PREVIEW_EVENT_CHANNEL, receive);
    },
  },
  application: {
    catalogSources: () => call("catalog.sources", {}),
    searchCatalog: (input) => call("catalog.search", input),
    catalogDetail: (input) => call("catalog.detail", input),
    configureCatalog: (input) => call("catalog.configure", input),
    installedPlugins: (moduleId) => call("catalog.installed", moduleId ? { moduleId } : {}),
    catalogTasks: () => call("catalog.tasks", {}),
    installCatalog: (input) => call("catalog.install", input),
    packageAction: (input) => call("catalog.packageAction", input),
    // 工作区、模型提供方、设置与认证。
    getWorkspace: (cursor) => call("workspace.get", cursor ? { cursor } : {}),
    getProviderTypes: () => call("provider.types", {}),
    getModels: (config, loginId, discover) =>
      call("provider.models", { config, discover, ...(loginId ? { loginId } : {}) }),
    saveProvider: (config, loginId) =>
      call("provider.save", { config, ...(loginId ? { loginId } : {}) }),
    removeProvider: (id) => call("provider.remove", { id }),
    updateSettings: (change) => call("settings.update", change),
    startLogin: (providerType, method) => call("auth.start", { providerType, method }),
    answerLogin: (id, promptId, value) => call("auth.answer", { id, promptId, value }),
    cancelLogin: (id) => call("auth.cancel", { id }),
    getLogin: (id) => call("auth.status", { id }),
    openLogin: (id) => call("auth.open", { id }),

    // 项目目录由主进程通过系统选择器获取，不能由前端直接传入。
    chooseProjectDirectory: () => ipcRenderer.invoke(PROJECT_DIRECTORY_CHANNEL),
    createProject: (input) => ipcRenderer.invoke(PROJECT_CREATE_CHANNEL, input),
    refreshProject: (id) => call("project.refresh", { id }),
    removeProject: (id) => call("project.remove", { id }),
    listHiddenProjects: () => call("project.hidden", {}),
    restoreProject: (id) => call("project.restore", { id }),

    listCodingFiles: (projectId, path, offset, snapshot) =>
      call("coding.list", { projectId, path, offset, ...(snapshot ? { snapshot } : {}) }),
    searchCodingFiles: (projectId, query) => call("coding.search", { projectId, query }),
    readCodingFile: (projectId, path) => call("coding.read", { projectId, path }),
    listCodingChanges: (projectId) => call("coding.changes", { projectId }),
    readCodingDiff: (projectId, path, kind) => call("coding.diff", { projectId, path, kind }),
    forkConversation: (id) => call("conversation.fork", { id }),
    respondExtensionUi: (input) => call("extension.ui.respond", input),

    listSkills: (moduleId, userOnly) =>
      call("skill.library.list", {
        ...(moduleId ? { moduleId } : {}),
        ...(userOnly ? { userOnly } : {}),
      }),
    readSkillDocument: (id, moduleId) =>
      call("skill.library.read", { id, ...(moduleId ? { moduleId } : {}) }),
    createSkillDocument: (input) => call("skill.library.create", input),
    saveSkillDocument: (input) => call("skill.library.save", input),
    importSkillDirectory: () => ipcRenderer.invoke(SKILL_IMPORT_CHANNEL),

    createConversation: (projectId) => call("conversation.create", { projectId }),
    deleteConversation: (id) => call("conversation.delete", { id }),
    updateConversation: (change) => call("conversation.update", change),
    watchConversation: (id) => call("conversation.watch", { id }),
    sendMessage: (id, requestId, text, images) =>
      call("conversation.send", {
        id,
        requestId,
        text,
        ...(images?.length ? { images } : {}),
      }),
    stopConversation: (id) => call("conversation.stop", { id }),

    // 回复工具确认请求，并订阅后端状态变化。
    respondShell: (id, approved) => call("shell.respond", { id, approved }),
    subscribe(listener) {
      const receive = (_event: Electron.IpcRendererEvent, value: ApplicationEvent) =>
        listener(value);
      ipcRenderer.on(EVENT_CHANNEL, receive);
      return () => ipcRenderer.removeListener(EVENT_CHANNEL, receive);
    },
  },
};

contextBridge.exposeInMainWorld("desktop", desktop);
