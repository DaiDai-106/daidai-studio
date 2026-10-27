import { type RefObject, useEffect, useRef, useState } from "react";
import type {
  ChatImage,
  ConversationView,
  ShellApproval,
  ThinkingLevel,
} from "../../shared/application.ts";
import { ActionMenu } from "../components/ActionMenu.tsx";
import { Icon, IconButton } from "../components/Icon.tsx";
import { Select } from "../components/Select.tsx";
import type { Conversation, Mode, Model } from "../types.ts";
import { ConversationTranscript } from "./ConversationTranscript.tsx";
import { modeLabel, modes } from "./modes.ts";
import { ConversationUsage } from "./UsageDetails.tsx";
import { Welcome } from "./Welcome.tsx";

interface Props {
  inputRef: RefObject<HTMLTextAreaElement | null>;
  conversation: Conversation;
  models: Model[];
  compact: boolean;
  onDraft: (value: string) => void;
  onMode: (mode: Mode) => void;
  onModel: (id: string) => void;
  onThinking: (level: ThinkingLevel) => void;
  onSend: (images: ChatImage[]) => Promise<boolean>;
  onFiles: () => void;
  step: string;
  onClearStep: () => void;
  sceneReference?: import("./useWorkbench.ts").SceneReferenceDraft | undefined;
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
  const readingImages = useRef(false);
  const sending = useRef(false);
  const [imageDrafts, setImageDrafts] = useState<Record<string, ChatImage[]>>({});
  const [imageError, setImageError] = useState("");
  const images = imageDrafts[props.conversation.id] ?? [];

  async function addImages(files: File[]) {
    if (!files.length || readingImages.current) return;
    readingImages.current = true;
    const id = props.conversation.id;
    try {
      if (images.length + files.length > 3) throw new Error("最多添加 3 张图片。");
      if (
        files.some(
          (file) =>
            !["image/png", "image/jpeg", "image/webp"].includes(file.type) ||
            file.size > 5 * 1024 * 1024,
        )
      )
        throw new Error("请选择不超过 5 MB 的 PNG、JPEG 或 WebP 图片。");
      const total =
        images.reduce((sum, image) => sum + Math.floor((image.data.length * 3) / 4), 0) +
        files.reduce((sum, file) => sum + file.size, 0);
      if (total > 10 * 1024 * 1024) throw new Error("图片总大小不能超过 10 MB。");
      const added = await Promise.all(
        files.map(
          (file) =>
            new Promise<ChatImage>((resolve, reject) => {
              const reader = new FileReader();
              reader.onerror = () => reject(new Error("无法读取图片。"));
              reader.onload = () =>
                resolve({
                  mimeType: file.type as ChatImage["mimeType"],
                  data: String(reader.result).split(",", 2)[1] ?? "",
                });
              reader.readAsDataURL(file);
            }),
        ),
      );
      setImageDrafts((drafts) => ({ ...drafts, [id]: [...(drafts[id] ?? []), ...added] }));
      setImageError("");
    } catch (error) {
      setImageError(error instanceof Error ? error.message : "无法读取图片。");
    } finally {
      readingImages.current = false;
    }
  }
  async function send() {
    if (readingImages.current || sending.current) return;
    if (images.length && !activeModel?.supportsImages) {
      setImageError("当前模型不支持图片输入，请切换模型或移除图片。");
      return;
    }
    sending.current = true;
    try {
      if (await props.onSend(images)) {
        setImageDrafts((drafts) => ({
          ...drafts,
          [props.conversation.id]: (drafts[props.conversation.id] ?? []).filter(
            (image) => !images.includes(image),
          ),
        }));
        setImageError("");
      }
    } finally {
      sending.current = false;
    }
  }

  const activeModel = props.models.find((model) => model.id === props.conversation.modelId);
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
    // Follow streamed content only while the reader stays at the bottom.
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
              void addImages(files);
            }
          }}
        >
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
                    onClick={() =>
                      setImageDrafts((drafts) => ({
                        ...drafts,
                        [props.conversation.id]: images.filter((_, i) => i !== index),
                      }))
                    }
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
            <IconButton icon="plus" label="选择项目 STEP" onClick={props.onFiles} />
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
                (props.sceneReference?.stale ||
                  props.sceneReference?.checking ||
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
