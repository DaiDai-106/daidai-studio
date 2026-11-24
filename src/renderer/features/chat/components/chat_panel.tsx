import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  AccessMode,
  ConversationInfo,
  ConversationView,
  ModelChoice as Model,
  ShellApproval,
  ThinkingLevel,
} from "../../../../contracts/application.ts";
import type { ApplicationBridge } from "../../../../contracts/bridge.ts";
import { pluginModules } from "../../../../contracts/catalog.ts";
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
import type { useAttachmentDrafts } from "../logic/use_attachment_drafts.ts";
import { type ChatPosition, useConversationHistory } from "../logic/use_conversation_history.ts";
import { ConversationNavigation, type ConversationScrollPin } from "./conversation_navigation.tsx";
import { ConversationTrace } from "./conversation_trace.tsx";
import { ConversationTranscript } from "./conversation_transcript.tsx";
import { FileAttachmentTag } from "./file_attachment_tag.tsx";
import { ConversationUsage } from "./usage_details.tsx";

interface Props {
  inputRef: RefObject<HTMLTextAreaElement | null>;
  conversation: ConversationInfo;
  isNewConversation: boolean;
  models: Model[];
  activeModel: Model | undefined;
  attachments: ReturnType<typeof useAttachmentDrafts>;
  compact: boolean;
  projectId: string;
  onDraft: (value: string) => void;
  onModel: (id: string) => void;
  onThinking: (level: ThinkingLevel) => void;
  onAccessMode: (mode: AccessMode) => void;
  accessPending: boolean;
  onCancelQueued: (messageId: string) => void;
  onPromoteQueued: (messageId: string) => void;
  onResumeQueue: () => void;
  onConfigure: () => void;
  stream: ConversationView | null;
  readHistory: ApplicationBridge["readConversationHistory"];
  shellApproval: ShellApproval | null;
  onShellApproval: (id: string, approved: boolean) => void;
  showThinking?: boolean;
  onStop: () => void;
}

const emptyMessages: ConversationView["messages"] = [];
const emptyMarkers: ConversationView["history"]["markers"] = [];
const historyScrollThreshold = 72;

function imagePreviewFocused() {
  return document.activeElement?.closest(".message-image-dialog");
}

function conversationTurn(area: HTMLElement, id: string) {
  return area.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(id)}"]`);
}

function captureChatPosition(area: HTMLElement | null, pin: ConversationScrollPin | null) {
  if (!area) return;
  const top = area.getBoundingClientRect().top;
  const pinnedTurn =
    pin?.turnId && Math.abs(area.scrollTop - pin.top) < 2
      ? conversationTurn(area, pin.turnId)
      : null;
  const turn =
    pinnedTurn ??
    Array.from(area.querySelectorAll<HTMLElement>("[data-turn-id]")).find(
      (item) => item.getBoundingClientRect().bottom > top,
    );
  const turnId = turn?.dataset.turnId;
  return turn && turnId
    ? { turnId, offset: top - turn.getBoundingClientRect().top, pinned: !!pinnedTurn }
    : undefined;
}

function restoreChatPosition(
  area: HTMLElement,
  position: ChatPosition,
): ConversationScrollPin | null {
  const turn = conversationTurn(area, position.turnId);
  if (!turn) return null;
  const bounds = turn.getBoundingClientRect();
  const offset = position.offset < bounds.height ? position.offset : 0;
  area.scrollTop += bounds.top - area.getBoundingClientRect().top + offset;
  return { top: area.scrollTop, ...(position.pinned ? { turnId: position.turnId } : {}) };
}

