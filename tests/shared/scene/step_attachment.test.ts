import assert from "node:assert/strict";
import { test } from "node:test";
import {
  attachStepToMessage,
  splitStepMessage,
} from "../../../src/shared/scene/step_attachment.ts";

test("Pi 附加图片处理说明后，STEP 仍显示为附件", () => {
  const stepAttachment = { id: crypto.randomUUID(), name: "原始装配.step" };
  const hint = "图片已缩放。";
  for (const text of ["", "导入装配"]) {
    const message = attachStepToMessage(text, stepAttachment);
    assert.deepEqual(splitStepMessage(message), { text, stepAttachment });
    assert.deepEqual(splitStepMessage(`${message}\n\n${hint}`), {
      text: [text, hint].filter(Boolean).join("\n\n"),
      stepAttachment,
    });
  }
  const text = "导入装配\n\n[STEP 附件] 示例\n\n说明";
  assert.deepEqual(splitStepMessage(text), { text });
});
