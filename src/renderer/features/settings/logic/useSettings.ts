import type { ApplicationState } from "../../../app/logic/useApplication.ts";
import type { Theme } from "../../../shared/logic/types.ts";
import { availableModels } from "./models.ts";

// 模型、主题与显示偏好由应用设置提供；扩展和技能使用各自的 Pi 接口。
export function useSettings(application: ApplicationState) {
  const settings = application.workspace?.settings;
  return {
    providers: settings?.providers ?? [],
    models: availableModels(settings?.providers ?? []),
    theme: settings?.theme ?? "light",
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
