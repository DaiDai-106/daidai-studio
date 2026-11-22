import { Value } from "typebox/value";
import { type StepAttachment, StepAttachmentSchema } from "../contracts/scene.ts";

const marker = "[STEP 附件] ";

export const isStepFile = (name: string) => /\.st(?:e)?p$/iu.test(name);

// Pi 的原生用户消息保存附件引用。CAD 数据只保存在本地。
export function attachStepToMessage(text: string, attachment: StepAttachment) {
  return `${text ? `${text}\n\n` : ""}${marker}${JSON.stringify(attachment)}`;
}

export function splitStepMessage(text: string): { text: string; stepAttachment?: StepAttachment } {
  const separator = text.lastIndexOf(`\n\n${marker}`);
  const index = separator >= 0 ? separator + 2 : 0;
  if (!text.startsWith(marker, index)) return { text };
  const start = index + marker.length;
  const end = text.indexOf("\n", start);
  try {
    const attachment: unknown = JSON.parse(text.slice(start, end < 0 ? undefined : end));
    if (Value.Check(StepAttachmentSchema, attachment)) {
      // Pi 可能在用户消息末尾补充图片处理说明。
      const suffix = end < 0 ? "" : text.slice(end);
      return {
        text: separator < 0 ? suffix.trimStart() : text.slice(0, separator) + suffix,
        stepAttachment: attachment,
      };
    }
  } catch {
    // 普通消息也可能包含类似的文本。
  }
  return { text };
}
