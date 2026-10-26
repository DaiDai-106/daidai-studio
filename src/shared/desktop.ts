import type { ApplicationBridge } from "./bridge.ts";

export const REQUEST_CHANNEL = "application:request";
export const EVENT_CHANNEL = "application:event";
export const PROJECT_OPEN_CHANNEL = "desktop:open-project";
export const APP_INFO_CHANNEL = "desktop:app-info";
export const THEME_CHANNEL = "desktop:set-theme";
export const BACKEND_READY = "backend:ready";
export const BACKEND_SHUTDOWN = "backend:shutdown";

export type Theme = "light" | "dark" | "system";

export interface AppInfo {
  name: string;
  version: string;
  electronVersion: string;
  nodeVersion: string;
  dataRoot: string;
  secureStorage: boolean;
}

export interface DesktopBridge {
  application: ApplicationBridge;
  getAppInfo(): Promise<AppInfo>;
  setTheme(theme: Theme): Promise<void>;
}
