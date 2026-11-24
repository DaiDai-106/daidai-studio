import { useState } from "react";
import type { ApplicationBridge } from "../../../../contracts/bridge.ts";
import type { DwgParserStatus } from "../../../../contracts/dwgparser.ts";
import { Dialog } from "../../../shared/components/dialog.tsx";
import { errorMessage } from "../../../shared/logic/error_message.ts";

export function DwgParserSetupDialog({
  api,
  onConfigured,
  onClose,
}: {
  api: ApplicationBridge;
  onConfigured(status: DwgParserStatus): void | Promise<void>;
  onClose(): void;
}) {
  const [configuring, setConfiguring] = useState(false);
  const [error, setError] = useState("");
  const [cleanupWarning, setCleanupWarning] = useState("");

  async function configure() {
    setConfiguring(true);
    setError("");
    try {
      const status = await api.configureDwgParser();
      if (!status) return;
      await onConfigured(status);
      if (status.message) setCleanupWarning(status.message);
      else onClose();
    } catch (cause) {
      setError(errorMessage(cause, "无法配置设备证书目录。"));
    } finally {
      setConfiguring(false);
    }
  }

  return (
    <Dialog
      title="配置非标图纸工艺"
      onClose={() => {
        if (!configuring) onClose();
      }}
    >
      <p>
        选择包含 server-ca.crt、device.crt 和 device.key
        的目录。换证时，新证书通过连接测试并保存后，会删除上一目录中的 device.key。
      </p>
      {(error || cleanupWarning) && (
        <p className="plugin-error" role="alert">
          {error || cleanupWarning}
        </p>
      )}
      <div className="dialog-actions">
        {cleanupWarning ? (
          <button type="button" className="primary" onClick={onClose}>
            完成
          </button>
        ) : (
          <>
            <button type="button" disabled={configuring} onClick={onClose}>
              取消
            </button>
            <button
              type="button"
              className="primary"
              disabled={configuring}
              onClick={() => void configure()}
            >
              {configuring ? "正在配置…" : "选择证书目录"}
            </button>
          </>
        )}
      </div>
    </Dialog>
  );
}
