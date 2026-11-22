import { useEffect, useRef, useState } from "react";
import {
  type CatalogEntry,
  type CatalogInstalled,
  type CatalogSourceId,
  type PluginModule,
  pluginModules,
} from "../../../../contracts/catalog.ts";
import type { DesktopTheme } from "../../../../contracts/desktop_theme.ts";
import { productName } from "../../../../shared/app_metadata.ts";
import { Dialog } from "../../../shared/components/dialog.tsx";
import { Icon } from "../../../shared/components/icon.tsx";
import { type PluginSelection, usePluginCenter } from "../logic/use_plugin_center.ts";
import { PluginConfirmation, type PluginConfirmationRequest } from "./plugin_confirmation.tsx";
import { PluginDetail } from "./plugin_detail.tsx";
import {
  installedPluginKey,
  loadLabels,
  PluginDiscover,
  PluginInstalled,
} from "./plugin_lists.tsx";
import { ResourceTags, scopeLabel, sources } from "./plugin_presentation.tsx";
import { CompanySettings } from "./plugin_source_dialogs.tsx";
import { SettingRow } from "./settings_controls.tsx";
import { SkillLibrary } from "./skill_library.tsx";
import "../styles/plugin_center.css";

export function PluginCenter({
  moduleId = "coding",
  onAppearance,
  desktopThemes = [],
  desktopThemeErrors = {},
}: {
  moduleId?: PluginModule;
  onAppearance?: () => void;
  desktopThemes?: DesktopTheme[];
  desktopThemeErrors?: Record<string, string>;
}) {
  const center = usePluginCenter(moduleId);
  const installedPlugins = center.installed.map((item): CatalogInstalled => {
    if (item.host !== "desktop" || !item.enabled) return item;
    const error = desktopThemeErrors[`${item.scope}:${item.source}`];
    if (error) return { ...item, loadState: "failed", error };
    const themeReady = desktopThemes.some((theme) => theme.source === item.source);
    return themeReady ? { ...item, loadState: "ready" } : item;
  });
  const [company, setCompany] = useState(false);
  const [confirmation, setConfirmation] = useState<PluginConfirmationRequest | null>(null);
  const [localSelection, setLocalSelection] = useState<string | null>(null);
  const localDetail = installedPlugins.find((item) => installedPluginKey(item) === localSelection);
  const focusReturn = useRef<HTMLElement | null>(null);
  const [dismissedTask, setDismissedTask] = useState(
    () => sessionStorage.getItem("dismissedPluginTask") ?? "",
  );
  const latestTask = center.tasks[0];
  useEffect(() => {
    if (localSelection && !localDetail) setLocalSelection(null);
  }, [localSelection, localDetail]);

  function open(entry: PluginSelection) {
    focusReturn.current = document.activeElement as HTMLElement;
    void center.openDetail(entry);
  }

  function close() {
    center.closeDetail();
    requestAnimationFrame(() => focusReturn.current?.focus());
  }

  function installEntry(entry: CatalogEntry, version: string) {
    setConfirmation({ kind: "catalog", entry, version });
  }
  return (
    <div className="plugin-center">
      <div className="plugin-heading">
        <p className="plugin-subtitle">为你的 {productName} 增加新能力。</p>
        <button
          type="button"
          className="plugin-secondary"
          onClick={() => setConfirmation({ kind: "manual" })}
        >
          <Icon name="plus" size={15} />
          手动安装
        </button>
      </div>
      <div className="plugin-tabs" role="tablist" aria-label="插件中心">
        {(
          [
            ["discover", "发现插件"],
            ["installed", "已安装"],
            ["skills", "我的技能"],
            ["builtins", "内置模块"],
          ] as const
        ).map(([id, label]) => (
          <button
            type="button"
            role="tab"
            key={id}
            aria-selected={center.tab === id}
            onClick={() => center.setTab(id)}
          >
            {label}
            {id === "installed" && <span className="plugin-count">{installedPlugins.length}</span>}
          </button>
        ))}
      </div>
      {center.error && !confirmation && (
        <p className="plugin-error" role="alert">
          {center.error}
        </p>
      )}
      {latestTask && (latestTask.state === "running" || latestTask.id !== dismissedTask) && (
        <div className={`plugin-task ${latestTask.state}`} role="status">
          <Icon
            name={
              latestTask.state === "running"
                ? "loading"
                : latestTask.state === "failed"
                  ? "info"
                  : "check"
            }
            size={17}
          />
          <div>
            <strong>
              {latestTask.state === "running"
                ? "正在处理插件"
                : latestTask.state === "failed"
                  ? "操作未完成"
                  : "操作已完成"}
            </strong>
            <p>{latestTask.message}</p>
          </div>
          {latestTask.state !== "running" && (
            <button
              type="button"
              className="plugin-task-close"
              aria-label="关闭操作提示"
              onClick={() => {
                sessionStorage.setItem("dismissedPluginTask", latestTask.id);
                setDismissedTask(latestTask.id);
              }}
            >
              <Icon name="close" size={16} />
            </button>
          )}
        </div>
      )}
      <PluginDiscover
        center={center}
        installedPlugins={installedPlugins}
        onOpen={open}
        onCompany={() => setCompany(true)}
      />
      <PluginInstalled
        center={center}
        installedPlugins={installedPlugins}
        moduleId={moduleId}
        onAppearance={onAppearance}
        onDetail={(item) => setLocalSelection(installedPluginKey(item))}
        onConfirm={setConfirmation}
      />
      {center.tab === "skills" && <SkillLibrary moduleId={moduleId} userOnly />}
      {center.tab === "builtins" && (
        <div role="tabpanel" aria-label="内置模块">
          <SettingRow
            title={pluginModules.coding}
            description="在 Coding 项目中浏览文件、查看 Git 变更，通过对话分析和编辑代码。"
          />
          <SettingRow
            title={pluginModules.scene}
            description="在场景项目中导入 STEP 或 URDF，编辑连杆和关节、预览运动，并导出 URDF 和 STL 网格。"
          />
        </div>
      )}
      {center.detailState && (
        <PluginDetail
          key={`${center.detailState.entry.sourceId}:${center.detailState.entry.id}`}
          center={center}
          moduleId={moduleId}
          onClose={close}
          onInstall={installEntry}
        />
      )}
      {localDetail && (
        <Dialog title="已安装插件详情" onClose={() => setLocalSelection(null)}>
          <h3>{localDetail.name}</h3>
          <dl className="plugin-facts">
            <dt>来源</dt>
            <dd>{sources[localDetail.sourceId]}</dd>
            <dt>安装规格</dt>
            <dd>
              <code>{localDetail.source}</code>
            </dd>
            <dt>版本</dt>
            <dd>{localDetail.version || "未知"}</dd>
            <dt>使用范围</dt>
            <dd>{scopeLabel(localDetail.scope, localDetail.moduleId ?? moduleId)}</dd>
            <dt>加载状态</dt>
            <dd>{loadLabels[localDetail.loadState]}</dd>
          </dl>
          {localDetail.host === "desktop" ? (
            <ResourceTags entry={localDetail} />
          ) : localDetail.enabled ? (
            <SkillLibrary
              key={`${localSelection}:${localDetail.version}`}
              moduleId={moduleId}
              packageSource={localDetail.source}
              packageScope={localDetail.scope}
            />
          ) : (
            <p className="plugin-note">插件已停用，启用后可查看附带技能。</p>
          )}
          {localDetail.error && <p className="plugin-error">{localDetail.error}</p>}
          {localDetail.entryId && localDetail.sourceId !== "manual" && (
            <button
              type="button"
              onClick={() => {
                const item = localDetail;
                setLocalSelection(null);
                open({
                  sourceId: item.sourceId as CatalogSourceId,
                  host: item.host,
                  id: item.entryId,
                  name: item.name,
                  description: item.description,
                });
              }}
            >
              查看市场详情与其他版本
            </button>
          )}
        </Dialog>
      )}
      {company && (
        <CompanySettings
          url={center.companyUrl}
          onClose={() => setCompany(false)}
          onSave={center.configure}
        />
      )}
      {confirmation && (
        <PluginConfirmation
          request={confirmation}
          moduleId={moduleId}
          busy={center.busy}
          error={center.error}
          onClose={() => setConfirmation(null)}
          onConfirm={(scope, source, host, update) =>
            update
              ? center.install({ ...update, scope, moduleId })
              : confirmation.kind === "catalog"
                ? center.install({
                    sourceId: confirmation.entry.sourceId,
                    id: confirmation.entry.id,
                    version: confirmation.version,
                    scope,
                    moduleId,
                  })
                : center.operation({
                    action: confirmation.kind === "manual" ? "install" : confirmation.kind,
                    source,
                    host,
                    scope,
                    moduleId,
                  })
          }
        />
      )}
    </div>
  );
}
