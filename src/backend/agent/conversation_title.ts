import { FILE_SNAPSHOT_MARKER, splitReferenceDraft } from "../../shared/file_references.ts";

// 使用首条消息命名，不额外请求模型；手动重命名由调用方保留。
export function conversationTitle(message: string) {
  const { text, references } = splitReferenceDraft(
    (message.split(FILE_SNAPSHOT_MARKER)[0] ?? "").split("\n\n用户引用的场景对象")[0] ?? "",
  );
  const title =
    text.trim().replace(/\s+/gu, " ") ||
    (references.length
      ? `讨论 ${references.map((reference) => reference.path.split("/").pop()).join("、")}`
      : "图片对话");
  const characters = Array.from(title);
  return characters.length > 40 ? `${characters.slice(0, 40).join("")}…` : title;
}
