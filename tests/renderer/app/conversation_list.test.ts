import assert from "node:assert/strict";
import { test } from "node:test";
import { conversationTitle } from "../../../src/backend/agent/conversation_title.ts";
import { mergeConversations } from "../../../src/renderer/app/logic/conversation_list.ts";
import { referenceDraft, splitReferenceDraft } from "../../../src/shared/file_references.ts";

test("会话按创建时间排序，刷新更新同一记录并保留已加载的旧页", () => {
  const conversation = (id: string, createdAt: number, title = id) => ({
    id,
    createdAt,
    title,
    projectId: "p",
    mode: "coding" as const,
    modelId: "",
    draft: "",
    archived: false,
    interrupted: false,
  });
  const projects = [{ id: "p", name: "P", path: "/tmp", mode: "coding" as const, available: true }];
  const result = mergeConversations(
    [conversation("old-uuid", 1), conversation("new-uuid", 3)],
    [
      conversation("middle-uuid", 2),
      conversation("new-uuid", 3, "更新"),
      { ...conversation("hidden", 10), projectId: "removed" },
    ],
    projects,
  );
  assert.deepEqual(
    result.map((item) => item.id),
    ["new-uuid", "middle-uuid", "old-uuid"],
  );
  assert.equal(result[0]?.title, "更新");
});

test("引用标签不改变草稿正文空格，首条消息标题优先正文", () => {
  const references = [{ path: "src/main.ts", startLine: 2, endLine: 5 }];
  const draft = referenceDraft("请分析  ", references);
  assert.deepEqual(splitReferenceDraft(draft), { text: "请分析  ", references });
  assert.equal(conversationTitle(draft), "请分析");
  assert.equal(conversationTitle(referenceDraft("", references)), "讨论 main.ts");
  assert.equal(conversationTitle("第一条消息\n还有内容"), "第一条消息 还有内容");
  assert.equal(conversationTitle("字".repeat(80)).length, 41);
});
