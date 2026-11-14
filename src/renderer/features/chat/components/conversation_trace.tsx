import { useEffect, useState } from "react";
import type {
  ConversationView,
  TraceDetail,
  TraceRecord,
} from "../../../../contracts/application.ts";
import { errorMessage } from "../../../shared/logic/error_message.ts";
import { ToolDetails } from "./tool_messages.tsx";
import "../styles/trace.css";

const labels = { system: "系统", user: "用户", assistant: "助手", tool: "工具", event: "事件" };

function ModelInput({ context }: { context: NonNullable<TraceDetail["context"]> }) {
  return (
    <details className="trace-context">
      <summary>本次模型输入 · 系统提示、插件注入与工具定义</summary>
      {!context.recorded ? (
        <p className="trace-note">这段历史没有记录系统提示或工具定义。</p>
      ) : (
        <>
          <details>
            <summary>完整系统提示</summary>
            <pre>{context.content || "未记录系统提示正文。"}</pre>
          </details>
          <section aria-label="系统分段与插件注入">
            <h4>系统分段与插件注入 · {context.sections.length}</h4>
            {context.sections.map((section) => (
              <details key={section.name}>
                <summary>{section.name}</summary>
                <pre>{section.text}</pre>
              </details>
            ))}
          </section>
          <section aria-label="本次可用工具定义">
            <h4>本次可用工具定义 · {context.tools.length}</h4>
            {context.tools.map((tool) => (
              <details key={tool.name}>
                <summary>{tool.name}</summary>
                <p>{tool.description}</p>
                <pre>{tool.parameters}</pre>
                {tool.truncated && <p className="trace-note">定义预览已截断。</p>}
              </details>
            ))}
          </section>
        </>
      )}
      {context.injections.length > 0 && (
        <section aria-label="插件消息与上下文注入">
          <h4>插件消息与上下文注入 · {context.injections.length}</h4>
          {context.injections.map((item) => (
            <details key={item.id}>
              <summary>{item.name}</summary>
              <pre>{item.text}</pre>
            </details>
          ))}
        </section>
      )}
    </details>
  );
}

function Record({
  record,
  conversationId,
  revision,
}: {
  record: TraceRecord;
  conversationId: string;
  revision: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<TraceDetail | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 当前轮历史变化及手动重试需要重新读取同一条详情。
  useEffect(() => {
    if (!open) return;
    let active = true;
    setError("");
    // 用户输入后的系统段可能继续更新；只重取当前轮，已完成的历史详情保持稳定。
    void window.desktop.application.getTraceDetail(conversationId, record.id).then(
      (value) => {
        if (active) setDetail(value);
      },
      (cause) => {
        if (active) setError(errorMessage(cause, "读取轨迹详情失败。"));
      },
    );
    return () => {
      active = false;
    };
  }, [open, conversationId, record.id, revision, attempt]);
  return (
    <details
      className={`trace-record role-${record.role}${record.failed ? " failed" : ""}`}
      data-entry-id={record.id}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span className="trace-kind">{labels[record.role]}</span>
        <span className="trace-label">
          {record.turn ? `第 ${record.turn} 轮 · ` : "初始化 · "}
          {record.label}
        </span>
        <span className="trace-preview">{record.preview || "无文本内容"}</span>
        {record.failed && <span className="trace-failure">失败 / 中断</span>}
        <time dateTime={new Date(record.timestamp).toISOString()}>
          {new Date(record.timestamp).toLocaleTimeString()}
        </time>
      </summary>
      {open && (
        <div className="trace-detail">
          {error && (
            <p className="error" role="alert">
              {error}{" "}
              <button type="button" onClick={() => setAttempt((v) => v + 1)}>
                重试
              </button>
            </p>
          )}
          {!detail && !error && <p role="status">正在读取详情…</p>}
          {detail && (
            <>
              {detail.tool ? (
                <ToolDetails
                  tool={{
                    ...detail.tool,
                    key: record.id,
                    status: record.failed ? "failed" : "completed",
                    output: detail.text,
                    outputTruncated: detail.truncated,
                  }}
                />
              ) : detail.text ? (
                <pre className="trace-content">{detail.text}</pre>
              ) : null}
              {detail.calls.map((call) => (
                <section className="trace-call" key={call.callId} aria-label={`调用 ${call.name}`}>
                  <h4>调用 {call.name}</h4>
                  <pre>{JSON.stringify(call.args ?? {}, null, 2)}</pre>
                  {call.argsTruncated && <p className="trace-note">参数预览已截断。</p>}
                </section>
              ))}
              {detail.context && <ModelInput context={detail.context} />}
              {detail.truncated && <p className="trace-note">详情达到展示上限，部分内容已截断。</p>}
            </>
          )}
        </div>
      )}
    </details>
  );
}

export function ConversationTrace({
  conversationId,
  stream: incoming,
}: {
  conversationId: string;
  stream: ConversationView | null;
}) {
  const stream = incoming?.conversationId === conversationId ? incoming : null;
  const [records, setRecords] = useState<TraceRecord[] | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [start, setStart] = useState<number | null>(null);
  const historyKey = stream?.historyKey;
  // biome-ignore lint/correctness/useExhaustiveDependencies: 叶节点变化或重试会使同一会话的轨迹快照失效。
  useEffect(() => {
    let active = true;
    setError("");
    void window.desktop.application.getConversationTrace(conversationId).then(
      (value) => {
        if (active) {
          setRecords(value);
          setStart((previous) => previous ?? Math.max(0, value.length - 100));
        }
      },
      (cause) => {
        if (active) setError(errorMessage(cause, "读取轨迹失败。"));
      },
    );
    return () => {
      active = false;
    };
  }, [conversationId, historyKey, attempt]);
  const turn = records?.at(-1)?.turn;
  const offset = Math.min(start ?? 0, Math.max(0, (records?.length ?? 0) - 100));
  return (
    <section className="conversation-trace" aria-label="对话轨迹">
      <p className="trace-note">
        按历史顺序查看记录，展开用户或助手记录可检查 Pi 已保存的本轮模型输入。
      </p>
      {error && (
        <p className="error" role="alert">
          {error}{" "}
          <button type="button" onClick={() => setAttempt((v) => v + 1)}>
            重试
          </button>
        </p>
      )}
      {!records && !error && <p role="status">正在读取轨迹…</p>}
      {records?.length === 0 && <p>还没有轨迹记录，发送消息后会在这里显示。</p>}
      {records && offset > 0 && (
        <button type="button" onClick={() => setStart(Math.max(0, offset - 100))}>
          显示更早的轨迹
        </button>
      )}
      {records?.slice(offset).map((record) => (
        <Record
          key={record.id}
          record={record}
          conversationId={conversationId}
          revision={record.turn === turn ? historyKey : undefined}
        />
      ))}
      {stream?.busy && (
        <div className="trace-live" role="status">
          {stream.activeTools.map((tool) => (
            <p key={tool.id}>
              <span className="trace-kind">工具</span> {tool.name} · {tool.phase}
            </p>
          ))}
          <p>
            <span className="trace-kind">助手</span> {stream.partial || "正在处理…"}
          </p>
        </div>
      )}
      {stream?.error && (
        <p className="error" role="alert">
          {stream.error}
        </p>
      )}
    </section>
  );
}
