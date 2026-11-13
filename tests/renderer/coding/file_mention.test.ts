import assert from "node:assert/strict";
import { test } from "node:test";
import { fileMention } from "../../../src/renderer/features/coding/logic/file_mention.ts";
import { referenceDraft, splitReferenceDraft } from "../../../src/shared/file_references.ts";

test("文件候选使用光标前关键词，选择替换整个词并保留前后文本", () => {
  assert.deepEqual(fileMention("前文 @src/main.ts 后文", 7), { start: 3, end: 15, query: "src" });
  assert.deepEqual(fileMention("@", 1), { start: 0, end: 1, query: "" });
  for (const text of ["a@b.com", "普通问题", '@"src/main.ts"', `@${"a".repeat(201)}`])
    assert.equal(fileMention(text, text.length), null);
});

test("输入未确认的文件名不会提前转为标签，已选择引用仍恢复为标签", () => {
  assert.deepEqual(splitReferenceDraft("分析 @main.ts", true), {
    text: "分析 @main.ts",
    references: [],
  });
  assert.deepEqual(splitReferenceDraft("分析 @main.ts"), {
    text: "分析 ",
    references: [{ path: "main.ts" }],
  });
  const references = [{ path: "src/main.ts" }];
  assert.deepEqual(splitReferenceDraft(referenceDraft("分析", references), true), {
    text: "分析",
    references,
  });
});
