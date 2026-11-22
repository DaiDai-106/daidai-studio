import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  ConversationView,
  MessageBlock,
  MessageInfo,
} from "../../../../contracts/application.ts";
import { productName } from "../../../../shared/app_metadata.ts";
import { BrandIcon } from "../../../shared/components/brand_icon.tsx";
import { Dialog } from "../../../shared/components/dialog.tsx";
import { Icon } from "../../../shared/components/icon.tsx";
import { MarkdownText } from "../../../shared/components/markdown_text.tsx";
import {
  type ConversationTurn,
  conversationTurns,
  durationLabel,
  finalReply,
  processItems,
} from "../logic/transcript.ts";
import { StepAttachmentTag } from "./step_attachment_tag.tsx";
import { ToolCall } from "./tool_messages.tsx";
import { ResponseUsage } from "./usage_details.tsx";
import { UserMessage } from "./user_message.tsx";

// 折叠思考摘要和工具过程，原始消息仍由会话状态提供。
function Thinking({
  block,
  open,
  onToggle,
}: {
  block: MessageBlock;
  open: boolean;
  onToggle(): void;
}) {
  return (
    <section className="thinking-message">
      <button type="button" className="process-row" aria-expanded={open} onClick={onToggle}>
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

function MessageImages({
  images,
  onOpen,
}: {
  images: NonNullable<MessageInfo["images"]>;
  onOpen(): void;
}) {
  const [preview, setPreview] = useState<{ src: string; alt: string } | null>(null);
  const opener = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (preview) return;
    opener.current?.focus({ preventScroll: true });
    opener.current = null;
  }, [preview]);
  return (
    <>
      <div className="message-images">
        {images.map((image, index) => {
          const src = `data:${image.mimeType};base64,${image.data}`;
          const alt = `图片 ${index + 1}`;
          return (
            <button
              key={alt}
              type="button"
              className="message-image"
              aria-label={`放大${alt}`}
              aria-haspopup="dialog"
              onClick={(event) => {
                onOpen();
                opener.current = event.currentTarget;
                setPreview({ src, alt });
              }}
            >
              <img src={src} alt={alt} />
            </button>
          );
        })}
      </div>
      {preview && (
        <Dialog
          title="图片预览"
          closeLabel="关闭图片预览"
          className="message-image-dialog"
          onClose={() => setPreview(null)}
        >
          <img className="message-image-preview" src={preview.src} alt={preview.alt} />
        </Dialog>
      )}
    </>
  );
}

function Reply({ message }: { message: MessageInfo }) {
  return (
    <article className="message assistant">
      <div className="message-author">
        <BrandIcon size={22} />
        {productName}{" "}
        <span title={message.response?.provider}>{message.response?.model ?? ""}</span>
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

const Turn = memo(function Turn({
  turn,
  stream,
  showThinking,
  model,
  onImagePreviewOpen,
}: {
  turn: ConversationTurn;
  stream: ConversationView | null;
  showThinking: boolean;
  model?: string | undefined;
  onImagePreviewOpen(): void;
}) {
  const active = !!stream?.busy;
  const [choice, setChoice] = useState<boolean | null>(null);
  const [thinkingOpen, setThinkingOpen] = useState<Record<string, boolean>>({});
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
    <div
      className="conversation-turn"
      data-turn-id={turn.id}
      data-user-turn={turn.user ? "" : undefined}
    >
      {turn.event && (
        <details className="history-event">
          <summary>{turn.event.eventLabel ?? "会话记录"}</summary>
          <MarkdownText text={turn.event.text} />
          {turn.event.images?.length ? (
            <MessageImages images={turn.event.images} onOpen={onImagePreviewOpen} />
          ) : null}
        </details>
      )}
      {turn.user && (
        <article className="message user">
          {turn.user.text && <UserMessage text={turn.user.text} />}
          {turn.user.stepAttachment && <StepAttachmentTag name={turn.user.stepAttachment.name} />}
          {turn.user.images?.length ? (
            <MessageImages images={turn.user.images} onOpen={onImagePreviewOpen} />
          ) : null}
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
                showThinking && (
                  <Thinking
                    key={item.key}
                    block={item.block}
                    open={thinkingOpen[item.key] ?? false}
                    onToggle={() => {
                      claim();
                      setThinkingOpen((previous) => ({
                        ...previous,
                        [item.key]: !previous[item.key],
                      }));
                    }}
                  />
                )
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
            {productName} <span>{stream.respondingModel ?? model ?? "正在回复"}</span>
          </div>
          <MarkdownText text={stream.partial} />
        </article>
      )}
    </div>
  );
});

const pendingTurn: ConversationTurn = { id: "pending", messages: [] };

export function ConversationTranscript({
  messages,
  stream,
  showThinking,
  model,
  onImagePreviewOpen,
}: {
  messages: MessageInfo[];
  stream: ConversationView | null;
  showThinking: boolean;
  model?: string | undefined;
  onImagePreviewOpen(): void;
}) {
  const history = useMemo(() => conversationTurns(messages), [messages]);
  const turns = !history.length && stream?.busy ? [pendingTurn] : history;
  return (
    <>
      {turns.map((turn, index) => (
        <Turn
          key={turn.id}
          turn={turn}
          stream={index === turns.length - 1 ? stream : null}
          showThinking={showThinking}
          model={model}
          onImagePreviewOpen={onImagePreviewOpen}
        />
      ))}
    </>
  );
}
