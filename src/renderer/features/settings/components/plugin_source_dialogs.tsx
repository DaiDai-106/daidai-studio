import { useState } from "react";
import { Dialog, Field } from "../../../shared/components/dialog.tsx";
import { errorMessage } from "../../../shared/logic/error_message.ts";

export function CompanySettings({
  url,
  onClose,
  onSave,
}: {
  url: string;
  onClose(): void;
  onSave(url: string): Promise<void>;
}) {
  const [value, setValue] = useState(url);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Dialog title="公司插件来源" onClose={() => !busy && onClose()} protectChanges>
      <p className="plugin-detail-description">连接团队维护的 Git 目录仓库，或 HTTPS JSON 目录。</p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            await onSave(value);
            onClose();
          } catch (e) {
            setError(errorMessage(e, "保存失败。"));
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field
          label="目录地址"
          hint="Git 仓库根目录需有 catalog.json，认证使用系统 Git 凭据。HTTPS JSON 需可直接读取；留空可断开连接。"
        >
          <input
            value={value}
            disabled={busy}
            onChange={(e) => setValue(e.target.value)}
            placeholder="git:ssh://git@gitlab.roboticplus.com/dairobot/daidai_plugin/catalog.git"
          />
        </Field>
        {error && (
          <p className="plugin-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? "正在保存…" : "保存来源"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
