import { contextBridge, ipcRenderer, webUtils } from "electron";
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
  SCENE_CONFIRM_JOINT_CHANNEL,
  SCENE_DROP_CHANNEL,
  SCENE_IMPORT_CHANNEL,
  SCENE_RELOCATE_SOURCE_CHANNEL,
  SCENE_REMOVE_CONFIRMED_JOINT_CHANNEL,
  SKILL_IMPORT_CHANNEL,
  THEME_CHANNEL,
} from "../../contracts/desktop.ts";

// 前端只能使用下方显式开放的方法，实际请求由主进程转发给后端。
function call<K extends Method>(method: K, args: Arguments<K>): Promise<Results[K]> {
  return ipcRenderer.invoke(REQUEST_CHANNEL, method, args);
}

const desktop: DesktopBridge = {
  getAppInfo: () => ipcRenderer.invoke(APP_INFO_CHANNEL),
  setTheme: (theme) => ipcRenderer.invoke(THEME_CHANNEL, theme),
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
  application: {
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

    getProjectScene: (projectId) => call("scene.get", { projectId }),
    cancelSceneImport: (projectId) => call("scene.cancelImport", { projectId }),
    getScenePythonStatus: () => call("scene.pythonStatus", {}),
    installScenePython: () => call("scene.installPython", {}),
    importStep: (input) => ipcRenderer.invoke(SCENE_IMPORT_CHANNEL, input),
    relocateSceneSource: (input) => ipcRenderer.invoke(SCENE_RELOCATE_SOURCE_CHANNEL, input),
    setSceneTransform: (input) => call("scene.setTransform", input),
    deleteSceneObject: (input) => call("scene.deleteObject", input),
    confirmSceneJoint: (input) => ipcRenderer.invoke(SCENE_CONFIRM_JOINT_CHANNEL, input),
    discardSceneJointDraft: (input) => call("scene.discardJointDraft", input),
    removeConfirmedSceneJoint: (input) =>
      ipcRenderer.invoke(SCENE_REMOVE_CONFIRMED_JOINT_CHANNEL, input),
    importDroppedStep: (file, input) => {
      const path = webUtils.getPathForFile(file);
      if (!path || !/\.(step|stp)$/iu.test(path))
        return Promise.reject(new Error("请拖入本地 STEP 文件。"));
      return ipcRenderer.invoke(SCENE_DROP_CHANNEL, input, path);
    },

    forkConversation: (id) => call("conversation.fork", { id }),
    listPackages: (projectId) => call("package.list", projectId ? { projectId } : {}),
    updatePackage: (input) => call("package.update", input),
    respondExtensionUi: (input) => call("extension.ui.respond", input),
    installPackage: (input) => call("package.install", input),
    removePackage: (input) => call("package.remove", input),
    setPackageEnabled: (input) => call("package.setEnabled", input),

    listSkills: (projectId) => call("skill.library.list", projectId ? { projectId } : {}),
    readSkillDocument: (id, projectId) =>
      call("skill.library.read", { id, ...(projectId ? { projectId } : {}) }),
    createSkillDocument: (input) => call("skill.library.create", input),
    saveSkillDocument: (input) => call("skill.library.save", input),
    importSkillDirectory: () => ipcRenderer.invoke(SKILL_IMPORT_CHANNEL),

    createConversation: (projectId) => call("conversation.create", { projectId }),
    deleteConversation: (id) => call("conversation.delete", { id }),
    updateConversation: (change) => call("conversation.update", change),
    watchConversation: (id) => call("conversation.watch", { id }),
    sendMessage: (id, requestId, text, images, sceneReference) =>
      call("conversation.send", {
        id,
        requestId,
        text,
        ...(images?.length ? { images } : {}),
        ...(sceneReference ? { sceneReference } : {}),
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
