import { useEffect, useRef, useState } from "react";
import type { ChatImage } from "../../../../contracts/application.ts";
import type { ApplicationBridge } from "../../../../contracts/bridge.ts";
import { maxStepBytes } from "../../../../contracts/scene.ts";
import { isPlanningZipFile } from "../../../../shared/planning_zip.ts";
import { isStepFile } from "../../../../shared/scene/step_attachment.ts";
import { errorMessage } from "../../../shared/logic/error_message.ts";

type AttachmentDraft = { images: ChatImage[]; file?: File | undefined; error: string };
const emptyDraft: AttachmentDraft = { images: [], error: "" };
const imageTypes: readonly string[] = ["image/png", "image/jpeg", "image/webp"];
const maxImageBytes = 5 * 1024 * 1024;

function readImage(file: File) {
  return new Promise<ChatImage>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("无法读取图片。"));
    reader.onload = () =>
      resolve({
        mimeType: file.type as ChatImage["mimeType"],
        data: String(reader.result).split(",", 2)[1] ?? "",
      });
    reader.readAsDataURL(file);
  });
}

export function useAttachmentDrafts(
  api: ApplicationBridge,
  conversationId: string | undefined,
  supportsImages: boolean,
  fileType: "step" | "zip" | undefined,
  onSend: (images: ChatImage[], file?: File) => Promise<boolean>,
) {
  const reading = useRef(new Set<string>());
  const sending = useRef(new Set<string>());
  const [drafts, setDrafts] = useState<Record<string, AttachmentDraft>>({});
  const { images, file, error } = (conversationId && drafts[conversationId]) || emptyDraft;

  useEffect(
    () =>
      api.subscribe((event) => {
        if (event.type !== "conversationDeleted") return;
        reading.current.delete(event.id);
        sending.current.delete(event.id);
        setDrafts((current) => {
          if (!current[event.id]) return current;
          const next = { ...current };
          delete next[event.id];
          return next;
        });
      }),
    [api],
  );

  function updateDraft(update: (draft: AttachmentDraft) => Partial<AttachmentDraft>) {
    if (!conversationId) return;
    setDrafts((current) => {
      const draft = current[conversationId] ?? emptyDraft;
      return { ...current, [conversationId]: { ...draft, ...update(draft) } };
    });
  }

  async function addFiles(files: File[]) {
    if (!conversationId || !files.length || reading.current.has(conversationId)) return;
    reading.current.add(conversationId);
    try {
      const matches =
        fileType === "step" ? isStepFile : fileType === "zip" ? isPlanningZipFile : undefined;
      const label = fileType?.toUpperCase();
      const [selected, extra] = matches ? files.filter((item) => matches(item.name)) : [];
      if (extra) throw new Error(`每条消息可附加一个 ${label} 文件。`);
      if (fileType === "step" && selected && (!selected.size || selected.size > maxStepBytes))
        throw new Error(`请选择非空且不超过 ${maxStepBytes / 1024 / 1024} MiB 的 STEP 文件。`);
      const pictures = files.filter((file) => file !== selected);
      if (images.length + pictures.length > 3) throw new Error("最多添加 3 张图片。");
      if (pictures.some((file) => !imageTypes.includes(file.type) || file.size > maxImageBytes))
        throw new Error(
          label
            ? `请选择 ${label} 文件或不超过 5 MB 的 PNG、JPEG、WebP 图片。`
            : "请选择不超过 5 MB 的 PNG、JPEG 或 WebP 图片。",
        );
      const total =
        images.reduce((sum, image) => sum + Math.floor((image.data.length * 3) / 4), 0) +
        pictures.reduce((sum, file) => sum + file.size, 0);
      if (total > 10 * 1024 * 1024) throw new Error("图片总大小不能超过 10 MB。");
      const added = await Promise.all(pictures.map(readImage));
      if (!reading.current.has(conversationId)) return;
      updateDraft((draft) => ({
        images: [...draft.images, ...added],
        file: selected ?? draft.file,
        error: "",
      }));
    } catch (cause) {
      if (reading.current.has(conversationId))
        updateDraft(() => ({ error: errorMessage(cause, "无法读取附件。") }));
    } finally {
      reading.current.delete(conversationId);
    }
  }

  function removeImage(index: number) {
    updateDraft((draft) => ({ images: draft.images.filter((_, i) => i !== index) }));
  }

  function removeFile() {
    updateDraft(() => ({ file: undefined }));
  }

  async function send() {
    if (
      !conversationId ||
      reading.current.has(conversationId) ||
      sending.current.has(conversationId)
    )
      return;
    if (images.length && !supportsImages) {
      updateDraft(() => ({ error: "当前模型不支持图片输入，请切换模型或移除图片。" }));
      return;
    }
    sending.current.add(conversationId);
    try {
      if ((await onSend(images, file)) && sending.current.has(conversationId))
        // 保留发送期间新添加的草稿。
        updateDraft((draft) => ({
          images: draft.images.filter((image) => !images.includes(image)),
          file: draft.file === file ? undefined : draft.file,
          error: draft.error === error ? "" : draft.error,
        }));
    } finally {
      sending.current.delete(conversationId);
    }
  }

  return {
    images,
    file,
    fileType,
    attachmentError: error,
    addFiles,
    removeImage,
    removeFile,
    send,
  };
}
