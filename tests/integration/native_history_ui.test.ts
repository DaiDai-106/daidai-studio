import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPiHistory } from "../../src/backend/agent/pi_history.ts";
import { openProjectStore } from "../../src/backend/projects/store.ts";
import { servePlanner } from "../support/planner.ts";
import { launchElectron, launchTestApp, openTestProject } from "./support.ts";

test("未配置模型也可恢复原生截图、摘要、扩展消息及跨分支累计用量", {
  timeout: 60_000,
}, async () => {
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
      content: [
        { type: "text", text: "压缩前的用户消息" },
        {
          type: "image",
          mimeType: "image/png",
          data: await readFile("dist/icons/1024.png", "base64"),
        },
      ],
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
  const app = await launchElectron(profile);
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(10000);
    await page.getByRole("button", { name: "恢复历史", exact: true }).click();
    await page.getByText("压缩前的用户消息", { exact: true }).waitFor();
    const thumbnail = page.getByRole("button", { name: "放大图片 1", exact: true });
    await thumbnail.locator("img").evaluate((node: HTMLImageElement) => node.decode());
    await thumbnail.scrollIntoViewIfNeeded();
    const scrollTop = () => page.locator(".messages").evaluate((area) => area.scrollTop);
    const beforePreview = await scrollTop();
    const thumbnailBounds = await thumbnail.boundingBox();
    await thumbnail.click();
    const preview = page.getByRole("dialog", { name: "图片预览" });
    await preview.waitFor();
    const image = preview.getByRole("img", { name: "图片 1", exact: true });
    await image.evaluate((node: HTMLImageElement) => node.decode());
    const imageBounds = await image.boundingBox();
    assert.ok(thumbnailBounds && imageBounds && imageBounds.width > thumbnailBounds.width);
    assert.equal(await preview.getByRole("button").count(), 1);
    assert.ok(
      await image.evaluate((node: HTMLImageElement) => {
        const { top, right, bottom, left } = node.getBoundingClientRect();
        return top >= 0 && left >= 0 && right <= innerWidth && bottom <= innerHeight;
      }),
    );
    await page.keyboard.press("Escape");
    await preview.waitFor({ state: "hidden" });
    assert.equal(await scrollTop(), beforePreview);
    assert.ok(await thumbnail.evaluate((button) => button === document.activeElement));
    await thumbnail.press("Enter");
    await preview.getByRole("button", { name: "关闭图片预览", exact: true }).click();
    await preview.waitFor({ state: "hidden" });
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

test("截图预览期间流式回复可以继续，关闭后保留聊天阅读位置", {
  timeout: 60_000,
}, async (context) => {
  const finish = Promise.withResolvers<void>();
  const firstChunk = "开始回复。";
  const planner = await servePlanner(() => ({
    text: `${firstChunk}\n\n${"继续回复。\n\n".repeat(65)}回复结束。`,
    splitAt: firstChunk.length,
    beforeFinish: finish.promise,
  }));
  context.after(async () => {
    finish.resolve();
    await planner.close();
  });
  const { application, page, profile } = await launchTestApp(context);
  page.setDefaultTimeout(10_000);
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 760),
  );
  await page.evaluate(
    (endpoint) =>
      window.desktop.application.saveProvider({
        id: "local",
        name: "Local",
        providerType: "local",
        authMethod: "none",
        endpoint,
        enabled: true,
        models: [
          {
            id: "preview",
            name: "Preview",
            context: 8192,
            output: 1024,
            reasoning: "标准",
            supportsImages: true,
          },
        ],
      }),
    planner.endpoint,
  );
  await openTestProject(application, page, profile);
  await page.evaluate(
    async (data) => {
      const [conversation] = (await window.desktop.application.getWorkspace()).conversations;
      if (!conversation) throw new Error("缺少测试会话。");
      await window.desktop.application.sendMessage(
        conversation.id,
        crypto.randomUUID(),
        "带截图的消息",
        [{ mimeType: "image/png", data }],
      );
    },
    await readFile("dist/icons/1024.png", "base64"),
  );

  const messages = page.locator(".messages");
  const thumbnail = page.getByRole("button", { name: "放大图片 1", exact: true });
  const readingOffset = () =>
    thumbnail.evaluate((button) => {
      const area = button.closest(".messages");
      if (!area) throw new Error("缺少消息区。");
      return button.getBoundingClientRect().top - area.getBoundingClientRect().top;
    });
  await messages.getByText(firstChunk, { exact: true }).waitFor();
  await thumbnail.locator("img").evaluate((image: HTMLImageElement) => image.decode());
  await page.waitForFunction(() => {
    const area = document.querySelector(".messages");
    return area && area.scrollHeight - area.clientHeight - area.scrollTop < 2;
  });
  const before = await readingOffset();
  await thumbnail.click();
  const preview = page.getByRole("dialog", { name: "图片预览" });
  await preview.waitFor();
  assert.ok(Math.abs((await readingOffset()) - before) < 2);
  finish.resolve();
  await messages.getByText("回复结束。", { exact: true }).waitFor({ state: "attached" });
  await page.evaluate(
    () =>
      new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
  );
  assert.ok(Math.abs((await readingOffset()) - before) < 2);

  await page.keyboard.press("Escape");
  await preview.waitFor({ state: "hidden" });
  assert.ok(Math.abs((await readingOffset()) - before) < 2);
  assert.ok(await thumbnail.evaluate((button) => button === document.activeElement));
});
