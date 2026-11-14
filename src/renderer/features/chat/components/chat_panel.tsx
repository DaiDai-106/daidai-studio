import { type RefObject, useEffect, useRef, useState } from "react";
import type {
  AccessMode,
  ChatImage,
  ConversationView,
  ModelChoice as Model,
  ShellApproval,
  ThinkingLevel,
} from "../../../../contracts/application.ts";
import {
  formatFileReference,
  referenceDraft,
  splitReferenceDraft,
} from "../../../../shared/file_references.ts";
import { ActionMenu } from "../../../shared/components/action_menu.tsx";
import { Icon, IconButton } from "../../../shared/components/icon.tsx";
import { Select } from "../../../shared/components/select.tsx";
import {
  FileReferencePicker,
  type FileReferencePickerHandle,
} from "../../coding/components/file_reference_picker.tsx";
import { FileReferenceTags } from "../../coding/components/file_reference_tags.tsx";
import { fileMention } from "../../coding/logic/file_mention.ts";
import type { Conversation } from "../logic/types.ts";
import { useImageDrafts } from "../logic/use_image_drafts.ts";
import { ConversationTrace } from "./conversation_trace.tsx";
import { ConversationTranscript } from "./conversation_transcript.tsx";
import { ConversationUsage } from "./usage_details.tsx";

interface Props {
  inputRef: RefObject<HTMLTextAreaElement | null>;
  conversation: Conversation;
  models: Model[];
  compact: boolean;
  codingProjectId?: string;
  onDraft: (value: string) => void;
  onModel: (id: string) => void;
  onThinking: (level: ThinkingLevel) => void;
  onAccessMode: (mode: AccessMode) => void;
  accessPending: boolean;
  onSend: (images: ChatImage[]) => Promise<boolean>;
  onConfigure: () => void;
  stream: ConversationView | null;
  shellApproval: ShellApproval | null;
  onShellApproval: (id: string, approved: boolean) => void;
  showThinking?: boolean;
  onStop: () => void;
}

