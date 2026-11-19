import { useEffect, useState } from "react";
import {
  type CatalogEntry,
  type CatalogInstalled,
  type CatalogSourceId,
  type PluginHost,
  type PluginModule,
  pluginModules,
} from "../../../../contracts/catalog.ts";
import { Dialog, Field } from "../../../shared/components/dialog.tsx";
import { Icon } from "../../../shared/components/icon.tsx";
import { Select } from "../../../shared/components/select.tsx";
import { errorMessage } from "../../../shared/logic/error_message.ts";
import { scopeLabel, sources } from "./plugin_presentation.tsx";

type PluginScope = CatalogInstalled["scope"];

export type PluginConfirmationRequest =
  | { kind: "catalog"; entry: CatalogEntry; version: string }
  | { kind: "manual" }
  | { kind: "update" | "remove"; item: CatalogInstalled };

export function PluginConfirmation({
  request,
  moduleId = "coding",
  busy,
  error,
  onConfirm,
  onClose,
}: {
  request: PluginConfirmationRequest;
  moduleId?: PluginModule;
  busy: boolean;
  error: string;
  onConfirm(
    scope: PluginScope,
    source: string,
    host: PluginHost,
    update?: { sourceId: CatalogSourceId; id: string; version: string; replaceSource: string },
  ): Promise<boolean>;
  onClose(): void;
}) {
  const [scope, setScope] = useState<PluginScope>(
    "item" in request ? request.item.scope : "global",
  );
  const [input, setInput] = useState("");
  const [manualHost, setManualHost] = useState<PluginHost>("pi");
  const [reviewed, setReviewed] = useState(request.kind !== "manual");
  const [pending, setPending] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [latest, setLatest] = useState<CatalogEntry | null>(null);
  const [lookupError, setLookupError] = useState("");
  const marketItem =
    request.kind === "update" && request.item.sourceId !== "manual" ? request.item : null;
  const updateSourceId = marketItem?.sourceId;
  const updateEntryId = marketItem?.entryId;
  const updateHost = marketItem?.host;
  useEffect(() => {
    if (!updateSourceId || updateSourceId === "manual") return;
    if (!updateEntryId) {
      setLookupError("市场来源已变化，请检查插件详情。");
      return;
    }
    let active = true;
    void window.desktop.application
      .catalogDetail({ sourceId: updateSourceId, id: updateEntryId, refresh: true })
      .then((detail) => {
        if (!active) return;
        if (detail.notice) throw new Error("无法获取最新版本，请检查网络后重试。");
        if (detail.entry.host !== updateHost)
          throw new Error("市场插件的宿主已变化，请在详情中检查。");
        setLatest(detail.entry);
      })
      .catch((error) => {
        if (active) setLookupError(errorMessage(error));
      });
    return () => {
      active = false;
    };
  }, [updateSourceId, updateEntryId, updateHost]);
  const installing = request.kind === "catalog" || request.kind === "manual";
  const item = request.kind === "catalog" ? request.entry : "item" in request ? request.item : null;
  const host = item?.host ?? manualHost;
  const desktop = host === "desktop";
  const title = !reviewed
    ? "手动安装插件"
    : request.kind === "remove"
      ? "移除插件"
      : request.kind === "update"
        ? "更新插件"
        : "安装插件";
  const source =
    request.kind === "catalog"
      ? request.entry.sourceId === "pi"
        ? `npm:${request.entry.id}@${request.version}`
        : request.entry.installSource
      : request.kind === "manual"
        ? input.trim()
        : request.item.source;
  const name = item?.name ?? source;
  return (
    <Dialog title={title} onClose={() => !pending && onClose()} protectChanges={!reviewed}>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (!reviewed) {
            setReviewed(true);
            return;
          }
          if (marketItem && (!latest || lookupError || latest.version === marketItem.version))
            return;
          setPending(true);
          setAttempted(true);
          try {
            if (
              await onConfirm(
                desktop ? "global" : scope,
                source,
                host,
                marketItem && latest && marketItem.sourceId !== "manual"
                  ? {
                      sourceId: marketItem.sourceId,
                      id: marketItem.entryId,
                      version: latest.version,
                      replaceSource: marketItem.source,
                    }
                  : undefined,
              )
            )
              onClose();
          } finally {
            setPending(false);
          }
        }}
      >
        {reviewed && (
          <div className="plugin-confirm-name">
            <Icon name="tool" size={22} />
            <strong>{name}</strong>
          </div>
        )}
        {request.kind === "catalog" && (
          <p>
            {sources[request.entry.sourceId]} · {request.entry.publisher || "发布者未知"} · v
            {request.version}
          </p>
        )}
        {reviewed ? (
          <code className="plugin-source-code">{source}</code>
        ) : (
          <>
            <p className="plugin-detail-description">
              使用 Pi 原生包格式，从本地、npm 或 Git 添加能力。
            </p>
            <Field label="包来源">
              <input
                value={input}
                onChange={(event) => setInput(event.target.value)}
                placeholder="npm:包名、git:仓库地址或本地绝对路径"
              />
            </Field>
          </>
        )}
        {installing && (
          <>
            {request.kind === "manual" && (
              <Field label="插件类型" hint="Pi 插件为 AI 增加能力，桌面插件扩展 Dai 的外观等功能。">
                <Select<PluginHost>
                  aria-label="插件类型"
                  value={manualHost}
                  onValueChange={(value) => {
                    setManualHost(value);
                    if (value === "desktop") setScope("global");
                  }}
                  disabled={pending || reviewed}
                  options={[
                    { value: "pi", label: "Pi 插件" },
                    { value: "desktop", label: "桌面插件" },
                  ]}
                />
              </Field>
            )}
            <Field
              label="使用范围"
              hint={
                desktop
                  ? "桌面插件对整个应用生效。"
                  : scope === "global"
                    ? "所有模块都可以加载这个插件，包括后续新增的模块。"
                    : `所有 ${pluginModules[moduleId]} 项目共用，不影响其他模块。`
              }
            >
              <Select<PluginScope>
                aria-label="使用范围"
                value={scope}
                onValueChange={setScope}
                disabled={pending}
                options={[
                  { value: "global", label: scopeLabel("global") },
                  ...(!desktop
                    ? [
                        {
                          value: "module" as const,
                          label: scopeLabel("module", moduleId),
                        },
                      ]
                    : []),
                ]}
              />
            </Field>
          </>
        )}
        {marketItem && (
          <p role={lookupError ? "alert" : "status"}>
            {lookupError ||
              (!latest
                ? "正在查询最新版本…"
                : latest.version === marketItem.version
                  ? `当前已是市场版本 ${latest.version}。`
                  : `当前 ${marketItem.version || "未知版本"} → 市场最新 ${latest.version}`)}
          </p>
        )}
        <p className="plugin-note">
          {request.kind === "remove"
            ? "移除包配置及对应安装内容，不删除用户项目文件。本地路径来源保留原目录。"
            : request.kind === "update"
              ? marketItem
                ? "将更新原作用域并保留启用状态。安装可能运行依赖脚本；更新失败可能部分完成。"
                : "按原来源检查更新。固定版本和本地目录不会自动移动；更新失败可能部分完成。"
              : desktop
                ? "桌面插件对整个应用生效，主题可在外观设置中选择。Git/npm 安装可能运行依赖脚本，请确认来源可信。"
                : "Extension 会在 Agent 宿主进程执行代码，安装也可能运行依赖脚本。仅安装你信任的来源。相关会话需先停止；安装完成后下次发送消息时加载。"}
        </p>
        {attempted && error && (
          <p role="alert" className="plugin-error">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" disabled={pending} onClick={onClose}>
            取消
          </button>
          <button
            type="submit"
            className="primary"
            disabled={
              pending ||
              busy ||
              !source ||
              (!!marketItem && (!latest || !!lookupError || latest.version === marketItem.version))
            }
          >
            {!reviewed
              ? "继续安装"
              : pending
                ? "正在提交…"
                : request.kind === "remove"
                  ? "确认移除"
                  : request.kind === "update"
                    ? "确认更新"
                    : "确认安装"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
