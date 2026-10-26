import { useState } from "react";
import type { ProviderConfig, ProviderInfo } from "../../shared/application.ts";
import { Dialog } from "../components/Dialog.tsx";
import { Icon } from "../components/Icon.tsx";
import { Select } from "../components/Select.tsx";
import { availableModels } from "./models.ts";
import { ProviderDialog } from "./ProviderDialog.tsx";
import { SettingRow, Toggle } from "./SettingsControls.tsx";

export function AiSettings({
  providers,
  defaultModel,
  onProviders,
  onDefault,
  secureStorage,
}: {
  providers: ProviderInfo[];
  defaultModel: string;
  onProviders: () => void;
  onDefault: (id: string) => void;
  secureStorage: boolean;
}) {
  const [editor, setEditor] = useState<ProviderInfo | "new" | null>(null);
  const [removing, setRemoving] = useState<ProviderInfo | null>(null);
  const [error, setError] = useState("");
  const models = availableModels(providers);
  async function toggle(provider: ProviderInfo) {
    setError("");
    const { configured: _configured, temporary: _temporary, ...config } = provider;
    try {
      await window.desktop.application.saveProvider({
        ...config,
        enabled: !config.enabled,
      } satisfies ProviderConfig);
      onProviders();
    } catch (error) {
      setError(error instanceof Error ? error.message : "修改失败。");
    }
  }
  return (
    <>
      <div className="page-intro">
        <p>提供方目录、登录和认证复用 pi-ai。普通聊天已连接真实后端。</p>
        <button type="button" className="primary" onClick={() => setEditor("new")}>
          <Icon name="plus" size={16} />
          添加 AI 服务
        </button>
      </div>
      <SettingRow title="新对话默认模型" description="已有对话保留各自的模型选择。">
        <Select
          aria-label="默认模型"
          value={defaultModel}
          onValueChange={onDefault}
          options={
            models.length
              ? models.map((model) => ({ value: model.id, label: model.name }))
              : [{ value: "", label: "未选择模型" }]
          }
        />
      </SettingRow>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <section className="settings-section">
        <h2>
          已配置服务 <span>{providers.length}</span>
        </h2>
        {providers.map((provider) => (
          <div className="service-card" key={provider.id}>
            <div className="service-heading">
              <span className="service-icon">
                <Icon name="model" />
              </span>
              <div>
                <h3>{provider.name}</h3>
                <p>
                  {provider.providerType} ·{" "}
                  {provider.authMethod === "oauth"
                    ? "账号授权"
                    : provider.authMethod === "environment"
                      ? "系统环境认证"
                      : provider.authMethod === "none"
                        ? "本地免密"
                        : "API Key"}{" "}
                  ·{" "}
                  {provider.configured
                    ? provider.temporary
                      ? "仅本次已认证"
                      : "认证已配置"
                    : "需要重新认证"}
                </p>
              </div>
              <Toggle
                label={`启用 ${provider.name}`}
                checked={provider.enabled}
                onChange={() => void toggle(provider)}
              />
            </div>
            {provider.endpoint && <p className="endpoint">{provider.endpoint}</p>}
            <div className="provider-models">
              {provider.models.map((model) => (
                <div className="provider-model" key={model.id}>
                  <span>{model.name}</span>
                  <span className="muted small">{model.context.toLocaleString()} 上下文</span>
                  {defaultModel === `${provider.id}:${model.id}` ? (
                    <span className="tag">默认</span>
                  ) : (
                    <button
                      type="button"
                      className="text-button"
                      disabled={!provider.enabled}
                      onClick={() => onDefault(`${provider.id}:${model.id}`)}
                    >
                      设为默认
                    </button>
                  )}
                </div>
              ))}
            </div>
            <div className="service-actions">
              <button type="button" className="text-button" onClick={() => setEditor(provider)}>
                编辑连接与模型
              </button>
              <button type="button" className="text-button" onClick={() => setRemoving(provider)}>
                移除服务
              </button>
            </div>
          </div>
        ))}
        {!providers.length && (
          <p className="empty-list">
            尚未配置服务。可添加 DeepSeek API，或选择 OpenAI Codex 使用订阅账号授权。
          </p>
        )}
      </section>
      <p className="small muted">
        配置与历史保存在用户目录下的
        .daidai。凭据不回显；系统保护不可用时仅本次使用。目录存在不表示模型请求已通过验证。
      </p>
      {editor && (
        <ProviderDialog
          provider={editor === "new" ? null : editor}
          secureStorage={secureStorage}
          onClose={() => setEditor(null)}
          onSave={() => {
            onProviders();
            setEditor(null);
          }}
        />
      )}
      {removing && (
        <Dialog title="移除 AI 服务" onClose={() => setRemoving(null)}>
          <p>
            移除「{removing.name}
            」的本地配置和凭据？聊天记录会保留，已有对话需要重新选择可用模型。这不撤销服务商端授权。
          </p>
          <div className="dialog-actions">
            <button type="button" onClick={() => setRemoving(null)}>
              取消
            </button>
            <button
              type="button"
              className="primary"
              onClick={() => {
                void window.desktop.application.removeProvider(removing.id).then(
                  () => {
                    setRemoving(null);
                    onProviders();
                  },
                  () => setError("移除失败，请重试。"),
                );
              }}
            >
              移除配置
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}
