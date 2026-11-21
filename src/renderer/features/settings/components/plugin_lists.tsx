import { useState } from "react";
import {
  type CatalogInstalled,
  type PluginModule,
  pluginModules,
} from "../../../../contracts/catalog.ts";
import { productName } from "../../../../shared/app_metadata.ts";
import { Icon } from "../../../shared/components/icon.tsx";
import { Select } from "../../../shared/components/select.tsx";
import type { PluginSelection, usePluginCenter } from "../logic/use_plugin_center.ts";
import type { PluginConfirmationRequest } from "./plugin_confirmation.tsx";
import {
  Empty,
  Glyph,
  ResourceTags,
  resourceLabels,
  scopeLabel,
  sources,
} from "./plugin_presentation.tsx";

type Center = ReturnType<typeof usePluginCenter>;

export const loadLabels = {
  waiting: "已启用 · 暂无加载记录",
  loaded: "最近会话加载成功",
  ready: "主题可用",
  failed: "加载失败",
  disabled: "已停用",
} as const;

export function installedPluginKey(item: CatalogInstalled) {
  return `${item.host}:${item.scope}:${item.source}`;
}

export function PluginDiscover({
  center,
  installedPlugins,
  onOpen,
  onCompany,
}: {
  center: Center;
  installedPlugins: CatalogInstalled[];
  onOpen(entry: PluginSelection): void;
  onCompany(): void;
}) {
  const [kind, setKind] = useState("all");
  if (center.tab !== "discover") return null;
  return (
    <div role="tabpanel" aria-label="发现插件">
      <fieldset className="plugin-source-tabs" aria-label="插件来源">
        {(
          [
            ["all", "全部来源"],
            ["pi", "Pi Catalog"],
            ["company", "公司内部"],
          ] as const
        ).map(([id, label]) => (
          <button
            type="button"
            key={id}
            aria-pressed={center.source === id}
            onClick={() => center.setSource(id)}
          >
            {id !== "all" && <span className={`source-dot source-${id}`} />}
            {label}
          </button>
        ))}
      </fieldset>
      <div className="plugin-searchbar">
        <label className="plugin-search">
          <Icon name="search" size={17} />
          <input
            aria-label="搜索插件"
            placeholder="搜索名称、包名或你需要的能力…"
            value={center.query}
            onChange={(e) => center.setQuery(e.target.value)}
          />
          {center.query && (
            <button
              type="button"
              className="icon-button"
              aria-label="清除搜索"
              onClick={() => center.setQuery("")}
            >
              <Icon name="close" size={14} />
            </button>
          )}
        </label>
        <Select
          aria-label="内容类型"
          value={kind}
          onValueChange={setKind}
          options={[
            { value: "all", label: "全部类型" },
            { value: "extension", label: resourceLabels.extension },
            { value: "skill", label: resourceLabels.skill },
            { value: "desktop-theme", label: resourceLabels["desktop-theme"] },
          ]}
        />
        <button
          type="button"
          className="icon-button"
          aria-label="刷新插件目录"
          disabled={center.loading}
          onClick={() => void center.search(true)}
        >
          <Icon name="refresh" size={17} />
        </button>
      </div>
      {(center.source === "all" || center.source === "pi") && (
        <p className="plugin-data-note">
          Pi Catalog 使用 npm 的 pi-package 数据发现插件，收录与排序可能与官网不同。
          <a href="https://pi.dev/packages?type=extension" target="_blank" rel="noreferrer">
            在 Pi 官网查看 ↗
          </a>
        </p>
      )}
      {center.loading && !center.groups.length && (
        <div className="plugin-grid" role="status" aria-label="正在加载插件" aria-busy="true">
          {[0, 1, 2].map((n) => (
            <div key={n} className="plugin-card plugin-skeleton">
              <span />
              <span />
              <span />
            </div>
          ))}
        </div>
      )}
      {center.groups.map((group) => {
        const entries = group.entries.filter(
          (e) => kind === "all" || e.resources.some((resource) => resource === kind),
        );
        return (
          <section className="plugin-group" key={group.sourceId}>
            <header className="plugin-group-heading">
              <div>
                <h2>{sources[group.sourceId]}</h2>
                <span>
                  {group.sourceId === "pi" ? "探索 Pi 社区的开放生态" : "团队共享的工具与知识"}
                </span>
              </div>
              {group.sourceId === "company" && (
                <button type="button" onClick={onCompany}>
                  配置来源
                </button>
              )}
            </header>
            {group.error && (
              <p className="plugin-error" role="alert">
                {group.error}
                {group.cached ? " 当前显示缓存结果。" : ""}
                <button type="button" onClick={() => void center.search(true)}>
                  重试
                </button>
              </p>
            )}
            {!!entries.length && (
              <div className="plugin-grid">
                {entries.map((entry) => {
                  const present = installedPlugins.some(
                    (i) =>
                      i.host === entry.host &&
                      i.sourceId === entry.sourceId &&
                      i.entryId === entry.id,
                  );
                  return (
                    <article className="plugin-card" key={entry.id}>
                      <button
                        type="button"
                        className="plugin-card-main"
                        onClick={() => onOpen(entry)}
                        aria-label={`查看 ${entry.name}`}
                      >
                        <div className="plugin-card-ident">
                          <Glyph name={entry.name} source={entry.sourceId} />
                          <div>
                            <h3 title={entry.name}>{entry.name}</h3>
                            <span className="plugin-card-publisher">
                              {entry.publisher || sources[entry.sourceId]}
                            </span>
                          </div>
                        </div>
                        <p className="plugin-card-description">
                          {entry.description || "作者尚未提供简介，打开详情了解更多。"}
                        </p>
                        <ResourceTags entry={entry} />
                      </button>
                      <footer className="plugin-card-footer">
                        <span>{entry.version ? `v${entry.version}` : "版本未知"}</span>
                        <button
                          type="button"
                          className={present ? "plugin-installed-button" : "plugin-install-button"}
                          onClick={() => onOpen(entry)}
                        >
                          {present ? (
                            <>
                              <Icon name="check" size={13} />
                              已安装
                            </>
                          ) : (
                            "查看详情"
                          )}
                        </button>
                      </footer>
                    </article>
                  );
                })}
              </div>
            )}
            {!entries.length &&
              !group.error &&
              !(center.loading && !center.groups.length) &&
              (group.sourceId === "company" && !center.companyUrl ? (
                <Empty title="让团队的经验成为共同能力">
                  <p>连接公司的插件目录，在这里发现内部工具和技能。</p>
                  <button type="button" onClick={onCompany}>
                    连接公司市场
                  </button>
                </Empty>
              ) : (
                <Empty
                  icon="search"
                  title={kind !== "all" ? "当前页没有已确认的匹配类型" : "没有找到匹配插件"}
                >
                  <p>
                    {kind !== "all"
                      ? "部分插件尚未标注内容类型，可以打开详情了解，或切换全部类型继续浏览。"
                      : "试试其他关键词，或清除筛选。"}
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      center.setQuery("");
                      setKind("all");
                    }}
                  >
                    清除筛选
                  </button>
                </Empty>
              ))}
            {group.nextOffset !== null && (
              <button
                type="button"
                className="plugin-load-more"
                disabled={center.loading}
                onClick={() => void center.search(false, group)}
              >
                {center.loading ? "加载中…" : "加载更多"}
              </button>
            )}
            {group.fetchedAt > 0 && (
              <p className="plugin-updated">
                {group.cached ? "缓存于" : "目录更新于"}{" "}
                {new Date(group.fetchedAt).toLocaleString()}
              </p>
            )}
          </section>
        );
      })}
    </div>
  );
}

