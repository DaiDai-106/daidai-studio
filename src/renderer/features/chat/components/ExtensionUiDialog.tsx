import { useState } from "react";
import type { ExtensionUiRequest } from "../../../../contracts/application.ts";
import { Dialog } from "../../../shared/components/Dialog.tsx";

export function ExtensionUiDialog({
  request,
  onRespond,
  onStop,
}: {
  request: ExtensionUiRequest;
  onRespond: (response: { requestId: string; cancelled: boolean; value?: string }) => Promise<null>;
  onStop: () => Promise<null>;
}) {
  const [value, setValue] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function respond(cancelled: boolean, answer?: string) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await onRespond({
        requestId: request.requestId,
        cancelled,
        ...(answer !== undefined ? { value: answer } : {}),
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法回复扩展请求。");
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await onStop();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法停止当前请求。");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title={request.title || "扩展请求"} onClose={() => void respond(true)}>
      {request.message && <p>{request.message}</p>}
      {request.kind === "select" && (
        <fieldset>
          <legend>请选择</legend>
          {[...new Set(request.options ?? [])].map((option) => (
            <label key={option}>
              <input
                type="radio"
                name="extension-choice"
                value={option}
                checked={selected === option}
                onChange={() => setSelected(option)}
              />
              {option}
            </label>
          ))}
        </fieldset>
      )}
      {request.kind === "input" && (
        <label>
          输入内容
          <input
            maxLength={100000}
            value={value}
            placeholder={request.placeholder ?? ""}
            onChange={(event) => setValue(event.target.value)}
          />
        </label>
      )}
      {error && <p role="alert">{error}</p>}
      <div className="dialog-actions">
        <button type="button" disabled={busy} onClick={() => void stop()}>
          停止回复
        </button>
        <button type="button" disabled={busy} onClick={() => void respond(true)}>
          取消
        </button>
        {request.kind === "confirm" ? (
          <>
            <button type="button" disabled={busy} onClick={() => void respond(false, "false")}>
              否
            </button>
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() => void respond(false, "true")}
            >
              确认
            </button>
          </>
        ) : (
          <button
            type="button"
            className="primary"
            disabled={busy || (request.kind === "select" && selected === null)}
            onClick={() =>
              void respond(false, request.kind === "select" ? (selected ?? "") : value)
            }
          >
            提交
          </button>
        )}
      </div>
    </Dialog>
  );
}
