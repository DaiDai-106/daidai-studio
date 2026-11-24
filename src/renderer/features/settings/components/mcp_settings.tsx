import { type FormEvent, useEffect, useState } from "react";
import {
  type Arguments,
  type McpScope,
  maxMcpConfigLength,
} from "../../../../contracts/application.ts";
import { pluginModuleIds, pluginModules } from "../../../../contracts/catalog.ts";
import { Field } from "../../../shared/components/dialog.tsx";
import { Select } from "../../../shared/components/select.tsx";
import { errorMessage } from "../../../shared/logic/error_message.ts";
import { DwgParserSettings } from "./dwgparser_settings.tsx";
import { SettingRow } from "./settings_controls.tsx";

const scopeOptions: { value: "global" | McpScope; label: string }[] = [
  { value: "global", label: "全局" },
  ...pluginModuleIds.map((value) => ({ value, label: pluginModules[value] })),
  { value: "process", label: "工艺" },
];

function configScope(scope: "global" | McpScope): Arguments<"mcp.get"> {
  if (scope === "process") return { scope };
  return scope === "global" ? {} : { moduleId: scope };
}

export function McpSettings() {
  const [scope, setScope] = useState<"global" | McpScope>("global");
  const [savedText, setSavedText] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ role: "alert" | "status"; text: string } | null>(null);
  const text = draft ?? savedText;
  const dirty = text !== savedText;
  const canSave = dirty && !saving;

  useEffect(() => {
    let current = true;
    void window.desktop.application.getMcpConfig(configScope(scope)).then(
      (text) => {
        if (current) setSavedText(text);
      },
      (error: unknown) => {
        if (current) setFeedback({ role: "alert", text: errorMessage(error) });
      },
    );
    return () => {
      current = false;
    };
  }, [scope]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSave || text === null) return;
    setFeedback(null);
    setSaving(true);
    try {
      await window.desktop.application.saveMcpConfig({
        ...configScope(scope),
        text,
      });
      setSavedText(text);
      setDraft(null);
      setFeedback({
        role: "status",
        text:
          scope === "process"
            ? "已保存，规划工作区的工艺列表已更新。"
            : "已保存，下次发送消息时生效。",
      });
    } catch (error) {
      setFeedback({ role: "alert", text: errorMessage(error) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section role="tabpanel" aria-label="MCP" className="settings-section">
      <SettingRow title="Code Mode" description="所有模块的会话都可用 Code Mode 组合工具调用。" />
      <SettingRow
        title="MCP 作用域"
        description={
          scope === "process"
            ? "在这里注册工艺服务，每个规划项目可以单独选择。"
            : "全局服务适用于所有模块。同名服务以当前模块的配置为准。"
        }
      >
        <Select
          aria-label="MCP 作用域"
          value={scope}
          disabled={dirty || saving}
          options={scopeOptions}
          onValueChange={(value) => {
            setSavedText(null);
            setDraft(null);
            setFeedback(null);
            setScope(value);
          }}
        />
      </SettingRow>
      {scope === "process" && <DwgParserSettings />}
      <form className="mcp-settings-form" onSubmit={save}>
        <Field label="mcp.json">
          <textarea
            aria-label="MCP JSON 配置"
            value={text ?? ""}
            disabled={savedText === null || saving}
            placeholder={feedback?.role === "alert" ? undefined : "读取中…"}
            spellCheck={false}
            maxLength={maxMcpConfigLength}
            rows={12}
            onChange={(event) => {
              setDraft(event.target.value);
              if (feedback?.role === "status") setFeedback(null);
            }}
          />
        </Field>
        <p className="plugin-note">
          {scope === "process"
            ? "在 mcpServers 中注册工艺服务，可用 label 设置下拉框中的名称。"
            : "在 mcpServers 中配置本地命令或 Streamable HTTP 地址。只添加你信任的服务。"}
        </p>
        {feedback && (
          <p
            className={feedback.role === "alert" ? "plugin-error" : "plugin-note"}
            role={feedback.role}
          >
            {feedback.text}
          </p>
        )}
        <div className="dialog-actions">
          <button
            type="button"
            disabled={!canSave}
            onClick={() => {
              setDraft(null);
              setFeedback(null);
            }}
          >
            撤销编辑
          </button>
          <button type="submit" className="primary" disabled={!canSave}>
            {saving ? "保存中…" : "保存配置"}
          </button>
        </div>
      </form>
    </section>
  );
}
