import assert from "node:assert/strict";
import { test } from "node:test";
import type { CatalogTask } from "../../../src/contracts/catalog.ts";
import { mergePluginTasks } from "../../../src/renderer/features/settings/logic/plugin_tasks.ts";

const task = (state: CatalogTask["state"], id = "a", startedAt = 1): CatalogTask => ({
  id,
  state,
  startedAt,
  source: "npm:demo",
  host: "pi",
  scope: "global",
  action: "install",
  message: state,
});

test("迟到的初始快照、启动响应和进度事件不能把任务终态退回进行中", () => {
  for (const state of ["completed", "failed"] as const) {
    let tasks = mergePluginTasks([task(state)], []);
    tasks = mergePluginTasks(tasks, [task("running")]); // 初始快照或启动响应迟到。
    tasks = mergePluginTasks([task("running")], tasks); // 进度事件迟到。
    assert.equal(tasks[0]?.state, state);
  }
});

test("新进度优先于旧快照，列表去重且只保留最近 100 个任务", () => {
  const completed = task("completed");
  const newer = { ...task("running", "b", 2), message: "new progress" };
  let tasks = mergePluginTasks([newer], [completed, task("running", "b", 2)]);
  tasks = mergePluginTasks(tasks, [{ ...newer, message: "stale snapshot" }]);
  assert.deepEqual(
    tasks.map((item) => [item.id, item.message]),
    [
      ["b", "new progress"],
      ["a", "completed"],
    ],
  );
  const history = Array.from({ length: 150 }, (_, i) => task("completed", String(i), i));
  const recent = mergePluginTasks(history, history);
  assert.equal(recent.length, 100);
  assert.equal(recent[0]?.id, "149");
  assert.equal(recent.at(-1)?.id, "50");
});
