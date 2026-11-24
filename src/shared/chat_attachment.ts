import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import { type PlanningZipAttachment, PlanningZipAttachmentSchema } from "../contracts/planning.ts";
import { type StepAttachment, StepAttachmentSchema } from "../contracts/scene.ts";

function attachmentMessage<Schema extends TSchema>(label: string, schema: Schema) {
  const marker = `[${label} 附件] `;
  return {
    attach(text: string, attachment: Static<Schema>) {
      return `${text ? `${text}\n\n` : ""}${marker}${JSON.stringify(attachment)}`;
    },
    split(text: string): { text: string; attachment?: Static<Schema>; index: number } {
      const separator = text.lastIndexOf(`\n\n${marker}`);
      const index = separator >= 0 ? separator + 2 : 0;
      if (!text.startsWith(marker, index)) return { text, index: -1 };
      const start = index + marker.length;
      const end = text.indexOf("\n", start);
      try {
        const attachment: unknown = JSON.parse(text.slice(start, end < 0 ? undefined : end));
        if (Value.Check(schema, attachment)) {
          // Pi 可能在用户消息末尾补充图片处理说明。
          const suffix = end < 0 ? "" : text.slice(end);
          return {
            text: separator < 0 ? suffix.trimStart() : text.slice(0, separator) + suffix,
            attachment,
            index,
          };
        }
      } catch {
        // 普通消息也可能包含类似的文本。
      }
      return { text, index: -1 };
    },
  };
}

export const stepMessage = attachmentMessage("STEP", StepAttachmentSchema);
export const zipMessage = attachmentMessage("ZIP", PlanningZipAttachmentSchema);

export function splitChatAttachment(text: string): {
  text: string;
  stepAttachment?: StepAttachment;
  zipAttachment?: PlanningZipAttachment;
} {
  // 每条消息只有一个原生文件附件。
  const zip = zipMessage.split(text);
  const step = stepMessage.split(text);
  if (zip.attachment && zip.index > step.index)
    return { text: zip.text, zipAttachment: zip.attachment };
  return step.attachment ? { text: step.text, stepAttachment: step.attachment } : { text };
}
