import assert from "node:assert/strict";
import { test } from "node:test";
import { appendSkillImage, removeSkillImage } from "../../src/renderer/settings/skillImageDraft.ts";
import type { Skill } from "../../src/renderer/types.ts";

function skill(body = "原始正文"): Skill {
  return {
    id: "skill",
    name: "场景技能",
    description: "测试",
    body,
    builtin: false,
    enabled: true,
    scope: { kind: "global" },
    modes: ["scene"],
  };
}

const image = { name: "参考图.png", path: "images/123e4567-e89b-12d3-a456-426614174000.png" };

test("adding an uploaded image preserves edits made while the upload was pending", () => {
  const beforeUpload = skill();
  const editedWhileUploading = {
    ...beforeUpload,
    name: "用户改名",
    description: "用户改过描述",
    body: "用户改过正文",
  };

  assert.deepEqual(appendSkillImage(editedWhileUploading, image), {
    ...editedWhileUploading,
    images: [image],
    body: "用户改过正文\n\n[参考图.png的参考图](images/123e4567-e89b-12d3-a456-426614174000.png)",
  });
});

test("removing an uploaded image removes only its generated reference", () => {
  const withImage = appendSkillImage(skill("保留的正文"), image);
  assert.deepEqual(removeSkillImage(withImage, image), skill("保留的正文"));
});
