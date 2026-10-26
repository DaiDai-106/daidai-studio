import { type RefObject, useEffect, useRef } from "react";
import type { ConversationView } from "../../shared/application.ts";
import { ActionMenu } from "../components/ActionMenu.tsx";
import { BrandIcon } from "../components/BrandIcon.tsx";
import { Icon, IconButton } from "../components/Icon.tsx";
import type { Conversation, Mode, Model } from "../types.ts";
import { modeLabel, modes } from "./modes.ts";
import { ActiveTools, ToolResult } from "./ToolMessages.tsx";
import { ConversationUsage, ResponseUsage } from "./UsageDetails.tsx";
import { Welcome } from "./Welcome.tsx";

interface Props {
  inputRef: RefObject<HTMLTextAreaElement | null>;
  conversation: Conversation;
  models: Model[];
  compact: boolean;
  onDraft: (value: string) => void;
  onMode: (mode: Mode) => void;
  onModel: (id: string) => void;
  onSend: () => void;
  onFiles: () => void;
  step: string;
  onClearStep: () => void;
  onConfigure: () => void;
  stream: ConversationView | null;
  onStop: () => void;
}

export function ChatPanel(props: Props) {
  const end = useRef<HTMLDivElement>(null);

  const activeModel = props.models.find((model) => model.id === props.conversation.modelId);
  const activeMode = modes.find((mode) => mode.id === props.conversation.mode);
  const hasMessages = props.conversation.messages.length > 0;
  // Reading older history does not move the viewport; only new messages scroll it.
  const lastMessageId = props.conversation.messages.at(-1)?.id;
  useEffect(() => {
    if (lastMessageId) end.current?.scrollIntoView({ block: "end" });
  }, [lastMessageId]);
  return (
    <section className={`chat-panel ${props.compact ? "compact" : ""}`} aria-label="聊天">
      <div className="messages" aria-live="polite">
        {props.conversation.interrupted && (
          <p className="notice" role="status">
            上次请求被中断。已保留聊天记录，请确认后重新发送。
          </p>
        )}
        {hasMessages || props.stream?.busy ? (
          <div className="message-column">
            {props.conversation.messages.map((message) =>
              message.role === "tool" ? (
                <ToolResult
                  key={message.id}
                  message={{ ...message, failed: message.failed ?? false }}
                />
              ) : message.role === "assistant" && !message.text && !message.failed ? null : (
                <article className={`message ${message.role}`} key={message.id}>
                  {message.role === "assistant" && (
                    <div className="message-author">
                      <BrandIcon size={22} />
                      Dai{" "}
                      <span title={message.response?.provider}>
                        {message.response?.model ?? ""}
                      </span>
                    </div>
                  )}
                  <div className="message-text">
                    {message.text || (message.failed ? "请求未完成。" : "")}
                  </div>
                  {message.response && <ResponseUsage response={message.response} />}
                </article>
              ),
            )}
            {props.stream && <ActiveTools tools={props.stream.activeTools} />}
            {props.stream?.busy &&
              (props.stream.partial || props.stream.activeTools.length === 0) && (
                <article className="message assistant">
                  <div className="message-author">
                    <BrandIcon size={22} />
                    Dai{" "}
                    <span>{props.stream.respondingModel ?? activeModel?.name ?? "正在回复"}</span>
                  </div>
                  <div className="message-text">{props.stream.partial || "正在等待模型…"}</div>
                </article>
              )}
            {props.stream?.error && (
              <p className="error" role="alert">
                {props.stream.error}
              </p>
            )}
            <div ref={end} />
          </div>
        ) : props.compact ? (
          <div className="welcome">
            <div className="welcome-symbol">
              <Icon name="box" size={30} />
            </div>
            <h1>从一个场景需求开始</h1>
            <p>描述需求；有多个 STEP 时可先选择文件。</p>
          </div>
        ) : (
          <Welcome />
        )}
      </div>
      <div className="composer-wrap">
        <div className="composer">
          {(props.compact || props.step) && (
            <div className="step-binding">
              <button
                type="button"
                className="text-button"
                aria-label="当前 STEP"
                onClick={props.onFiles}
                title={props.step}
              >
                <Icon name="file" size={15} />
                <span>当前 STEP</span>
                <strong>{props.step || "未选择"}</strong>
                <Icon name="chevron-down" size={12} />
              </button>
              {props.step && (
                <IconButton icon="close" label="取消 STEP 关联" onClick={props.onClearStep} />
              )}
            </div>
          )}
          <textarea
            ref={props.inputRef}
            aria-label="消息内容"
            placeholder={props.compact ? "描述你想搭建的场景…" : "随便问问，或描述你的工作…"}
            value={props.conversation.draft}
            onChange={(event) => props.onDraft(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing &&
                !props.stream?.busy
              ) {
                event.preventDefault();
                props.onSend();
              }
            }}
          />
          <div className="composer-toolbar">
            <IconButton icon="plus" label="选择项目 STEP" onClick={props.onFiles} />
            <ActionMenu
              label="业务模式"
              side="top"
              trigger={
                <button type="button" className="composer-picker mode-button">
                  <Icon name={activeMode?.icon ?? "chat"} size={16} />
                  <span>{modeLabel(props.conversation.mode)}</span>
                  <Icon name="chevron-down" size={12} />
                </button>
              }
              actions={modes.map((mode) => ({
                label: mode.label,
                icon: mode.icon,
                description: mode.description,
                selected: mode.id === props.conversation.mode,
                onSelect: () => props.onMode(mode.id),
              }))}
            />
            <div className="composer-spacer" />
            <ActionMenu
              label="选择模型"
              side="top"
              trigger={
                <button
                  type="button"
                  className="composer-picker model-picker"
                  aria-label="选择模型"
                  title={activeModel?.name}
                >
                  <Icon name="model" size={16} />
                  <span>{activeModel?.name ?? "配置模型"}</span>
                  <Icon name="chevron-down" size={12} />
                </button>
              }
              actions={[
                ...props.models.map((model) => ({
                  id: model.id,
                  label: model.name,
                  selected: model.id === activeModel?.id,
                  onSelect: () => props.onModel(model.id),
                })),
                { label: "管理模型…", icon: "sliders", onSelect: props.onConfigure },
              ]}
            />
            <button
              type="button"
              className="send-button"
              aria-label={props.stream?.busy ? "停止回复" : "发送消息"}
              disabled={!props.stream?.busy && !props.conversation.draft.trim()}
              onClick={props.stream?.busy ? props.onStop : props.onSend}
            >
              <Icon name={props.stream?.busy ? "stop" : "arrow"} size={20} />
            </button>
          </div>
        </div>
        {props.stream && <ConversationUsage key={props.conversation.id} view={props.stream} />}
        <p className="composer-note">
          {props.compact ? "当前 STEP 由工具处理 · 聊天上下文独立" : "真实模型对话"}
        </p>
      </div>
    </section>
  );
}
