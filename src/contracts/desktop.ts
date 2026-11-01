import type { ApplicationBridge } from "./bridge.ts";

// 渲染进程和主进程共同使用的 IPC 通道名。
export const REQUEST_CHANNEL = "application:request";
export const EVENT_CHANNEL = "application:event";
export const PROJECT_CREATE_CHANNEL = "desktop:create-project";
export const PROJECT_DIRECTORY_CHANNEL = "desktop:choose-project-directory";
export const SCENE_IMPORT_CHANNEL = "desktop:import-scene";
export const SCENE_RELOCATE_SOURCE_CHANNEL = "desktop:relocate-scene-source";
export const SCENE_DROP_CHANNEL = "desktop:drop-scene";
export const SCENE_CONFIRM_JOINT_CHANNEL = "desktop:confirm-scene-joint";
export const SCENE_REMOVE_CONFIRMED_JOINT_CHANNEL = "desktop:remove-confirmed-scene-joint";
export const SKILL_IMPORT_CHANNEL = "desktop:import-skill";
export const APP_INFO_CHANNEL = "desktop:app-info";
export const THEME_CHANNEL = "desktop:set-theme";
export const QUIT_FLUSH_CHANNEL = "desktop:flush-before-quit";
export const QUIT_FLUSH_READY_CHANNEL = "desktop:flush-ready";
export const QUIT_FLUSH_REGISTER_CHANNEL = "desktop:flush-register";
// 主进程与后端进程之间的启动和关闭标记。
export const BACKEND_READY = "backend:ready";
export const BACKEND_SHUTDOWN = "backend:shutdown";

export type Theme = "light" | "dark" | "system";

export interface AppInfo {
  name: string;
  version: string;
  electronVersion: string;
  nodeVersion: string;
  dataRoot: string;
}

// preload 只向前端开放这里列出的桌面能力。
export interface DesktopBridge {
  application: ApplicationBridge;
  getAppInfo(): Promise<AppInfo>;
  setTheme(theme: Theme): Promise<void>;
  onBeforeQuit(flush: () => Promise<void>): () => void;
}
