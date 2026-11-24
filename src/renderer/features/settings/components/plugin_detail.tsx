import { useState } from "react";
import ReactMarkdown from "react-markdown";
import type { CatalogEntry, PluginModule } from "../../../../contracts/catalog.ts";
import { productName } from "../../../../shared/app_metadata.ts";
import { Dialog } from "../../../shared/components/dialog.tsx";
import { Icon } from "../../../shared/components/icon.tsx";
import { Select } from "../../../shared/components/select.tsx";
import type { usePluginCenter } from "../logic/use_plugin_center.ts";
import { compatibility, Glyph, ResourceTags, scopeLabel, sources } from "./plugin_presentation.tsx";

export function PluginDetail({
  center,
  moduleId,
  onClose,
  onInstall,
}: {
  center: ReturnType<typeof usePluginCenter>;
  moduleId?: PluginModule | undefined;
  onClose(): void;
  onInstall(entry: CatalogEntry, version: string): void;
}) {
  const [version, setVersion] = useState("");
  const [detailTab, setDetailTab] = useState("overview");
  if (!center.detailState) return null;
  const { data: detail, entry, loading, error } = center.detailState;
  const selected = detail?.entry ?? entry;
  const selectedVersion = detail?.versions.includes(version)
    ? version
    : (detail?.entry.version ?? "");
  const installed = center.installed.filter(
    (item) =>
      item.host === selected.host &&
      item.entryId === selected.id &&
      item.sourceId === selected.sourceId,
  );
  const retry = () => void center.openDetail(selected, true);
  return (
    <Dialog
      title="插件详情"
      className="plugin-detail-drawer"
      closeLabel="关闭插件详情"
      onClose={onClose}
    >
      <div className="plugin-detail-hero">
        <Glyph name={selected.name} source={selected.sourceId} />
        <div>
          <span className="plugin-eyebrow">{sources[selected.sourceId]}</span>
          <h2>{selected.name}</h2>
          <p>{selected.publisher}</p>
        </div>
      </div>
      {!detail && selected.description && (
        <p className="plugin-detail-description">{selected.description}</p>
      )}
      {loading && (
        <p className="plugin-detail-loading" role="status">
          <Icon name="loading" size={17} />
          {detail ? "正在更新插件信息…" : "正在读取插件信息与说明…"}
        </p>
      )}
      {error && (
        <div className="plugin-detail-error plugin-error" role="alert">
          <div>
            <strong>暂时无法读取插件详情</strong>
            <p>{error}</p>
          </div>
          <button type="button" disabled={loading} onClick={retry}>
            重试
          </button>
        </div>
      )}
      {detail && (
        <>
          <div className="plugin-detail-actions">
            <Select
              aria-label="安装版本"
              value={selectedVersion}
              onValueChange={setVersion}
              options={detail.versions.map((v) => ({
                value: v,
                label: `v${v}`,
              }))}
            />
            <button
              type="button"
              className="primary"
              disabled={
                center.busy ||
                loading ||
                !!error ||
                !selectedVersion ||
                detail.entry.compatibility === "incompatible"
              }
              onClick={() => onInstall(detail.entry, selectedVersion)}
            >
              {installed.some((item) => item.version === selectedVersion)
                ? "安装到所选范围…"
                : "安装此版本…"}
            </button>
          </div>
          {installed.length > 0 && (
            <p className="plugin-note">
              已安装：
              {installed
                .map(
                  (item) =>
                    `${scopeLabel(item.scope, item.moduleId ?? moduleId)} · v${item.version}`,
                )
                .join("、")}
              。使用范围可在下一步选择。
            </p>
          )}
          {detail.notice && (
            <div className="plugin-detail-notice plugin-note" role="status">
              <p>{detail.notice}</p>
              <button type="button" disabled={loading} onClick={retry}>
                重新读取
              </button>
            </div>
          )}
          <div className="plugin-detail-tabs" role="tablist" aria-label="插件详情分类">
            {[
              ["overview", "概览"],
              ["resources", "包含内容"],
            ].map(([id, label]) => (
              <button
                type="button"
                role="tab"
                key={id}
                aria-selected={detailTab === id}
                onClick={() => setDetailTab(id ?? "overview")}
              >
                {label}
              </button>
            ))}
          </div>
          {detailTab === "overview" && (
            <>
              <p className="plugin-detail-description">{detail.entry.description}</p>
              <dl className="plugin-facts">
                <dt>来源</dt>
                <dd>{sources[detail.entry.sourceId]}</dd>
                <dt>兼容性</dt>
                <dd>{compatibility[detail.entry.compatibility]}</dd>
                <dt>说明</dt>
                <dd>{detail.entry.compatibilityNote}</dd>
                <dt>安装地址</dt>
                <dd>
                  <code>{detail.entry.installSource}</code>
                </dd>
              </dl>
              {detail.entry.homepage && (
                <a
                  className="plugin-external"
                  href={detail.entry.homepage}
                  target="_blank"
                  rel="noreferrer"
                >
                  项目与文档 ↗
                </a>
              )}
              {detail.readme && (
                <div className="plugin-readme">
                  <h3>使用说明</h3>
                  <ReactMarkdown
                    skipHtml
                    components={{
                      img: () => null,
                      a: ({ href, children }) =>
                        href && /^https?:\/\//.test(href) ? (
                          <a href={href} target="_blank" rel="noreferrer">
                            {children}
                          </a>
                        ) : (
                          <span>{children}</span>
                        ),
                    }}
                  >
                    {detail.readme}
                  </ReactMarkdown>
                </div>
              )}
              {!detail.readme && (
                <p className="plugin-note">
                  此处暂未提供使用说明，可通过“项目与文档”了解安装和使用方式。
                </p>
              )}
            </>
          )}
          {detailTab === "resources" && (
            <>
              <ResourceTags entry={detail.entry} />
              <p className="plugin-detail-description">
                {detail.entry.resources.length
                  ? `功能扩展可为 ${productName} 添加工具、命令等功能；技能提供完成特定任务的方法与步骤。`
                  : "作者尚未标注包含内容，请查看插件说明了解它的功能。"}
              </p>
              <p className="plugin-note">
                这些类型由作者声明，具体功能和使用方式请查看插件说明。终端专用界面需要适配桌面交互。
              </p>
            </>
          )}
        </>
      )}
    </Dialog>
  );
}
