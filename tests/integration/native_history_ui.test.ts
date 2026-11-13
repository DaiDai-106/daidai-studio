import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { _electron as electron } from "playwright";
import { createPiHistory } from "../../src/backend/agent/pi_history.ts";
import { openProjectStore } from "../../src/backend/projects/store.ts";

test("未配置模型也可恢复原生摘要、扩展消息及跨分支累计用量", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-native-history-"));
  const profile = join(root, "profile");
  const directory = join(root, "project");
  await mkdir(directory);
  const store = openProjectStore(join(profile, "data"));
  try {
    const project = store.createProject({ name: "原生历史", mode: "coding", path: directory });
    const conversation = store.createConversation(project.id);
    const manager = createPiHistory(store, join(profile, "data")).open(conversation.id);
    const usage = {
      input: 10,
      output: 2,
      cacheRead: 3,
      cacheWrite: 1,
      totalTokens: 16,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.1 },
    };
    const first = manager.appendMessage({
      role: "user",
      content: "压缩前的用户消息",
      timestamp: 1,
    });
    manager.appendUsage("fixture", "local", "model", usage);
    manager.branch(first);
    manager.appendCompaction("原生压缩摘要内容", first, 16);
    manager.appendCustomMessageEntry("扩展通知", "扩展公开内容", true);
    manager.appendCustomMessageEntry("隐藏通知", "不应出现在界面", false);
    manager.appendUsage("fixture", "local", "model", usage);
    store.updateConversation(conversation.id, { title: "恢复历史", hasMessages: true });
  } finally {
    store.close();
  }
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[0] !== "ELECTRON_RUN_AS_NODE" && entry[1] !== undefined,
    ),
  );
  const app = await electron.launch({
    args: [process.cwd(), `--user-data-dir=${profile}`],
    env,
    chromiumSandbox: true,
  });
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(10000);
    await page.getByRole("button", { name: "恢复历史", exact: true }).click();
    await page.getByText("压缩前的用户消息", { exact: true }).waitFor();
    await page.locator("summary").filter({ hasText: "上下文压缩摘要" }).click();
    await page.getByText("原生压缩摘要内容", { exact: true }).waitFor();
    await page.locator("summary").filter({ hasText: "扩展通知" }).click();
    await page.getByText("扩展公开内容", { exact: true }).waitFor();
    assert.equal(await page.getByText("不应出现在界面", { exact: true }).count(), 0);
    const summary = page.getByRole("button", { name: "对话用量", exact: true });
    assert.equal(await summary.locator("span").count(), 2);
    assert.ok(!(await summary.textContent())?.includes("上下文"));
    await summary.click();
    const details = page.getByRole("dialog", { name: "对话用量" });
    await details.getByText("缓存命中率", { exact: true }).waitFor();
    await details.getByText("最近已报告上下文", { exact: true }).waitFor();
    assert.equal(
      await details
        .locator("dt")
        .filter({ hasText: "当前分支 tokens" })
        .locator("+ dd")
        .textContent(),
      "16",
    );
    assert.equal(
      await details
        .locator("dt")
        .filter({ hasText: /^总 tokens$/ })
        .locator("+ dd")
        .textContent(),
      "32",
    );
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
