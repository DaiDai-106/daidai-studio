import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type Tabs,
  tabsReducer,
} from "../../../src/renderer/features/coding/logic/content_tabs.ts";

test("相同文件复用标签，各 Git 比较基准和网页实例互相独立", () => {
  let state: Tabs = { items: [], activeId: null };
  for (const [id, content] of [
    ["file", { type: "file", path: "sample.ts" }],
    ["duplicate", { type: "file", path: "sample.ts" }],
    ["staged", { type: "diff", path: "sample.ts", kind: "staged" }],
    ["unstaged", { type: "diff", path: "sample.ts", kind: "unstaged" }],
    ["page1", { type: "preview", url: "http://127.0.0.1:5173/" }],
    ["page2", { type: "preview", url: "http://127.0.0.1:5173/" }],
  ] as const)
    state = tabsReducer(state, { type: "open", tab: { id, content } });
  assert.deepEqual(
    state.items.map((tab) => tab.id),
    ["file", "staged", "unstaged", "page1", "page2"],
  );
  state = tabsReducer(state, {
    type: "open",
    tab: { id: "another", content: { type: "file", path: "sample.ts" } },
  });
  assert.equal(state.activeId, "file");
  state = tabsReducer(state, { type: "close", id: "file" });
  assert.equal(state.activeId, "staged");
  state = tabsReducer(state, { type: "close", id: "page2" });
  assert.equal(state.activeId, "staged");
  for (const tab of [...state.items]) state = tabsReducer(state, { type: "close", id: tab.id });
  assert.deepEqual(state, { items: [], activeId: null });
});