export function ChatPanel(props: Props) {
  const [view, setView] = useState<"chat" | "trace">("chat");
  const [mention, setMention] = useState<ReturnType<typeof fileMention>>(null);
  const referenceOpen = mention !== null;
  const [activeOption, setActiveOption] = useState<string | undefined>(undefined);
  const referencePicker = useRef<FileReferencePickerHandle>(null);
  const draftParts = props.codingProjectId
    ? splitReferenceDraft(props.conversation.draft, true)
    : { text: props.conversation.draft, references: [] };
  const end = useRef<HTMLDivElement>(null);
  const messages = useRef<HTMLDivElement>(null);
  const column = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const picker = useRef<HTMLInputElement>(null);
  const activeModel = props.models.find((model) => model.id === props.conversation.modelId);
  const { images, imageError, addImages, removeImage, send } = useImageDrafts(
    props.conversation.id,
    activeModel?.supportsImages ?? false,
    props.onSend,
  );
  const thinkingLevels = activeModel?.thinkingLevels ?? ["off" as const];
  const thinkingLevel = thinkingLevels.includes(props.conversation.thinkingLevel ?? "off")
    ? (props.conversation.thinkingLevel ?? "off")
    : (thinkingLevels[0] ?? "off");
  const hasMessages = props.conversation.messages.length > 0;
  const approval =
    props.shellApproval?.conversationId === props.conversation.id ? props.shellApproval : null;
  const hasApproval = !!approval;
  useEffect(() => {
    if (!props.conversation.id) return;
    setMention(null);
    following.current = true;
    end.current?.scrollIntoView({ block: "end" });
  }, [props.conversation.id]);
  useEffect(() => {
    if ((!hasMessages && !props.stream?.busy && !hasApproval) || !column.current) return;
    // 用户停留在底部时才跟随流式内容，避免打断阅读。
    const observer = new ResizeObserver(() => {
      const selection = window.getSelection();
      if (
        !following.current ||
        document.activeElement?.closest(".turn-process, .trace-record") ||
        (selection && !selection.isCollapsed)
      )
        return;
      end.current?.scrollIntoView({ block: "end" });
    });
    observer.observe(column.current);
    return () => observer.disconnect();
  }, [hasMessages, props.stream?.busy, hasApproval]);
  return (
    <section className={`chat-panel ${props.compact ? "compact" : ""}`} aria-label="聊天">
      <div className="conversation-view-tabs" role="tablist" aria-label="对话视图">
        {(
          [
            ["chat", "聊天"],
            ["trace", "轨迹"],
          ] as const
        ).map(([id, label]) => (
          <button
            type="button"
            role="tab"
            key={id}
            aria-selected={view === id}
            onClick={() => setView(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <div
        className="messages"
        ref={messages}
        aria-live="polite"
        onScroll={() => {
          const area = messages.current;
          if (area) following.current = area.scrollHeight - area.clientHeight - area.scrollTop < 80;
        }}
      >
        {props.conversation.interrupted && (
          <p className="notice" role="status">
            上次请求被中断。已保留聊天记录，请确认后重新发送。
          </p>
        )}
        {view === "trace" || hasMessages || props.stream?.busy || approval ? (
          <div className={`message-column${view === "trace" ? " trace-column" : ""}`} ref={column}>
            {view === "trace" ? (
              <ConversationTrace
                key={props.conversation.id}
                conversationId={props.conversation.id}
                stream={props.stream}
              />
            ) : (
              <ConversationTranscript
                messages={props.conversation.messages}
                stream={props.stream}
                showThinking={props.showThinking ?? true}
                model={activeModel?.name}
              />
            )}
            {approval && (
              <section className="shell-approval" aria-label="确认执行命令">
                <strong>确认执行命令</strong>
                <p>命令以当前用户权限执行，可能读取或修改本机文件。请检查完整命令后决定。</p>
                <p className="shell-approval-location">
                  {approval.shell} · {approval.cwd}
                </p>
                <pre>{approval.command}</pre>
                <div className="shell-approval-actions">
                  <button type="button" onClick={() => props.onShellApproval(approval.id, false)}>
                    拒绝
                  </button>
                  <button
                    type="button"
                    className="primary"
                    onClick={() => props.onShellApproval(approval.id, true)}
                  >
                    确认执行
                  </button>
                </div>
              </section>
            )}
            {props.stream?.error &&
              props.stream.error !== props.conversation.messages.at(-1)?.text && (
                <p className="error" role="alert">
                  {props.stream.error}
                </p>
              )}
            <div ref={end} />
          </div>
        ) : (
          <div className="welcome">
            <div className="welcome-symbol">
              <Icon name="file" size={30} />
            </div>
            <h1>从代码任务开始</h1>
            <p>
              {activeModel
                ? "描述需要分析、编写或修改的代码。"
                : "配置并选择模型后，开始讨论代码任务。"}
            </p>
          </div>
        )}
      </div>
      <div className="composer-wrap">
        {referenceOpen && props.codingProjectId && (
          <FileReferencePicker
            ref={referencePicker}
            onActiveOption={setActiveOption}
            projectId={props.codingProjectId}
            query={mention?.query ?? ""}
            onClose={() => {
              setMention(null);
              props.inputRef.current?.focus();
            }}
            onSelect={(reference) => {
              if (!mention) return;
              const draft =
                draftParts.text.slice(0, mention.start) + draftParts.text.slice(mention.end);
              const references = [
                ...new Map(
                  [...draftParts.references, reference].map((item) => [
                    formatFileReference(item),
                    item,
                  ]),
                ).values(),
              ];
              props.onDraft(referenceDraft(draft, references));
              setMention(null);
              requestAnimationFrame(() => {
                props.inputRef.current?.focus();
                props.inputRef.current?.setSelectionRange(mention.start, mention.start);
              });
            }}
          />
        )}

        <fieldset
          className="composer"
          aria-label="消息输入区"
          onDragOver={(event) => {
            if (event.dataTransfer.types.includes("Files")) event.preventDefault();
          }}
          onDrop={(event) => {
            const files = Array.from(event.dataTransfer.files);
            if (files.length) {
              event.preventDefault();
              void addImages(files);
            }
          }}
        >
          {!!images.length && (
            <div className="composer-images">
              {images.map((image, index) => (
                <div className="composer-image" key={image.data}>
                  <img
                    src={`data:${image.mimeType};base64,${image.data}`}
                    alt={`待发送图片 ${index + 1}`}
                  />
                  <button
                    type="button"
                    aria-label={`移除图片 ${index + 1}`}
                    onClick={() => removeImage(index)}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          {imageError && (
            <p className="error" role="alert">
              {imageError}
            </p>
          )}
          {props.codingProjectId && draftParts.references.length > 0 && (
            <FileReferenceTags
              references={draftParts.references}
              onRemove={(index) =>
                props.onDraft(
                  referenceDraft(
                    draftParts.text,
                    draftParts.references.filter((_, position) => position !== index),
                  ),
                )
              }
            />
          )}
          <textarea
            ref={props.inputRef}
            aria-label="消息内容"
            placeholder="描述你的代码任务…"
            aria-controls={referenceOpen ? "file-reference-options" : undefined}
            aria-activedescendant={referenceOpen ? activeOption : undefined}
            aria-autocomplete={props.codingProjectId ? "list" : undefined}
            value={draftParts.text}
            onChange={(event) => {
              props.onDraft(referenceDraft(event.target.value, draftParts.references));
              setMention(
                props.codingProjectId && draftParts.references.length < 5
                  ? fileMention(event.target.value, event.target.selectionStart)
                  : null,
              );
            }}
            onPaste={(event) => {
              const files = Array.from(event.clipboardData.files);
              if (files.length) {
                event.preventDefault();
                void addImages(files);
              }
            }}
            onBlur={(event) => {
              if (!event.relatedTarget?.closest(".file-reference-picker")) setMention(null);
            }}
            onClick={(event) => {
              if (referenceOpen)
                setMention(
                  fileMention(event.currentTarget.value, event.currentTarget.selectionStart),
                );
            }}
            onKeyUp={(event) => {
              if (referenceOpen && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
                setMention(
                  fileMention(event.currentTarget.value, event.currentTarget.selectionStart),
                );
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (
                referenceOpen &&
                !event.shiftKey &&
                referencePicker.current?.handleKey(event.key)
              ) {
                event.preventDefault();
                return;
              }
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing &&
                !props.stream?.busy
              ) {
                event.preventDefault();
                void send();
              }
            }}
          />
          <div className="composer-toolbar">
            <input
              ref={picker}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              multiple
              hidden
              onChange={(event) => {
                void addImages(Array.from(event.target.files ?? []));
                event.target.value = "";
              }}
            />
            {props.codingProjectId && (
              <IconButton
                icon="file"
                label="引用项目文件"
                disabled={draftParts.references.length >= 5}
                onClick={() => {
                  const input = props.inputRef.current;
                  const caret = input?.selectionStart ?? draftParts.text.length;
                  setMention(
                    fileMention(draftParts.text, caret) ?? { start: caret, end: caret, query: "" },
                  );
                  input?.focus();
                }}
              />
            )}
            <IconButton icon="image" label="添加图片" onClick={() => picker.current?.click()} />
            <span className="composer-picker mode-button" title="项目模式">
              <Icon name="chat" size={16} />
              <span>Coding</span>
            </span>
            <div className="composer-spacer" />
            <div className="thinking-picker access-picker">
              <Select
                aria-label="访问权限"
                value={props.conversation.accessMode ?? "ask"}
                disabled={!!props.stream?.busy || props.accessPending}
                options={[
                  { value: "ask", label: "请求批准" },
                  { value: "full", label: "完全访问" },
                ]}
                onValueChange={props.onAccessMode}
              />
            </div>
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
            <div className="thinking-picker">
              <Select
                aria-label="推理档位"
                value={thinkingLevel}
                disabled={!!props.stream?.busy || thinkingLevels.length <= 1}
                options={thinkingLevels.map((value) => ({
                  value,
                  label: value,
                }))}
                onValueChange={props.onThinking}
              />
            </div>
            <button
              type="button"
              className="send-button"
              aria-label={props.stream?.busy ? "停止回复" : "发送消息"}
              disabled={
                !props.stream?.busy &&
                (props.accessPending || (!props.conversation.draft.trim() && !images.length))
              }
              onClick={props.stream?.busy ? props.onStop : () => void send()}
            >
              <Icon name={props.stream?.busy ? "stop" : "arrow"} size={20} />
            </button>
          </div>
        </fieldset>
        {props.stream && <ConversationUsage key={props.conversation.id} view={props.stream} />}
      </div>
    </section>
  );
}
