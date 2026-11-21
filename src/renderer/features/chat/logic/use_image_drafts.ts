import { useRef, useState } from "react";
import type { ChatImage } from "../../../../contracts/application.ts";

// 图片草稿按对话保存；读取或发送中的重复操作会被忽略。
export function useImageDrafts(
  conversationId: string,
  supportsImages: boolean,
  onSend: (images: ChatImage[]) => Promise<boolean>,
) {
  const readingImages = useRef(false);
  const sending = useRef(new Set<string>());
  const [imageDrafts, setImageDrafts] = useState<Record<string, ChatImage[]>>({});
  const [imageError, setImageError] = useState("");
  const images = imageDrafts[conversationId] ?? [];

  async function addImages(files: File[]) {
    if (!files.length || readingImages.current) return;
    readingImages.current = true;
    const id = conversationId;
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

  function removeImage(index: number) {
    setImageDrafts((drafts) => ({
      ...drafts,
      [conversationId]: images.filter((_, i) => i !== index),
    }));
  }

  async function send() {
    if (readingImages.current || sending.current.has(conversationId)) return;
    if (images.length && !supportsImages) {
      setImageError("当前模型不支持图片输入，请切换模型或移除图片。");
      return;
    }
    sending.current.add(conversationId);
    try {
      if (await onSend(images)) {
        // 只移除本次发送的图片，保留发送期间新添加的草稿。
        setImageDrafts((drafts) => ({
          ...drafts,
          [conversationId]: (drafts[conversationId] ?? []).filter(
            (image) => !images.includes(image),
          ),
        }));
        setImageError("");
      }
    } finally {
      sending.current.delete(conversationId);
    }
  }

  return { images, imageError, addImages, removeImage, send };
}
