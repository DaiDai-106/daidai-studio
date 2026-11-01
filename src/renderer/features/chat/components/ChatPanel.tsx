import { type RefObject, useEffect, useRef } from "react";
import type {
  AccessMode,
  ChatImage,
  ConversationView,
  ShellApproval,
  ThinkingLevel,
} from "../../../../contracts/application.ts";
import { ActionMenu } from "../../../shared/components/ActionMenu.tsx";
import { Icon, IconButton } from "../../../shared/components/Icon.tsx";
import { Select } from "../../../shared/components/Select.tsx";
import type { Conversation, Model } from "../../../shared/logic/types.ts";
import { modeLabel, modes } from "../logic/modes.ts";
import { useImageDrafts } from "../logic/useImageDrafts.ts";
import { ConversationTranscript } from "./ConversationTranscript.tsx";
import { ConversationUsage } from "./UsageDetails.tsx";
import { Welcome } from "./Welcome.tsx";

interface Props {
  inputRef: RefObject<HTMLTextAreaElement | null>;
  conversation: Conversation;
  models: Model[];
  compact: boolean;
  projectScene?: boolean;
  sceneBusy?: boolean;
  onStepDrop?: (file: File) => void;
  onDraft: (value: string) => void;
  onModel: (id: string) => void;
  onThinking: (level: ThinkingLevel) => void;
  onAccessMode: (mode: AccessMode) => void;
  accessPending: boolean;
  onSend: (images: ChatImage[]) => Promise<boolean>;
  onFiles: () => void;
  sceneReference?: import("../../../app/logic/useWorkbench.ts").SceneReferenceDraft | undefined;
  referenceStorageAvailable: boolean;
  onClearSceneReference: () => void;
  onConfigure: () => void;
  stream: ConversationView | null;
  shellApproval: ShellApproval | null;
  onShellApproval: (id: string, approved: boolean) => void;
  showThinking?: boolean;
  onStop: () => void;
}

export function ChatPanel(props: Props) {
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
  const activeMode = modes.find((mode) => mode.id === props.conversation.mode);
  const hasMessages = props.conversation.messages.length > 0;
  const approval =
    props.shellApproval?.conversationId === props.conversation.id ? props.shellApproval : null;
  const hasApproval = !!approval;
  useEffect(() => {
    if (!props.conversation.id) return;
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
        document.activeElement?.closest(".turn-process") ||
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
        {hasMessages || props.stream?.busy || approval ? (
          <div className="message-column" ref={column}>
            <ConversationTranscript
              messages={props.conversation.messages}
              stream={props.stream}
              showThinking={props.showThinking ?? true}
              model={activeModel?.name}
            />
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
        ) : props.compact ? (
          <div className="welcome">
            <div className="welcome-symbol">
              <Icon name="box" size={30} />
            </div>
            <h1>从一个场景需求开始</h1>
            <p>
              {activeModel
                ? "描述需求；有多个 STEP 时可先选择文件。"
                : "配置并选择模型后，助手会询问场景类型和任务。"}
            </p>
          </div>
        ) : (
          <Welcome />
        )}
      </div>
      <div className="composer-wrap">
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
              const step =
                props.onStepDrop && files.find((file) => /\.(step|stp)$/iu.test(file.name));
              if (step) props.onStepDrop?.(step);
              else void addImages(files);
            }
          }}
        >
          {props.sceneReference && (
            <div className="step-binding">
              <span>已引用对象</span>
              <strong title={props.sceneReference.objectId}>{props.sceneReference.name}</strong>
              <IconButton icon="close" label="移除对象引用" onClick={props.onClearSceneReference} />
            </div>
          )}
          {props.sceneReference?.stale && (
            <p className="error" role="alert">
              场景或定位已变化，请移除旧引用并重新选择对象。
            </p>
          )}
          {props.sceneReference?.checking && (
            <p className="notice" role="status">
              正在验证恢复的对象引用；若场景无法加载，请移除引用并重新选择。
            </p>
          )}
          {props.sceneReference && !props.referenceStorageAvailable && (
            <p className="error" role="alert">
              对象引用无法保存在本机，重新打开应用后请重新选择。
            </p>
          )}
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
          {props.sceneBusy && (
            <p className="notice" role="status">
              场景处理中，请等待完成后发送。
            </p>
          )}
          <textarea
            ref={props.inputRef}
            aria-label="消息内容"
            placeholder={props.compact ? "描述你想搭建的场景…" : "随便问问，或描述你的工作…"}
            value={props.conversation.draft}
            onChange={(event) => props.onDraft(event.target.value)}
            onPaste={(event) => {
              const files = Array.from(event.clipboardData.files);
              if (files.length) {
                event.preventDefault();
                void addImages(files);
              }
            }}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing &&
                props.sceneBusy
              ) {
                event.preventDefault();
                return;
              }
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing &&
                !props.sceneReference?.stale &&
                !props.sceneReference?.checking &&
                !props.stream?.busy
              ) {
                event.preventDefault();
                void send();
              }
            }}
          />
          <div className="composer-toolbar">
            {props.projectScene && (
              <IconButton icon="plus" label="添加 STEP 文件" onClick={props.onFiles} />
            )}
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
            <IconButton icon="image" label="添加图片" onClick={() => picker.current?.click()} />
            <span className="composer-picker mode-button" title="项目模式">
              <Icon name={activeMode?.icon ?? "chat"} size={16} />
              <span>{modeLabel(props.conversation.mode)}</span>
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
                (props.accessPending ||
                  props.sceneReference?.stale ||
                  props.sceneReference?.checking ||
                  props.sceneBusy ||
                  (!props.conversation.draft.trim() && !images.length))
              }
              onClick={props.stream?.busy ? props.onStop : () => void send()}
            >
              <Icon name={props.stream?.busy ? "stop" : "arrow"} size={20} />
            </button>
          </div>
        </fieldset>
        {props.stream && <ConversationUsage key={props.conversation.id} view={props.stream} />}
        <p className="composer-note">
          {props.compact ? "对象引用随草稿保存在本机，发送前检查场景版本" : "真实模型对话"}
        </p>
      </div>
    </section>
  );
}
