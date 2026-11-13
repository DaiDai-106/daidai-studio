import { useEffect, useRef, useState } from "react";
import type { ScenePythonStatus } from "../../../../contracts/application.ts";

export function ScenePythonSetup() {
  const [status, setStatus] = useState<ScenePythonStatus | null>(null);
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  const [installed, setInstalled] = useState(false);
  const installing = useRef(false);
  useEffect(() => {
    let active = true;
    const api = window.desktop.application;
    const unsubscribe = api.subscribe((event) => {
      if (event.type === "scene.pythonStatus" && active) {
        if (event.status.state === "installing") installing.current = true;
        if (event.status.state === "ready" && installing.current) setInstalled(true);
        setStatus(event.status);
      }
    });
    void api
      .getScenePythonStatus()
      .then((value) => {
        if (active) setStatus((previous) => previous ?? value);
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : "无法检查场景环境。");
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  async function install() {
    if (starting) return;
    setStarting(true);
    setError("");
    try {
      const next = await window.desktop.application.installScenePython();
      if (next.state === "installing") installing.current = true;
      setStatus((previous) =>
        previous?.state === "ready" && next.state === "installing" ? previous : next,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "安装场景环境失败。");
    } finally {
      setStarting(false);
    }
  }

  async function recheck() {
    if (starting) return;
    setStarting(true);
    setError("");
    try {
      setStatus(await window.desktop.application.getScenePythonStatus());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法检查场景环境。");
    } finally {
      setStarting(false);
    }
  }
  if (status?.state === "ready" && !error)
    return installed ? (
      <section className="scene-python-setup" aria-label="场景 Python 环境">
        <p role="status">场景环境已安装，可以导入 STEP。</p>
        <button type="button" onClick={() => setInstalled(false)}>
          知道了
        </button>
      </section>
    ) : null;
  return (
    <section className="scene-python-setup" aria-label="场景 Python 环境">
      {!status && !error ? (
        <p role="status">正在检查场景环境…</p>
      ) : (
        <>
          <p>
            导入 STEP 需要场景 Python 环境。安装需要系统 Python 3.12、pip
            和网络，将下载场景依赖；已有环境不会被覆盖。
          </p>
          {status?.state === "installing" ? (
            <p role="status">正在安装场景环境…</p>
          ) : status && (status.canInstall ?? status.state === "missing") ? (
            <button type="button" disabled={starting} onClick={() => void install()}>
              {status?.error || error ? "重试安装" : "安装场景环境"}
            </button>
          ) : status?.state === "invalid" ? (
            <p>已有环境无法使用且不会被覆盖，请检查或手动处理该环境后重新检查。</p>
          ) : !status ? (
            <button type="button" disabled={starting} onClick={() => void recheck()}>
              重新检查
            </button>
          ) : null}
          {status?.state === "invalid" && !status.canInstall && (
            <button type="button" disabled={starting} onClick={() => void recheck()}>
              重新检查
            </button>
          )}
          {(status?.error || error) && <p role="alert">{status?.error || error}</p>}
        </>
      )}
    </section>
  );
}
