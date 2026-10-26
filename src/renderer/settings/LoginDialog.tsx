import { useCallback, useEffect, useRef, useState } from "react";
import type { LoginInfo } from "../../shared/application.ts";
import { Dialog, Field } from "../components/Dialog.tsx";
import { Select } from "../components/Select.tsx";

export function LoginDialog({
  initial,
  onComplete,
  onCancel,
}: {
  initial: LoginInfo;
  onComplete: () => void;
  onCancel: () => void;
}) {
  const [login, setLogin] = useState(initial);
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const revision = useRef(0);
  const promptId = useRef(initial.prompt?.id);
  const acceptLogin = useCallback((state: LoginInfo) => {
    if (promptId.current !== state.prompt?.id) setValue("");
    promptId.current = state.prompt?.id;
    setLogin(state);
  }, []);
  const api = window.desktop.application;
  useEffect(() => {
    let active = true;
    const unsubscribe = api.subscribe((event) => {
      if (active && event.type === "login" && event.login.id === initial.id) {
        ++revision.current;
        acceptLogin(event.login);
      }
    });
    const requested = revision.current;
    void api.getLogin(initial.id).then(
      (state) => {
        if (active && revision.current === requested) acceptLogin(state);
      },
      () => {
        if (active) setError("授权尝试已结束，请重新开始。");
      },
    );
    return () => {
      active = false;
      unsubscribe();
    };
  }, [api, initial.id, acceptLogin]);
  const prompt = login.prompt;
  async function answer() {
    if (!prompt || !value.trim() || sending) return;
    setSending(true);
    setError("");
    const submitted = value;
    setValue("");
    try {
      const requested = revision.current;
      const state = await api.answerLogin(login.id, prompt.id, submitted);
      if (revision.current === requested) acceptLogin(state);
    } catch {
      setError("输入提示已失效或授权被取消，请重新开始。");
    } finally {
      setSending(false);
    }
  }
  return (
    <Dialog title="模型服务认证" onClose={onCancel}>
      <p role="status">{login.message}</p>
      {login.url && login.status === "waiting" && (
        <div className="authorization-state">
          {login.code && <code className="device-code">{login.code}</code>}
          <button
            type="button"
            onClick={() => {
              void api.openLogin(login.id).catch(() => setError("无法打开授权页面，请重新开始。"));
            }}
          >
            打开系统浏览器授权
          </button>
        </div>
      )}
      {prompt && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void answer();
          }}
        >
          <Field label={prompt.message}>
            {prompt.type === "select" ? (
              <Select
                value={value}
                onValueChange={setValue}
                options={prompt.options.map((option) => ({
                  value: option.id,
                  label: option.label,
                }))}
              />
            ) : (
              <input
                type={prompt.type === "secret" ? "password" : "text"}
                autoComplete="off"
                value={value}
                placeholder={prompt.placeholder}
                onChange={(event) => setValue(event.target.value)}
              />
            )}
          </Field>
          <div className="dialog-actions">
            <button type="submit" className="primary" disabled={!value.trim() || sending}>
              {sending ? "提交中…" : "继续认证"}
            </button>
          </div>
        </form>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <button type="button" onClick={onCancel}>
          取消授权
        </button>
        {login.status === "success" && (
          <button type="button" className="primary" onClick={onComplete}>
            使用此认证
          </button>
        )}
      </div>
      <p className="small muted">
        认证由 pi-ai 提供；保存服务前凭据仅属于本次授权尝试，不会写入正式账号。
      </p>
    </Dialog>
  );
}
