import { existsSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import { splitStepMessage } from "../../src/shared/step_attachment.ts";

const executable = process.platform === "win32" ? "cad-import.exe" : "cad-import";
export const stepWorkerAvailable = existsSync(
  new URL(`../../modules/scene/runtime/${executable}`, import.meta.url),
);

export function writeStepFixture(path: string, units: "mm" | "inch" = "mm") {
  return copyFile(new URL(`../fixtures/scene/assembly-${units}.step`, import.meta.url), path);
}

export function stepAgentReply(body: string, expectedRevision: number) {
  const { messages } = JSON.parse(body) as {
    messages: { role: string; content: string | { text?: string }[] }[];
  };
  const last = messages.at(-1);
  const content = last?.content;
  const text =
    typeof content === "string" ? content : (content?.map((part) => part.text).join("") ?? "");
  const { stepAttachment } = splitStepMessage(text);
  const chunk = (delta: object, finish_reason: string | null) =>
    `data: ${JSON.stringify({ id: "step", object: "chat.completion.chunk", created: 1, model: "example", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
  const reply =
    last?.role === "user" && stepAttachment
      ? chunk(
          {
            tool_calls: [
              {
                index: 0,
                id: `step-${stepAttachment.id}`,
                type: "function",
                function: {
                  name: "scene_import_step",
                  arguments: JSON.stringify({ attachmentId: stepAttachment.id, expectedRevision }),
                },
              },
            ],
          },
          null,
        ) + chunk({}, "tool_calls")
      : chunk({ role: "assistant", content: "已处理 STEP 导入请求。" }, "stop");
  return `${reply}data: [DONE]\n\n`;
}