export function PluginInstalled({
  center,
  installedPlugins,
  moduleId,
  onAppearance,
  onDetail,
  onConfirm,
}: {
  center: Center;
  installedPlugins: CatalogInstalled[];
  moduleId: PluginModule;
  onAppearance: (() => void) | undefined;
  onDetail(item: CatalogInstalled): void;
  onConfirm(request: PluginConfirmationRequest): void;
}) {
  const [installedQuery, setInstalledQuery] = useState("");
  const [installedSource, setInstalledSource] = useState("all");
  const [installedStatus, setInstalledStatus] = useState("all");
  if (center.tab !== "installed") return null;
  const installed = installedPlugins.filter(
    (i) =>
      `${i.name} ${i.source}`.toLowerCase().includes(installedQuery.toLowerCase()) &&
      (installedSource === "all" || i.sourceId === installedSource) &&
      (installedStatus === "all" ||
        i.loadState === installedStatus ||
        (installedStatus === "enabled" && i.enabled)),
  );
  return (
    <div role="tabpanel" aria-label="已安装插件">
      <div className="plugin-installed-context">
        <span>{`全局插件与 ${pluginModules[moduleId]} 模块插件，对所有 ${pluginModules[moduleId]} 项目生效。`}</span>
        <button type="button" onClick={() => void center.refreshInstalled(true)}>
          刷新状态
        </button>
      </div>
      <div className="plugin-searchbar">
        <label className="plugin-search">
          <Icon name="search" size={16} />
          <input
            aria-label="搜索已安装插件"
            placeholder="搜索已安装插件…"
            value={installedQuery}
            onChange={(e) => setInstalledQuery(e.target.value)}
          />
        </label>
        <Select
          aria-label="已安装来源"
          value={installedSource}
          onValueChange={setInstalledSource}
          options={[
            { value: "all", label: "全部来源" },
            ...Object.entries(sources).map(([value, label]) => ({ value, label })),
          ]}
        />
        <Select
          aria-label="插件状态"
          value={installedStatus}
          onValueChange={setInstalledStatus}
          options={[
            { value: "all", label: "全部状态" },
            { value: "enabled", label: "已启用" },
            { value: "disabled", label: "已停用" },
            { value: "failed", label: "加载异常" },
          ]}
        />
      </div>
      {!installed.length && (
        <Empty
          icon={installedPlugins.length ? "search" : "tool"}
          title={installedPlugins.length ? "没有匹配的已安装插件" : "你的下一份能力，从这里开始"}
        >
          {installedPlugins.length ? (
            <>
              <p>试试其他关键词，或清除来源和状态筛选。</p>
              <button
                type="button"
                onClick={() => {
                  setInstalledQuery("");
                  setInstalledSource("all");
                  setInstalledStatus("all");
                }}
              >
                清除筛选
              </button>
            </>
          ) : (
            <>
              <p>安装插件，为 {productName} 增加工具和技能。</p>
              <button type="button" onClick={() => center.setTab("discover")}>
                浏览插件
              </button>
            </>
          )}
        </Empty>
      )}
      {installed.map((item) => (
        <article className="plugin-installed-row" key={installedPluginKey(item)}>
          <Glyph name={item.name} source={item.sourceId} />
          <div className="plugin-installed-info">
            <button type="button" className="plugin-text-button" onClick={() => onDetail(item)}>
              <strong>{item.name}</strong>
            </button>
            <p>
              {sources[item.sourceId]} · {item.host === "desktop" ? "桌面插件" : "Pi 插件"} ·{" "}
              {item.version ? `v${item.version}` : "版本未知"} ·{" "}
              {scopeLabel(item.scope, item.moduleId ?? moduleId)}
            </p>
            <span className={`plugin-state state-${item.loadState}`}>
              {loadLabels[item.loadState]}
            </span>
          </div>
          <div className="plugin-row-actions">
            {item.loadState === "ready" && onAppearance && (
              <button type="button" onClick={onAppearance}>
                选择主题
              </button>
            )}
            <button
              type="button"
              disabled={center.busy}
              onClick={() =>
                void center.operation({
                  source: item.source,
                  host: item.host,
                  scope: item.scope,
                  moduleId,
                  action: item.enabled ? "disable" : "enable",
                })
              }
            >
              {item.enabled ? "停用" : "启用"}
            </button>
            <button
              type="button"
              disabled={center.busy}
              onClick={() => onConfirm({ kind: "update", item })}
            >
              更新
            </button>
            <button
              type="button"
              disabled={center.busy}
              onClick={() => onConfirm({ kind: "remove", item })}
            >
              移除
            </button>
          </div>
        </article>
      ))}
    </div>
  );
}
