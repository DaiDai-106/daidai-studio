import { useEffect, useRef, useState } from "react";
import type { PreviewEvent } from "../../../../contracts/web_preview.ts";
import { IconButton } from "../../../shared/components/icon.tsx";

export function WebPreview({
  projectId,
  tabId,
  initialUrl,
  initialFile,
  active,
  enabled,
}: {
  projectId: string;
  tabId: string;
  initialUrl: string;
  initialFile?: string;
  active: boolean;
  enabled: boolean;
}) {
  const [address, setAddress] = useState(initialFile ?? initialUrl);
  const [request, setRequest] = useState({
    value: initialFile ?? initialUrl,
    file: Boolean(initialFile),
    revision: 0,
  });
  const [opened, setOpened] = useState(false);
  const [state, setState] = useState<PreviewEvent | null>(null);
  const [error, setError] = useState("");
  const viewport = useRef<HTMLDivElement>(null);

  useEffect(
    () =>
      window.desktop.preview.subscribe((event) => {
        if (event.projectId === projectId && event.tabId === tabId) setState(event);
      }),
    [projectId, tabId],
  );

  useEffect(() => {
    if (!request.value) return;
    let live = true;
    setOpened(false);
    setState(null);
    setError("");
    const opening = request.file
      ? window.desktop.preview.openFile(projectId, tabId, request.value)
      : window.desktop.preview.open(projectId, tabId, request.value);
    void opening.then(
      () => {
        if (live) setOpened(true);
      },
      (cause: unknown) => {
        if (live) setError(cause instanceof Error ? cause.message : "无法打开网页预览。");
      },
    );
    return () => {
      live = false;
      void window.desktop.preview.control(projectId, tabId, "close").catch(() => {});
    };
  }, [projectId, tabId, request]);

  useEffect(() => {
    if (!opened) return;
    let frame = 0;
    let previous = "";
    const sync = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const element = viewport.current;
        const rect = element?.getBoundingClientRect();
        const bounds =
          active &&
          enabled &&
          state?.status !== "error" &&
          rect &&
          rect.width > 0 &&
          rect.height > 0
            ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
            : null;
        const key = JSON.stringify(bounds);
        if (key !== previous) {
          previous = key;
          void window.desktop.preview.show(projectId, tabId, bounds).catch(() => {});
        }
      });
    };
    const observer = new ResizeObserver(sync);
    if (viewport.current) observer.observe(viewport.current);
    window.addEventListener("resize", sync);
    window.addEventListener("scroll", sync, true);
    sync();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", sync);
      window.removeEventListener("scroll", sync, true);
      void window.desktop.preview.show(projectId, tabId, null).catch(() => {});
    };
  }, [projectId, tabId, opened, active, enabled, state?.status]);

  function command(action: "back" | "forward" | "reload") {
    void window.desktop.preview.control(projectId, tabId, action).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : "预览操作失败。");
    });
  }

  return (
    <div className="web-preview">
      <form
        className="web-preview-toolbar"
        onSubmit={(event) => {
          event.preventDefault();
          if (address.trim())
            setRequest((value) => ({
              value: address.trim(),
              file: Boolean(initialFile && address.trim() === initialFile),
              revision: value.revision + 1,
            }));
        }}
      >
        <IconButton
          icon="back"
          label="预览后退"
          onClick={() => command("back")}
          disabled={!state?.canGoBack}
        />
        <button
          type="button"
          className="icon-button"
          aria-label="预览前进"
          disabled={!state?.canGoForward}
          onClick={() => command("forward")}
        >
          →
        </button>
        <IconButton
          icon="refresh"
          label="刷新预览"
          onClick={() => command("reload")}
          disabled={!opened}
        />
        <input
          aria-label="网页预览地址"
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          placeholder="google.com 或 http://localhost:端口"
        />
        <button type="submit">打开</button>
      </form>
      <div className="web-preview-status" role="status">
        {state?.url || "支持 HTTPS 网页和本机 HTTP 服务"}
        {state?.status === "loading" ? " · 加载中…" : ""}
      </div>
      <div className="web-preview-viewport" ref={viewport}>
        {error || state?.error ? (
          <p role="alert">{error || state?.error}</p>
        ) : !request.value ? (
          <p>输入 HTTPS 网页或已运行的本机服务地址。</p>
        ) : !opened ? (
          <p>正在打开预览…</p>
        ) : null}
      </div>
    </div>
  );
}
