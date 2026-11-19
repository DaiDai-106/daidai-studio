import { useEffect, useState } from "react";
import type { AppInfo, Theme } from "../../../contracts/desktop.ts";
import { type DesktopThemeState, desktopThemeVariables } from "../../../contracts/desktop_theme.ts";
import { productName } from "../../../shared/app_metadata.ts";

// 窗口主题与系统标题栏独立于项目和对话状态。
export function useDesktop(theme: Theme, desktopThemeId: string) {
  const [info, setInfo] = useState<AppInfo>();
  const [infoError, setInfoError] = useState("");
  const [themeError, setThemeError] = useState("");
  const [windowError, setWindowError] = useState("");
  const [appearance, setAppearance] = useState<DesktopThemeState>({
    themes: [],
    errors: {},
    selection: "none",
  });
  const desktopTheme = appearance.themes.find((item) => item.id === desktopThemeId);
  useEffect(() => {
    let active = true;
    let request = 0;
    const refresh = async () => {
      const version = ++request;
      try {
        const state = await window.desktop.getThemes(desktopThemeId);
        if (!active || version !== request) return;
        setThemeError("");
        setAppearance(state);
        if (state.selection === "missing")
          await window.desktop.application.updateSettings({
            desktopTheme: "",
            expectedDesktopTheme: desktopThemeId,
          });
      } catch {
        if (active && version === request) {
          setAppearance({ themes: [], errors: {}, selection: "error" });
          setThemeError("桌面主题读取失败，可继续使用默认外观。");
        }
      }
    };
    void refresh();
    const unsubscribe = window.desktop.application.subscribe((event) => {
      if (
        event.type === "catalog.task" &&
        event.task.host === "desktop" &&
        event.task.state !== "running"
      )
        void refresh();
    });
    window.addEventListener("focus", refresh);
    return () => {
      active = false;
      unsubscribe();
      window.removeEventListener("focus", refresh);
    };
  }, [desktopThemeId]);
  useEffect(() => {
    let mounted = true;
    void window.desktop.getAppInfo().then(
      (value) => {
        if (mounted) setInfo(value);
      },
      () => {
        if (mounted) setInfoError("应用信息读取失败，可继续查看交互预览。");
      },
    );
    return () => {
      mounted = false;
    };
  }, []);
  useEffect(() => {
    const overlay = navigator.windowControlsOverlay;
    const update = () => {
      document.documentElement.toggleAttribute("data-window-controls-hidden", !overlay?.visible);
    };
    update();
    overlay?.addEventListener("geometrychange", update);
    return () => overlay?.removeEventListener("geometrychange", update);
  }, []);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const palette = desktopTheme
      ? {
          light: {
            background: desktopTheme.light["--surface"],
            text: desktopTheme.light["--text"],
          },
          dark: {
            background: desktopTheme.dark["--surface"],
            text: desktopTheme.dark["--text"],
          },
        }
      : undefined;
    let active = true;
    void window.desktop.setTheme(theme, palette).then(
      () => {
        if (active) setWindowError("");
      },
      () => {
        if (active) setWindowError("窗口主题更新失败，可继续使用工作台。");
      },
    );
    const apply = () => {
      const root = document.documentElement;
      const mode = theme === "system" ? (media.matches ? "dark" : "light") : theme;
      root.dataset.theme = mode;
      if (desktopTheme) {
        root.dataset.daiTheme = desktopTheme.id;
        for (const [name, value] of Object.entries(desktopTheme[mode]))
          root.style.setProperty(name, value);
      }
    };
    apply();
    media.addEventListener("change", apply);
    return () => {
      active = false;
      media.removeEventListener("change", apply);
      delete document.documentElement.dataset.daiTheme;
      for (const name of desktopThemeVariables) document.documentElement.style.removeProperty(name);
    };
  }, [theme, desktopTheme]);
  return {
    info,
    error: infoError || themeError || windowError,
    themes: appearance.themes,
    themeErrors: appearance.errors,
    themeNotice:
      appearance.selection === "missing"
        ? `所选桌面主题已不可用，已恢复 ${productName} 默认外观。`
        : appearance.selection === "error" && desktopThemeId
          ? "主题资源暂不可用，暂用默认外观并保留原选择。"
          : Object.values(appearance.errors).join("；"),
  };
}
