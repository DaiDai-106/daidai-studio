import { useEffect, useState } from "react";
import type { PackageInfo } from "../../../../contracts/application.ts";
import { Select } from "../../../shared/components/Select.tsx";
import type { Project } from "../../../shared/logic/types.ts";
import "../styles/package.css";

export function PackageSettings({
  project,
  onChanged,
}: {
  project: Project | undefined;
  onChanged: () => void;
}) {
  const [items, setItems] = useState<PackageInfo[]>([]);
  const [source, setSource] = useState("");
  const [scope, setScope] = useState<"user" | "project">("user");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const projectId = project?.id;

  useEffect(() => {
    let active = true;
    setItems([]);
    setError("");
    void window.desktop.application
      .listPackages(projectId)
      .then((value) => {
        if (active) setItems(value);
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : "无法读取扩展包。");
      });
    return () => {
      active = false;
    };
  }, [projectId]);

  async function change(action: () => Promise<null>, mayPartiallyUpdate = false) {
    if (busy) return false;
    setBusy(true);
    setError("");
    try {
      await action();
      setItems(await window.desktop.application.listPackages(projectId));
      onChanged();
      return true;
    } catch (cause) {
      let refreshed = true;
      try {
        setItems(await window.desktop.application.listPackages(projectId));
        onChanged();
      } catch {
        refreshed = false;
      }
      const message = cause instanceof Error ? cause.message : "扩展包操作失败。";
      setError(
        `${message}${mayPartiallyUpdate ? " 更新可能部分完成，请核对扩展包状态。" : ""}${refreshed ? "" : " 列表刷新失败，请重试。"}`,
      );
      return false;
    } finally {
      setBusy(false);
    }
  }
  const target = (item: PackageInfo) => ({
    source: item.source,
    scope: item.scope,
    ...(item.scope === "project" && projectId ? { projectId } : {}),
  });

  return (
    <section className="settings-section capability-section" aria-labelledby="package-heading">
      <h2 id="package-heading">扩展包</h2>
      <p className="capabilities-intro">
        支持本地路径、npm 包或 Git 仓库。扩展包可以提供工具、技能和 MCP 服务。
      </p>
      <form
        className="package-install-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!source.trim() || (scope === "project" && !projectId)) return;
          void change(() =>
            window.desktop.application.installPackage({
              source: source.trim(),
              scope,
              ...(scope === "project" && projectId ? { projectId } : {}),
            }),
          ).then((saved) => {
            if (saved) setSource("");
          });
        }}
      >
        <label className="package-install-field package-source-field">
          <span>包来源</span>
          <input
            value={source}
            onChange={(event) => setSource(event.target.value)}
            placeholder="本地路径、npm:包名或 git:仓库地址"
          />
        </label>
        <div className="package-install-field package-scope-field">
          <span>范围</span>
          <Select
            aria-label="范围"
            value={scope}
            onValueChange={setScope}
            options={[
              { value: "user", label: "全局" },
              { value: "project", label: "当前项目", disabled: !projectId },
            ]}
          />
        </div>
        <button
          className="primary package-install-button"
          type="submit"
          disabled={busy || !source.trim() || (scope === "project" && !projectId)}
        >
          {busy ? "处理中…" : "安装扩展包"}
        </button>
      </form>
      <p className="package-help">npm 和 Git 来源需要安装对应工具。</p>
      {items.length > 0 && (
        <p className="package-help">更新时，相同来源的全局和项目扩展包可能会一并更新。</p>
      )}
      {error && (
        <p className="package-error" role="alert">
          {error}
        </p>
      )}
      {!items.length && !error && <p className="package-empty">暂无扩展包</p>}
      {items.map((item) => (
        <div key={`${item.scope}:${item.source}`} className="setting-row package-row">
          <div className="package-info">
            <strong>{item.source}</strong>
            <p>
              {item.scope === "user" ? "全局" : `项目：${project?.name ?? "当前项目"}`}
              {item.filtered ? " · 部分资源已筛选" : ""}
            </p>
          </div>
          <div className="button-group">
            <button
              type="button"
              disabled={busy}
              title="同一来源的全局和项目扩展包可能同时更新"
              onClick={() =>
                void change(
                  () =>
                    window.desktop.application.updatePackage({
                      source: item.source,
                      ...(item.scope === "project" && projectId ? { projectId } : {}),
                    }),
                  true,
                )
              }
            >
              更新
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void change(() =>
                  window.desktop.application.setPackageEnabled({
                    ...target(item),
                    enabled: !item.enabled,
                  }),
                )
              }
            >
              {item.enabled ? "停用" : "启用"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                if (window.confirm(`移除扩展包「${item.source}」？`))
                  void change(() => window.desktop.application.removePackage(target(item)));
              }}
            >
              移除
            </button>
          </div>
        </div>
      ))}
    </section>
  );
}
