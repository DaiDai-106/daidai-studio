import { useRef, useState } from "react";
import type { McpInspection } from "../../shared/capabilities.ts";
import { Dialog, Field, Notice } from "../components/Dialog.tsx";
import { IconButton } from "../components/Icon.tsx";
import { Select } from "../components/Select.tsx";
import type { McpServer, Project } from "../types.ts";
import { ScopeFields } from "./ConnectionFields.tsx";
import { parseMcpConfig, validMcpConfig } from "./connectionConfig.ts";
import { McpToolCatalog } from "./McpToolCatalog.tsx";

const importExample =
  '{\n  "mcpServers": {\n    "my-cad": {\n      "command": "node",\n      "args": ["server.js"]\n    }\n  }\n}';
type Draft = Omit<McpServer, "args"> & { args: { id: string; value: string }[] };

export function McpDialog({
  server,
  importing,
  project,
  defaults,
  onSave,
  onClose,
  onInspect,
  onCancel,
}: {
  server: McpServer | null;
  importing: boolean;
  project: Project | undefined;
  defaults: Pick<McpServer, "scope" | "modes">;
  onSave: (server: McpServer) => void;
  onClose: () => void;
  onInspect: (server: McpServer, projectId: string) => Promise<McpInspection>;
  onCancel: (id: string) => Promise<unknown>;
}) {
  const [draft, setDraft] = useState<Draft>(() => {
    const initial: McpServer = server ?? {
      id: crypto.randomUUID(),
      name: "",
      builtin: false,
      enabled: true,
      transport: "stdio",
      target: "",
      args: [],
      ...defaults,
      timeout: 120,
      checked: false,
    };
    return { ...initial, args: initial.args.map((value) => ({ id: crypto.randomUUID(), value })) };
  });
  const [stage, setStage] = useState(importing ? "import" : "edit");
  const [json, setJson] = useState("");
  const [error, setError] = useState("");
  const [importNote, setImportNote] = useState(false);
  const [checking, setChecking] = useState(false);
  const [inspection, setInspection] = useState<McpInspection | null>(null);
  const cancelled = useRef(false);
  const value: McpServer = { ...draft, args: draft.args.map((row) => row.value) };
  const valid = validMcpConfig(value);
  function patch(value: Partial<Draft>) {
    setDraft({ ...draft, ...value, checked: false });
    setInspection(null);
  }
  function parse() {
    try {
      const parsed = parseMcpConfig(json);
      setDraft({
        ...draft,
        ...parsed,
        args: parsed.args.map((value) => ({ id: crypto.randomUUID(), value })),
        checked: false,
      });
      setJson("");
      setImportNote(true);
      setStage("edit");
      setError("");
    } catch (cause) {
      setError(
        cause instanceof SyntaxError
          ? "JSON 格式错误，请检查引号与逗号。"
          : cause instanceof Error
            ? cause.message
            : "无法解析配置。",
      );
    }
  }
  return (
    <Dialog
      title={server ? "配置 MCP 服务" : importing ? "导入 MCP 配置" : "添加 MCP 服务"}
      onClose={() => {
        if (checking) {
          cancelled.current = true;
          void onCancel(draft.id)
            .then(onClose)
            .catch(() => setError("无法停止连接检查。"));
        } else onClose();
      }}
      protectChanges
    >
      <Notice>保存不会启动服务。连接检查会发现真实工具；环境变量和 Header 配置暂未接入。</Notice>
      {stage === "import" ? (
        <>
          <Field label="mcpServers JSON">
            <textarea
              className="code-input"
              value={json}
              placeholder={importExample}
              onChange={(event) => setJson(event.target.value)}
            />
          </Field>
          <button type="button" className="text-button" onClick={() => setJson(importExample)}>
            填入示例
          </button>
          <div className="dialog-actions">
            <button type="button" className="primary" onClick={parse}>
              验证并预览
            </button>
          </div>
        </>
      ) : (
        <>
          {importNote && (
            <p className="small muted">
              解析完成，请确认后保存。env / headers 的内容不导入；保存不会启动服务。
            </p>
          )}
          <fieldset disabled={checking}>
            <Field label="服务名称">
              <input
                value={draft.name}
                maxLength={100}
                placeholder="e.g. inspection-tools"
                onChange={(event) => patch({ name: event.target.value })}
              />
            </Field>
            <Field label="连接方式">
              <Select
                value={draft.transport}
                onValueChange={(transport) => patch({ transport, target: "", args: [] })}
                options={[
                  { value: "stdio", label: "本地命令 · stdio" },
                  { value: "http", label: "Streamable HTTP" },
                ]}
              />
            </Field>
            {draft.transport === "stdio" ? (
              <>
                <Field label="启动命令">
                  <input
                    placeholder="例如：node 或 python"
                    value={draft.target}
                    onChange={(event) => patch({ target: event.target.value })}
                  />
                </Field>
                <Field label="启动参数" hint="每项是一个独立参数，不经过 shell 拼接。">
                  <div>
                    {draft.args.map((row, index) => (
                      <div className="mcp-argument" key={row.id}>
                        <textarea
                          rows={1}
                          aria-label={`启动参数 ${index + 1}`}
                          value={row.value}
                          onChange={(event) =>
                            patch({
                              args: draft.args.map((item) =>
                                item.id === row.id ? { ...item, value: event.target.value } : item,
                              ),
                            })
                          }
                        />
                        <IconButton
                          icon="close"
                          label={`移除参数 ${index + 1}`}
                          onClick={() =>
                            patch({ args: draft.args.filter((item) => item.id !== row.id) })
                          }
                        />
                      </div>
                    ))}
                    <button
                      type="button"
                      className="text-button"
                      disabled={draft.args.length >= 100}
                      onClick={() =>
                        patch({ args: [...draft.args, { id: crypto.randomUUID(), value: "" }] })
                      }
                    >
                      添加参数
                    </button>
                  </div>
                </Field>
              </>
            ) : (
              <Field label="服务 URL">
                <input
                  value={draft.target}
                  placeholder="http://localhost:3000/mcp"
                  onChange={(event) => patch({ target: event.target.value })}
                />
              </Field>
            )}
            <ScopeFields
              scope={draft.scope}
              modes={draft.modes}
              project={project}
              onScope={(scope) => patch({ scope })}
              onModes={(modes) => patch({ modes })}
            />
            <Field label="调用超时 (秒)">
              <input
                type="number"
                min="1"
                max="300"
                value={draft.timeout}
                onChange={(event) => patch({ timeout: Number(event.target.value) })}
              />
            </Field>
          </fieldset>
          {checking ? (
            <button
              type="button"
              onClick={() => {
                cancelled.current = true;
                void onCancel(draft.id).catch(() => setError("无法停止连接检查。"));
              }}
            >
              停止检查
            </button>
          ) : (
            <button
              type="button"
              onClick={() => {
                const projectId =
                  draft.scope.kind === "project" ? draft.scope.projectId : project?.id;
                if (!valid || !projectId) {
                  setError(project ? "请填写有效配置。" : "请先打开项目，再检查此服务。");
                  return;
                }
                cancelled.current = false;
                setError("");
                setInspection(null);
                setChecking(true);
                void onInspect(value, projectId)
                  .then((result) => {
                    if (!cancelled.current) {
                      setInspection(result);
                      setDraft((previous) => ({ ...previous, checked: true }));
                    }
                  })
                  .catch((cause: unknown) => {
                    if (!cancelled.current)
                      setError(cause instanceof Error ? cause.message : "MCP 连接检查失败。");
                  })
                  .finally(() => setChecking(false));
              }}
            >
              连接并查看工具
            </button>
          )}
          {checking && <p role="status">正在连接 MCP 服务…</p>}
          {inspection && <McpToolCatalog tools={inspection.tools} />}
          <div className="dialog-actions">
            <button
              type="button"
              className="primary"
              disabled={checking}
              onClick={() => {
                if (!valid) setError("请填写名称、有效连接、至少一个模式和正整数超时。");
                else onSave(value);
              }}
            >
              保存配置{!draft.checked ? "（未验证）" : ""}
            </button>
          </div>
        </>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}
