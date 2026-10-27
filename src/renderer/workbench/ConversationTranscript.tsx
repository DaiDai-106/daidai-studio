import { useEffect, useRef, useState } from "react";
import type { ConversationView, MessageBlock, MessageInfo } from "../../shared/application.ts";
import { BrandIcon } from "../components/BrandIcon.tsx";
import { Icon } from "../components/Icon.tsx";
import { MarkdownText } from "../components/MarkdownText.tsx";
import { ToolCall } from "./ToolMessages.tsx";
import {
  type ConversationTurn,
  conversationTurns,
  durationLabel,
  finalReply,
  processItems,
} from "./transcript.ts";
import { ResponseUsage } from "./UsageDetails.tsx";

function Thinking({ block, onInteract }: { block: MessageBlock; onInteract(): void }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="thinking-message">
      <button
        type="button"
        className="process-row"
        aria-expanded={open}
        onClick={() => {
          onInteract();
          setOpen(!open);
        }}
      >
        <Icon name="model" size={14} />
        <span>思考摘要</span>
        <Icon name="chevron" size={12} />
      </button>
      <div className="thinking-body" hidden={!open}>
        <MarkdownText text={block.text} />
        {block.truncated && <p className="preview-note">思考文字预览已截断。</p>}
      </div>
    </section>
  );
}
function Reply({ message }: { message: MessageInfo }) {
  return (
    <article className="message assistant">
      <div className="message-author">
        <BrandIcon size={22} />
        Dai <span title={message.response?.provider}>{message.response?.model ?? ""}</span>
      </div>
      <MarkdownText text={message.text || (message.failed ? "请求未完成。" : "")} />
      {message.response && <ResponseUsage response={message.response} />}
    </article>
  );
}
const phaseLabels = {
  waiting: "等待模型",
  responding: "正在回复",
  thinking: "正在思考",
  tools: "正在执行",
  retrying: "正在重试",
  compacting: "正在压缩上下文",
};
function Turn({
  turn,
  stream,
  showThinking,
  model,
}: {
  turn: ConversationTurn;
  stream: ConversationView | null;
  showThinking: boolean;
  model?: string | undefined;
}) {
  const active = !!stream?.busy;
  const [choice, setChoice] = useState<boolean | null>(null);
  const [now, setNow] = useState(Date.now);
  const open = choice ?? active;
  const body = useRef<HTMLDivElement>(null);
  const final = finalReply(turn);
  const items = processItems(turn, stream);
  const tools = items.filter((item) => item.kind === "tool");
  const running = tools.filter(
    (item) => item.tool.status === "running" || item.tool.status === "pending",
  );
  const failures = tools.filter((item) => item.tool.status === "failed").length;
  const count = tools.length;
  const hasProcess = active || items.some((item) => item.kind !== "thinking" || showThinking);
  const outcome = final?.outcome ?? turn.messages.at(-1)?.outcome;
  const label = active
    ? phaseLabels[stream?.activity ?? "waiting"]
    : outcome === "stopped"
      ? "已停止"
      : outcome === "failed" || stream?.error
        ? "执行未完成"
        : "处理完成";
  const started = turn.user?.timestamp;
  const last = turn.messages.at(-1);
  const ended =
    last?.timestamp === undefined
      ? undefined
      : last.timestamp + (last.role === "assistant" ? (last.durationMs ?? 0) : 0);
  const elapsed =
    started !== undefined && (active || ended !== undefined)
      ? durationLabel(Math.max(0, (active ? now : (ended ?? started)) - started))
      : "";
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  useEffect(() => {
    if (active || choice !== null) return;
    const selection = window.getSelection();
    if (
      body.current?.contains(document.activeElement) ||
      (selection?.anchorNode &&
        !selection.isCollapsed &&
        body.current?.contains(selection.anchorNode))
    )
      setChoice(true);
  }, [active, choice]);
  const claim = () => setChoice(true);
  return (
    <div className="conversation-turn" data-turn-id={turn.id}>
      {turn.user && (
        <article className="message user">
          <div className="message-text">{turn.user.text}</div>
          {!!turn.user.images?.length && (
            <div className="message-images">
              {turn.user.images.map((image, index) => (
                <img
                  key={image.data}
                  src={`data:${image.mimeType};base64,${image.data}`}
                  alt={`图片 ${index + 1}`}
                />
              ))}
            </div>
          )}
        </article>
      )}
      {hasProcess && (
        <section className={`turn-process ${active ? "active" : ""}`}>
          <button
            type="button"
            className="process-header"
            aria-expanded={open}
            onClick={() => setChoice(!open)}
          >
            <Icon name="chevron" size={13} />
            <span>{label}</span>
            {count > 0 && <span className="process-count">{count} 次工具调用</span>}
            {failures > 0 && <span className="process-issues">{failures} 次失败</span>}
            {elapsed && <small>{elapsed}</small>}
          </button>
          <div
            className="process-body"
            ref={body}
            hidden={!open}
            onPointerDown={claim}
            onFocusCapture={claim}
          >
            {items.map((item) =>
              item.kind === "tool" ? (
                <ToolCall key={item.key} tool={item.tool} onInteract={claim} />
              ) : item.kind === "thinking" ? (
                showThinking && <Thinking key={item.key} block={item.block} onInteract={claim} />
              ) : (
                <div key={item.key} className="process-note">
                  <MarkdownText text={item.text} />
                </div>
              ),
            )}
            {active && running.length === 0 && (
              <p className="process-live" role="status">
                {label}…
              </p>
            )}
          </div>
        </section>
      )}
      {final && (final.text || final.failed) && <Reply message={final} />}
      {active && stream?.partial && !stream.partialHasToolCalls && (
        <article className="message assistant">
          <div className="message-author">
            <BrandIcon size={22} />
            Dai <span>{stream.respondingModel ?? model ?? "正在回复"}</span>
          </div>
          <MarkdownText text={stream.partial} />
        </article>
      )}
    </div>
  );
}
export function ConversationTranscript({
  messages,
  stream,
  showThinking,
  model,
}: {
  messages: MessageInfo[];
  stream: ConversationView | null;
  showThinking: boolean;
  model?: string | undefined;
}) {
  const turns = conversationTurns(messages);
  if (!turns.length && stream?.busy) turns.push({ id: "pending", messages: [] });
  return (
    <>
      {turns.map((turn, index) => (
        <Turn
          key={turn.id}
          turn={turn}
          stream={index === turns.length - 1 ? stream : null}
          showThinking={showThinking}
          model={model}
        />
      ))}
    </>
  );
}
