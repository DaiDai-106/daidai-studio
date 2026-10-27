import { contextBridge, ipcRenderer } from "electron";
import type { ApplicationEvent, Arguments, Method, Results } from "../../shared/application.ts";
import {
  APP_INFO_CHANNEL,
  type DesktopBridge,
  EVENT_CHANNEL,
  PROJECT_OPEN_CHANNEL,
  QUIT_FLUSH_CHANNEL,
  QUIT_FLUSH_READY_CHANNEL,
  QUIT_FLUSH_REGISTER_CHANNEL,
  REQUEST_CHANNEL,
  THEME_CHANNEL,
} from "../../shared/desktop.ts";

function call<K extends Method>(method: K, args: Arguments<K>): Promise<Results[K]> {
  return ipcRenderer.invoke(REQUEST_CHANNEL, method, args);
}
const desktop: DesktopBridge = {
  getAppInfo: () => ipcRenderer.invoke(APP_INFO_CHANNEL),
  setTheme: (theme) => ipcRenderer.invoke(THEME_CHANNEL, theme),
  onBeforeQuit(flush) {
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
    getDisplay: (id) => call("display.get", { id }),
    saveMcp: (config) => call("mcp.save", { config }),
    removeMcp: (id) => call("mcp.remove", { id }),
    inspectMcp: (config, projectId) => call("mcp.inspect", { config, projectId }),
    cancelMcpInspection: (id) => call("mcp.cancelInspect", { id }),
    saveSkill: (config) => call("skill.save", { config }),
    addSkillImage: (id, name, image) => call("skill.image.add", { id, name, image }),
    readSkillImage: (id, path) => call("skill.image.read", { id, path }),
    removeSkillImage: (id, path) => call("skill.image.remove", { id, path }),
    removeSkill: (id) => call("skill.remove", { id }),
    getWorkspace: (cursor) => call("workspace.get", cursor ? { cursor } : {}),
    getProviderTypes: () => call("provider.types", {}),
    getModels: (config, loginId, discover) =>
      call("provider.models", { config, discover, ...(loginId ? { loginId } : {}) }),
    saveProvider: (config, loginId) =>
      call("provider.save", { config, ...(loginId ? { loginId } : {}) }),
    removeProvider: (id) => call("provider.remove", { id }),
    updateSettings: (change) => call("settings.update", change),
    setCapabilityEnabled: (id, enabled) => call("capability.setEnabled", { id, enabled }),
    startLogin: (providerType, method) => call("auth.start", { providerType, method }),
    answerLogin: (id, promptId, value) => call("auth.answer", { id, promptId, value }),
    cancelLogin: (id) => call("auth.cancel", { id }),
    getLogin: (id) => call("auth.status", { id }),
    openLogin: (id) => call("auth.open", { id }),
    openProject: () => ipcRenderer.invoke(PROJECT_OPEN_CHANNEL),
    refreshProject: (id) => call("project.refresh", { id }),
    removeProject: (id) => call("project.remove", { id }),
    createConversation: (projectId) => call("conversation.create", { projectId }),
    deleteConversation: (id) => call("conversation.delete", { id }),
    selectStep: (id, relativePath) => call("conversation.selectStep", { id, relativePath }),
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
    startScene: (id) => call("conversation.startScene", { id }),
    stopConversation: (id) => call("conversation.stop", { id }),
    respondShell: (id, approved) => call("shell.respond", { id, approved }),
    respondViewport: (id, capture) => call("viewport.respond", { id, capture }),
    subscribe(listener) {
      const receive = (_event: Electron.IpcRendererEvent, value: ApplicationEvent) =>
        listener(value);
      ipcRenderer.on(EVENT_CHANNEL, receive);
      return () => ipcRenderer.removeListener(EVENT_CHANNEL, receive);
    },
  },
};
contextBridge.exposeInMainWorld("desktop", desktop);
