import { useEffect, useState } from "react";
import { type DwgParserStatus, dwgParserProcess } from "../../../../contracts/dwgparser.ts";
import { errorMessage } from "../../../shared/logic/error_message.ts";
import { DwgParserSetupDialog } from "./dwgparser_setup_dialog.tsx";
import { SettingRow } from "./settings_controls.tsx";

export function DwgParserSettings() {
  const api = window.desktop.application;
  const [status, setStatus] = useState<DwgParserStatus>();
  const [testing, setTesting] = useState(false);
  const [setup, setSetup] = useState(false);
  const [feedback, setFeedback] = useState<{ type: "error" | "success"; text: string }>();
  useEffect(() => {
    let current = true;
    void api.getDwgParserStatus().then(
      (status) => {
        if (current) setStatus(status);
      },
      (cause) => {
        if (current)
          setFeedback({ type: "error", text: errorMessage(cause, "无法读取工艺证书状态。") });
      },
    );
    return () => {
      current = false;
    };
  }, [api]);

  async function test() {
    setTesting(true);
    setFeedback(undefined);
    try {
      const next = await api.refreshDwgParser();
      setStatus(next);
      if (next.state !== "ready") return;
      const { tools } = await api.testDwgParser();
      setFeedback({ type: "success", text: `连接成功，已发现 ${tools} 个 MCP 工具。` });
    } catch (cause) {
      setFeedback({ type: "error", text: errorMessage(cause, "工艺 MCP 连接测试失败。") });
    } finally {
      setTesting(false);
    }
  }

  const descriptions = {
    ready: "内置服务 · 已读取设备证书",
    missing: "内置服务 · 待配置设备证书",
    invalid: "内置服务 · 设备证书不可用",
  };
  return (
    <>
      <SettingRow
        title={dwgParserProcess.label}
        description={status ? descriptions[status.state] : "内置服务"}
      >
        <button type="button" disabled={testing} onClick={() => setSetup(true)}>
          配置证书
        </button>
        <button type="button" disabled={testing} onClick={() => void test()}>
          {testing ? "正在测试…" : "测试连接"}
        </button>
      </SettingRow>
      {status && (
        <p className="plugin-note">
          设备证书目录 <code>{status.directory}</code>
        </p>
      )}
      {(feedback?.type === "error" || status?.message) && (
        <p role="alert" className="plugin-error">
          {feedback?.text ?? status?.message}
        </p>
      )}
      {feedback?.type === "success" && (
        <p role="status" className="plugin-note">
          {feedback.text}
        </p>
      )}
      {setup && (
        <DwgParserSetupDialog
          api={api}
          onConfigured={(status) => {
            setStatus(status);
            setFeedback(undefined);
          }}
          onClose={() => setSetup(false)}
        />
      )}
    </>
  );
}
