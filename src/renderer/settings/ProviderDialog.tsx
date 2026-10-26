import { useEffect, useRef, useState } from "react";
import type {
  LoginInfo,
  ModelChoice,
  ProviderConfig,
  ProviderInfo,
  ProviderTypeInfo,
} from "../../shared/application.ts";
import { Dialog, Field, Notice } from "../components/Dialog.tsx";
import { Select } from "../components/Select.tsx";
import { LoginDialog } from "./LoginDialog.tsx";
import { ModelSelection } from "./ModelSelection.tsx";

export function ProviderDialog({
  provider,
  secureStorage,
  onSave,
  onClose,
}: {
  provider: ProviderInfo | null;
  secureStorage: boolean;
  onSave: () => void;
  onClose: () => void;
}) {
  const api = window.desktop.application;
  const [types, setTypes] = useState<ProviderTypeInfo[]>([]);
  const [draft, setDraft] = useState<ProviderConfig>(
    provider ?? {
      id: crypto.randomUUID(),
      name: "DeepSeek",
      providerType: "deepseek",
      authMethod: "api_key",
      endpoint: "https://api.deepseek.com",
      enabled: true,
      models: [],
      persistCredentials: secureStorage,
    },
  );
  const [catalog, setCatalog] = useState<ModelChoice[]>([]);
  const [step, setStep] = useState<"connection" | "models">("connection");
  const [login, setLogin] = useState<LoginInfo | null>(null);
  const [authenticated, setAuthenticated] = useState(provider?.configured ?? false);
  const authId = useRef("");
  const [modelId, setModelId] = useState("");
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void api.getProviderTypes().then(
      (value) => {
        if (active) setTypes(value);
      },
      () => {
        if (active) setError("提供方目录读取失败。");
      },
    );
    return () => {
      active = false;
      if (authId.current) void api.cancelLogin(authId.current);
    };
  }, [api]);
  function change(patch: Partial<ProviderConfig>, clearAuth = false) {
    if (clearAuth) {
      if (authId.current) void api.cancelLogin(authId.current);
      authId.current = "";
      setAuthenticated(false);
    }
    setDraft((value) => ({ ...value, ...patch }));
    setError("");
  }
  function chooseType(id: string) {
    const type = types.find((item) => item.id === id);
    if (!type) return;
    change(
      {
        providerType: id,
        name: type.name,
        endpoint: type.endpoint,
        authMethod: type.methods[0]?.id ?? "api_key",
        models: [],
      },
      true,
    );
    setCatalog([]);
  }
  async function authorize() {
    if (draft.authMethod !== "api_key" && draft.authMethod !== "oauth") return;
    setBusy(true);
    setError("");
    try {
      const attempt = await api.startLogin(draft.providerType, draft.authMethod);
      authId.current = attempt.id;
      setLogin(attempt);
    } catch (error) {
      setError(error instanceof Error ? error.message : "无法开始认证。");
    } finally {
      setBusy(false);
    }
  }
  async function readModels(discover: boolean) {
    setBusy(true);
    setError("");
    try {
      setCatalog(await api.getModels(config(), authId.current || undefined, discover));
      setStep("models");
    } catch (error) {
      setError(error instanceof Error ? error.message : "模型目录读取失败。");
    } finally {
      setBusy(false);
    }
  }
  function config(): ProviderConfig {
    // Explicit fields prevent status flags or secrets from entering persisted configuration.
    return {
      id: draft.id,
      name: draft.name.trim(),
      providerType: draft.providerType,
      authMethod: draft.authMethod,
      endpoint: draft.endpoint.trim(),
      enabled: draft.enabled,
      persistCredentials: draft.persistCredentials,
      models: draft.models,
    };
  }
  async function save() {
    setBusy(true);
    setError("");
    try {
      await api.saveProvider(config(), authId.current || undefined);
      authId.current = "";
      onSave();
    } catch (error) {
      setError(error instanceof Error ? error.message : "保存失败。");
    } finally {
      setBusy(false);
    }
  }
  const type = types.find((item) => item.id === draft.providerType);
  const ready = ["none", "environment"].includes(draft.authMethod) || authenticated;
  return (
    <Dialog
      title={provider ? "编辑 AI 服务" : "添加 AI 服务"}
      onClose={onClose}
      protectChanges
      wide
    >
      <div className="steps">
        <span className={step === "connection" ? "active" : ""}>1 连接与认证</span>
        <span>—</span>
        <span className={step === "models" ? "active" : ""}>2 选择模型</span>
      </div>
      {step === "connection" ? (
        <>
          <Field label="模型提供方">
            <Select
              value={draft.providerType}
              disabled={!!provider}
              onValueChange={chooseType}
              options={types.map((item) => ({ value: item.id, label: item.name }))}
            />
          </Field>
          <Field label="服务名称">
            <input
              value={draft.name}
              onChange={(event) => change({ name: event.target.value })}
              maxLength={100}
            />
          </Field>
          <Field label="认证方式">
            <Select
              value={draft.authMethod}
              onValueChange={(value) => change({ authMethod: value }, true)}
              options={(type?.methods ?? []).map((method) => ({
                value: method.id,
                label: method.name,
              }))}
            />
          </Field>
          <Field label="API 地址">
            <input
              value={draft.endpoint}
              disabled={draft.authMethod === "oauth"}
              placeholder="https://api.example.com/v1"
              onChange={(event) => change({ endpoint: event.target.value }, true)}
            />
          </Field>
          {draft.authMethod === "environment" ? (
            <Notice>
              将使用此服务的系统环境变量、云身份或凭据文件；不会读取 Pi
              的账号目录。实际可用性由提供方检查。
            </Notice>
          ) : draft.authMethod === "none" ? (
            <p className="small muted">仅适用于你配置的本地兼容服务。</p>
          ) : (
            <div className="button-group">
              <button type="button" disabled={busy} onClick={() => void authorize()}>
                {authenticated
                  ? "重新认证"
                  : draft.authMethod === "oauth"
                    ? "登录提供方账号"
                    : "配置 API Key"}
              </button>
              <span className="small muted">{authenticated ? "认证已就绪" : "尚未配置认证"}</span>
            </div>
          )}
          <label className="check-row">
            <input
              type="checkbox"
              checked={draft.persistCredentials}
              disabled={!secureStorage}
              onChange={(event) => change({ persistCredentials: event.target.checked })}
            />
            使用系统保护保存凭据
          </label>
          {!draft.persistCredentials && (
            <p className="small muted">凭据仅本次使用；服务配置仍会保存，退出后需重新认证。</p>
          )}
          {!secureStorage && (
            <Notice>系统安全存储不可用，已禁用凭据持久化，不会降级为明文。</Notice>
          )}
          <div className="dialog-actions">
            <button
              type="button"
              className="primary"
              disabled={busy || !ready || !draft.name.trim()}
              onClick={() => void readModels(false)}
            >
              下一步：选择模型
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="button-group">
            <button type="button" disabled={busy} onClick={() => void readModels(true)}>
              读取服务模型目录
            </button>
            <span className="small muted">目录读取不等于推理成功</span>
          </div>
          <ModelSelection
            catalog={catalog}
            selected={draft.models}
            allowManual={["local", "compatible"].includes(draft.providerType)}
            filter={filter}
            onFilter={setFilter}
            modelId={modelId}
            onModelId={setModelId}
            onChange={(models) => change({ models })}
          />
          <div className="dialog-actions">
            <button type="button" disabled={busy} onClick={() => setStep("connection")}>
              返回连接设置
            </button>
            <button
              type="button"
              className="primary"
              disabled={busy || !draft.models.length}
              onClick={() => void save()}
            >
              {busy ? "处理中…" : "保存服务"}
            </button>
          </div>
        </>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {login && (
        <LoginDialog
          initial={login}
          onComplete={() => {
            setAuthenticated(true);
            setLogin(null);
          }}
          onCancel={() => {
            void api.cancelLogin(login.id);
            authId.current = "";
            setAuthenticated(false);
            setLogin(null);
          }}
        />
      )}
    </Dialog>
  );
}
