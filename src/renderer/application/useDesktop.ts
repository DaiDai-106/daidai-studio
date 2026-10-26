import { useEffect, useState } from "react";
import type { AppInfo, Theme } from "../../shared/desktop.ts";

// Desktop appearance belongs to the window, independently of projects and chats.
export function useDesktop(theme: Theme) {
  const [info, setInfo] = useState<AppInfo>();
  const [error, setError] = useState("");
  useEffect(() => {
    let mounted = true;
    void window.desktop.getAppInfo().then(
      (value) => {
        if (mounted) setInfo(value);
      },
      () => {
        if (mounted) setError("应用信息读取失败，可继续查看交互预览。");
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
    void window.desktop.setTheme(theme).catch(() => {
      setError("窗口主题更新失败，可继续使用工作台。");
    });
    const apply = () => {
      document.documentElement.dataset.theme =
        theme === "system" ? (media.matches ? "dark" : "light") : theme;
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);
  return { info, error };
}
