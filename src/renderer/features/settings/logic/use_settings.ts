import type { Theme } from "../../../../contracts/desktop.ts";
import type { ApplicationState } from "../../../app/logic/use_application.ts";
import { availableModels } from "./models.ts";

// 模型、主题与显示偏好由应用设置提供；扩展和技能使用各自的 Pi 接口。
export function useSettings(application: ApplicationState) {
  const settings = application.workspace?.settings;
  return {
    providers: settings?.providers ?? [],
    models: availableModels(settings?.providers ?? []),
    theme: settings?.theme ?? "light",
    desktopTheme: settings?.desktopTheme ?? "",
    setDesktopTheme: (desktopTheme: string) => {
      void application.run(() => application.api.updateSettings({ desktopTheme }));
    },
    showThinking: settings?.showThinking ?? true,
    setShowThinking: (showThinking: boolean) => {
      void application.run(() => application.api.updateSettings({ showThinking }));
    },
    defaultModel: settings?.defaultModel ?? "",
    setTheme: (theme: Theme) => {
      void application.run(() => application.api.updateSettings({ theme }));
    },
    setDefaultModel: (defaultModel: string) => {
      void application.run(() => application.api.updateSettings({ defaultModel }));
    },
    updateProviders: () => {
      void application.refresh().catch(application.report);
    },
  };
}