export function ChatPanel(props: Props) {
  const [view, setView] = useState<"chat" | "trace">("chat");
  const [mention, setMention] = useState<ReturnType<typeof fileMention>>(null);
  const coding = props.conversation.mode === "coding";
  const planning = props.conversation.mode === "planning";
  const referenceOpen = coding && mention !== null;
  const [activeOption, setActiveOption] = useState<string | undefined>(undefined);
  const referencePicker = useRef<FileReferencePickerHandle>(null);
  const draftParts = coding
    ? splitReferenceDraft(props.conversation.draft, true)
    : { text: props.conversation.draft, references: [] };
  const history = useConversationHistory(props.stream, props.readHistory);
  const pauseHistory = history.pause;
  const messages = history.messages ?? emptyMessages;
  const scrollArea = useRef<HTMLDivElement>(null);
  const column = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const conversationId = props.conversation.id;
  const newConversationId = props.isNewConversation ? conversationId : null;
  const previousConversation = useRef(conversationId);
  const chatPosition = useRef<ChatPosition | undefined>(undefined);
  const scrollPin = useRef<ConversationScrollPin | null>(null);
  const previewPosition = useRef<ChatPosition | undefined>(undefined);
  const onImagePreviewOpen = useCallback(() => {
    following.current = false;
    previewPosition.current = captureChatPosition(scrollArea.current, scrollPin.current);
    pauseHistory({ keepWindow: true });
  }, [pauseHistory]);
  const lastScrollTop = useRef(0);
  const appliedScroll = useRef<typeof history.scroll>(undefined);
  const picker = useRef<HTMLInputElement>(null);
  const { activeModel } = props;
  const { images, file, fileType, attachmentError, addFiles, removeImage, removeFile, send } =
    props.attachments;
  const allowedFileExtensions =
    fileType === "step" ? ",.step,.stp" : fileType === "zip" ? ",.zip" : "";
  const thinkingLevels = activeModel?.thinkingLevels ?? ["off" as const];
  const thinkingLevel = thinkingLevels.includes(props.conversation.thinkingLevel ?? "off")
    ? (props.conversation.thinkingLevel ?? "off")
    : (thinkingLevels[0] ?? "off");
  const approval =
    props.shellApproval?.conversationId === conversationId ? props.shellApproval : null;
  const hasContent = !!(messages.length || props.stream?.busy || props.stream?.error || approval);
  useEffect(() => {
    if (!props.conversation.id) return;
    setMention(null);
    setActiveOption(undefined);
  }, [props.conversation.id]);
  useLayoutEffect(() => {
    if (newConversationId) setView("chat");
  }, [newConversationId]);
  useLayoutEffect(() => {
    const area = scrollArea.current;
    if (!area) return;
    if (previousConversation.current !== conversationId) {
      previousConversation.current = conversationId;
      chatPosition.current = undefined;
    }
    const position = view === "chat" ? chatPosition.current : null;
    scrollPin.current = position ? restoreChatPosition(area, position) : null;
    following.current = view === "chat" && !scrollPin.current;
    if (!scrollPin.current) area.scrollTop = view === "chat" ? area.scrollHeight : 0;
    lastScrollTop.current = area.scrollTop;
  }, [conversationId, view]);
  useLayoutEffect(() => {
    const next = history.scroll;
    const area = scrollArea.current;
    if (!next || appliedScroll.current === next) return;
    appliedScroll.current = next;
    if (view !== "chat" || !area) return;
    following.current = !next.anchor;
    if (next.anchor) scrollPin.current = restoreChatPosition(area, next.anchor);
    else {
      scrollPin.current = null;
      area.scrollTop = area.scrollHeight;
    }
    lastScrollTop.current = area.scrollTop;
  }, [history.scroll, view]);
  useEffect(() => {
    if (view !== "chat" || !hasContent || !column.current) return;
    // 用户停留在底部时才跟随流式内容，避免打断阅读。
    const observer = new ResizeObserver(() => {
      const area = scrollArea.current;
      if (!area) return;
      if (imagePreviewFocused()) {
        if (previewPosition.current)
          scrollPin.current = restoreChatPosition(area, previewPosition.current);
        return;
      }
      const selection = window.getSelection();
      if (
        history.hasNewer ||
        !following.current ||
        document.activeElement?.closest(".turn-process, .trace-record") ||
        (selection && !selection.isCollapsed)
      )
        return;
      area.scrollTop = area.scrollHeight;
    });
    observer.observe(column.current);
    return () => observer.disconnect();
  }, [hasContent, history.hasNewer, view]);

  function loadAdjacent(direction: "older" | "newer") {
    void history.load(direction, () => captureChatPosition(scrollArea.current, scrollPin.current));
  }

  function loadAtEdge(area: HTMLElement, delta: number, threshold: number) {
    if (history.status) return;
    if (delta < 0 && history.hasOlder && area.scrollTop < threshold) loadAdjacent("older");
    else if (
      delta > 0 &&
      history.hasNewer &&
      area.scrollHeight - area.clientHeight - area.scrollTop < threshold
    )
      loadAdjacent("newer");
  }

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
            onClick={() => {
              if (id === view) return;
              pauseHistory();
              if (view === "chat")
                chatPosition.current = following.current
                  ? undefined
                  : captureChatPosition(scrollArea.current, scrollPin.current);
              setView(id);
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <ConversationNavigation
        key={conversationId}
        markers={props.stream?.history.markers ?? emptyMarkers}
        messages={messages}
        scrollArea={scrollArea}
        scrollPin={scrollPin}
        visible={view === "chat"}
        onJump={history.jump}
      />
      <div
        className="messages"
        ref={scrollArea}
        aria-live="polite"
        onScroll={() => {
          const area = scrollArea.current;
          if (!area || view !== "chat") return;
          const previous = lastScrollTop.current;
          const top = area.scrollTop;
          lastScrollTop.current = top;
          if (imagePreviewFocused()) return;
          if (scrollPin.current && Math.abs(top - scrollPin.current.top) < 2) return;
          scrollPin.current = null;
          const bottom = area.scrollHeight - area.clientHeight - top;
          following.current = !history.hasNewer && bottom < 80;
          if (!following.current) history.keepReading();
          loadAtEdge(area, top - previous, historyScrollThreshold);
        }}
        onWheel={(event) => {
          if (view === "chat" && !imagePreviewFocused())
            loadAtEdge(event.currentTarget, event.deltaY, 2);
        }}
      >
        {props.conversation.interrupted && (
          <p className="notice" role="status">
            上次请求被中断。已保留聊天记录，请确认后重新发送。
          </p>
        )}
        {view === "trace" || hasContent ? (
          <div className={`message-column${view === "trace" ? " trace-column" : ""}`} ref={column}>
            {view === "trace" ? (
              <ConversationTrace
                key={conversationId}
                conversationId={conversationId}
                stream={props.stream}
              />
            ) : (
              <>
                {history.hasOlder && (
                  <div className="history-actions">
                    <button
                      type="button"
                      className="text-button"
                      disabled={history.status?.loading}
                      onClick={() => loadAdjacent("older")}
                    >
                      加载更早的消息
                    </button>
                  </div>
                )}
                <ConversationTranscript
                  key={conversationId}
                  messages={messages}
                  stream={history.hasNewer ? null : props.stream}
                  showThinking={props.showThinking ?? true}
                  model={activeModel?.name}
                  onImagePreviewOpen={onImagePreviewOpen}
                />
                {history.hasNewer && (
                  <div className="history-actions">
                    <button
                      type="button"
                      className="text-button"
                      disabled={history.status?.loading}
                      onClick={() => loadAdjacent("newer")}
                    >
                      加载较新的消息
                    </button>
                    <button type="button" className="text-button" onClick={history.showRecent}>
                      回到最新消息
                    </button>
                  </div>
                )}
              </>
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
            {props.stream?.error && props.stream.error !== messages.at(-1)?.text && (
              <p className="error" role="alert">
                {props.stream.error}
              </p>
            )}
          </div>
        ) : props.stream ? (
          <div className="welcome">
            <div className="welcome-symbol">
              <Icon name="file" size={30} />
            </div>
            <h1>{planning ? "从规划任务开始" : coding ? "从代码任务开始" : "从场景任务开始"}</h1>
            <p>
              {planning
                ? "与助手讨论工艺路径和规划参数。"
                : coding
                  ? activeModel
                    ? "描述需要分析、编写或修改的代码。"
                    : "配置并选择模型后，开始讨论代码任务。"
                  : "在场景工作区导入 URDF，然后与助手讨论模型和关节。"}
            </p>
          </div>
        ) : null}
      </div>
      <div className="composer-wrap">
        {view === "chat" && history.status?.error && (
          <p className="error" role="alert">
            {history.status.error}
          </p>
        )}
        {!!props.stream?.queuedMessages?.length && (
          <section className="queued-messages" aria-label="待处理消息">
            <div className="queued-messages-header">
              <strong>待处理消息 · {props.stream.queuedMessages.length}</strong>
              {!props.stream.busy && (
                <button type="button" onClick={props.onResumeQueue}>
                  继续发送
                </button>
              )}
            </div>
            {!props.stream.busy && <p>未处理的消息已保存，不会自动重发。</p>}
            <ul>
              {props.stream.queuedMessages.map((message) => {
                const filename = (message.stepAttachment ?? message.zipAttachment)?.name;
                const summary = message.text || filename || "图片消息";
                return (
                  <li key={message.id}>
                    <span>
                      {message.delivering
                        ? "正在投递"
                        : message.paused
                          ? "已暂停"
                          : message.delivery === "steer"
                            ? "等待插话"
                            : "完成后发送"}
                    </span>
                    <span className="queued-message-text" title={message.text}>
                      {summary}
                      {message.text && filename && `（${filename}）`}
                      {message.imageCount > 0 && `（${message.imageCount} 张图片）`}
                    </span>
                    {props.stream?.busy &&
                      !message.delivering &&
                      !message.paused &&
                      message.delivery === "followUp" && (
                        <IconButton
                          icon="arrow"
                          label={`改为插话：${summary}`}
                          onClick={() => props.onPromoteQueued(message.id)}
                        />
                      )}
                    <button
                      type="button"
                      disabled={message.delivering}
                      aria-label={`取消待处理消息：${summary}`}
                      onClick={() => props.onCancelQueued(message.id)}
                    >
                      取消
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
        {mention && (
          <FileReferencePicker
            ref={referencePicker}
            onActiveOption={setActiveOption}
            projectId={props.projectId}
            query={mention.query}
            onClose={() => {
              setMention(null);
              props.inputRef.current?.focus();
            }}
            onSelect={(reference) => {
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
              void addFiles(files);
            }
          }}
        >
          {(!!images.length || file) && (
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
              {file && fileType && (
                <FileAttachmentTag name={file.name} kind={fileType} onRemove={removeFile} />
              )}
            </div>
          )}
          {attachmentError && (
            <p className="error" role="alert">
              {attachmentError}
            </p>
          )}
          {draftParts.references.length > 0 && (
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
            placeholder={
              planning
                ? "描述下一轮规划目标…"
                : coding
                  ? "描述你的代码任务…"
                  : "拖入 STEP 或描述你的场景任务…"
            }
            aria-controls={referenceOpen ? "file-reference-options" : undefined}
            aria-activedescendant={referenceOpen ? activeOption : undefined}
            aria-autocomplete={coding ? "list" : undefined}
            value={draftParts.text}
            onChange={(event) => {
              props.onDraft(referenceDraft(event.target.value, draftParts.references));
              setMention(
                coding && draftParts.references.length < 5
                  ? fileMention(event.target.value, event.target.selectionStart)
                  : null,
              );
            }}
            onPaste={(event) => {
              const files = Array.from(event.clipboardData.files);
              if (files.length) {
                event.preventDefault();
                void addFiles(files);
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
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void send();
              }
            }}
          />
          <div className="composer-toolbar">
            <input
              ref={picker}
              type="file"
              accept={`image/png,image/jpeg,image/webp${allowedFileExtensions}`}
              multiple
              hidden
              onChange={(event) => {
                void addFiles(Array.from(event.target.files ?? []));
                event.target.value = "";
              }}
            />
            {coding && (
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
            <IconButton
              icon={fileType ? "file" : "image"}
              label={fileType ? "添加附件" : "添加图片"}
              onClick={() => picker.current?.click()}
            />
            <span className="composer-picker mode-button" title="项目模式">
              <Icon name="chat" size={16} />
              <span>{pluginModules[props.conversation.mode]}</span>
            </span>
            <div className="composer-spacer" />
            <div className="thinking-picker access-picker">
              <Select
                aria-label="访问权限"
                value={props.conversation.accessMode ?? "ask"}
                disabled={!!props.stream?.busy || props.accessPending}
                options={[
                  { value: "ask", label: "请求批准" },
                  { value: "full", label: coding || planning ? "完全访问" : "免确认调整场景" },
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
            {props.stream?.busy && (
              <IconButton icon="stop" label="停止回复" onClick={props.onStop} />
            )}
            <button
              type="button"
              className="send-button"
              aria-label="发送消息"
              disabled={
                props.accessPending || (!props.conversation.draft.trim() && !images.length && !file)
              }
              onClick={() => void send()}
            >
              <Icon name="arrow" size={20} />
            </button>
          </div>
        </fieldset>
        {props.stream && <ConversationUsage key={props.conversation.id} view={props.stream} />}
      </div>
    </section>
  );
}
