import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPiHistory } from "../../src/backend/agent/pi_history.ts";
import { openProjectStore } from "../../src/backend/projects/store.ts";
import { servePlanner } from "../support/planner.ts";
import { holdApplicationResponses, launchElectron } from "./support.ts";

test("长会话分页保留阅读位置，导航可跳到尚未加载的原生轮次", {
  timeout: 60_000,
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "dai-conversation-navigation-"));
  let application: Awaited<ReturnType<typeof launchElectron>> | undefined;
  context.after(async () => {
    try {
      await application?.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  const profile = join(root, "profile");
  const dataRoot = join(profile, "data");
  const store = openProjectStore(dataRoot);
  const ids: string[] = [];
  const chats = new Map<string, string>();
  try {
    const screenshot = {
      type: "image",
      mimeType: "image/png",
      data: await readFile("dist/icons/1024.png", "base64"),
    } as const;
    const project = store.createProject({ name: "导航项目", mode: "coding", path: root });
    const history = createPiHistory(store, dataRoot);
    for (const prefix of ["甲", "乙", "丙"]) {
      const conversation = store.createConversation(project.id);
      chats.set(prefix, conversation.id);
      const session = history.open(conversation.id);
      const rounds = prefix === "甲" ? 95 : 5;
      for (let i = 1; i <= rounds; i++) {
        const text = `${prefix}轮次 ${i}`;
        const id = session.appendMessage({
          role: "user",
          content: prefix === "甲" && i === rounds ? [{ type: "text", text }, screenshot] : text,
          timestamp: i * 2,
        });
        if (prefix === "甲") ids.push(id);
        session.appendMessage({
          role: "assistant",
          content: [
            ...(i === 1
              ? [{ type: "thinking" as const, thinking: "思考段落。\n\n".repeat(20) }]
              : []),
            { type: "text", text: `回复 ${i}\n\n${"段落内容。\n\n".repeat(24)}` },
          ],
          api: "openai-completions",
          provider: "local",
          model: "example",
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: i * 2 + 1,
        });
      }
      store.updateConversation(conversation.id, { title: `导航${prefix}`, hasMessages: true });
    }
  } finally {
    store.close();
  }

  application = await launchElectron(profile);
  const page = await application.firstWindow();
  page.setDefaultTimeout(8_000);
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 760),
  );
  await page.getByRole("button", { name: "导航甲", exact: true }).click();
  const rail = page.getByRole("navigation", { name: "跳转到用户消息" });
  await rail.waitFor();
  const intro = page.getByRole("heading", { name: "从代码任务开始", exact: true });
  assert.equal(await intro.count(), 0);
  const railBounds = await rail.boundingBox();
  const columnBounds = await page.locator(".message-column").boundingBox();
  assert.ok(railBounds && columnBounds && columnBounds.x + columnBounds.width <= railBounds.x);
  const messages = page.locator(".messages");
  const active = rail.locator('[aria-current="location"]');
  const first = rail.getByRole("button", { name: /第 1 条消息：甲轮次 1/ });
  const latest = rail.getByRole("button", { name: /第 95 条消息：甲轮次 95/ });
  const turns = messages.locator("[data-user-turn]");
  await latest.and(active).waitFor();
  assert.equal(await turns.count(), 30);
  assert.equal(await messages.getByText("甲轮次 1", { exact: true }).count(), 0);
  const recentStart = ids[65];
  assert.ok(recentStart);
  const offsetOf = (id: string | undefined, scrollTop?: number) =>
    messages.evaluate(
      (area, input) => {
        if (input.scrollTop !== undefined) area.scrollTop = input.scrollTop;
        const turn = area.querySelector(`[data-turn-id="${input.id}"]`);
        return turn
          ? turn.getBoundingClientRect().top - area.getBoundingClientRect().top
          : Infinity;
      },
      { id, scrollTop },
    );
  const originalOffset = await offsetOf(recentStart, 24);
  await messages.getByText("甲轮次 36", { exact: true }).waitFor({ state: "attached" });
  assert.equal(await turns.count(), 60);
  const restoredOffset = await offsetOf(recentStart);
  assert.ok(Math.abs(restoredOffset - originalOffset) < 2, "向上加载后保留原轮次和像素偏移");

  await first.click();
  await first.and(active).waitFor();
  assert.equal(await turns.count(), 30);
  assert.equal(await messages.getByText("甲轮次 95", { exact: true }).count(), 0);
  await page.locator(".process-header").first().click();
  await page.getByRole("button", { name: "思考摘要" }).click();
  const marker = rail.getByRole("button", { name: /第 2 条消息：甲轮次 2/ });
  await marker.click();
  await marker.and(active).waitFor();
  const turnOffset = () => offsetOf(ids[1]);
  const offset = await turnOffset();
  assert.ok(offset >= 0 && offset < 25, `选中的轮次应贴近消息区顶部，实际偏移 ${offset}`);
  const beforeTrace = await messages.evaluate((node) => node.scrollTop);
  await page.getByRole("tab", { name: "轨迹", exact: true }).click();
  await rail.waitFor({ state: "hidden" });
  await page.getByRole("tab", { name: "聊天", exact: true }).click();
  await marker.and(active).waitFor();
  assert.ok((await messages.evaluate((node) => node.scrollTop)) < beforeTrace - 100);
  assert.ok(Math.abs((await turnOffset()) - offset) < 2);

  await messages.evaluate((node) => {
    node.scrollTop += 120;
  });
  const readingOffset = await turnOffset();
  await page.getByRole("tab", { name: "轨迹", exact: true }).click();
  await page.getByRole("tab", { name: "聊天", exact: true }).click();
  assert.ok(Math.abs((await turnOffset()) - readingOffset) < 2);
  await messages.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  await messages.getByText("甲轮次 60", { exact: true }).waitFor({ state: "attached" });
  assert.equal(await turns.count(), 60);
  await latest.click();
  await latest.and(active).waitFor();
  assert.equal(await turns.count(), 30);

  const hold = await holdApplicationResponses(application);
  const nextPaint = () =>
    page.evaluate(
      () =>
        new Promise<void>((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => done())),
        ),
    );

  const firstPage = await hold("conversation.history", ids[0]);
  await first.click();
  await firstPage.entered();
  const middle = rail.getByRole("button", { name: /第 32 条消息：甲轮次 32/ });
  const middlePage = await hold("conversation.history", ids[31]);
  await middle.click();
  await middlePage.entered();
  await middlePage.release();
  await middle.and(active).waitFor();
  await firstPage.release();
  await nextPaint();
  assert.equal(await first.and(active).count(), 0);
  await latest.click();
  await latest.and(active).waitFor();

  const queuedPage = await hold("conversation.history", ids[0]);
  await first.click();
  await queuedPage.entered();
  await latest.evaluate((button: HTMLElement) => {
    const some = Array.prototype.some;
    // 响应通过分支校验后插入一次点击，早于默认优先级的 React 提交。
    Array.prototype.some = function (predicate, receiver) {
      const found = some.call(this, predicate, receiver);
      if (this.length === 95 && this[0]?.label === "甲轮次 1") {
        Array.prototype.some = some;
        queueMicrotask(() => {
          button.click();
          button.dataset.interleaved = "";
        });
      }
      return found;
    };
  });
  await queuedPage.release();
  await page.locator("[data-interleaved]").waitFor({ state: "attached" });
  await nextPaint();
  assert.equal(await latest.and(active).count(), 1);
  assert.equal(await messages.getByText("甲轮次 1", { exact: true }).count(), 0);

  const previewPage = await hold("conversation.history", ids[0]);
  await first.click();
  await previewPage.entered();
  await page.getByRole("button", { name: "放大图片 1", exact: true }).click();
  const preview = page.getByRole("dialog", { name: "图片预览" });
  await preview.waitFor();
  const beforePreview = await messages.evaluate((area) => area.scrollTop);
  await previewPage.release();
  await nextPaint();
  assert.ok(await preview.isVisible());
  assert.equal(await messages.evaluate((area) => area.scrollTop), beforePreview);
  assert.equal(await messages.getByText("甲轮次 1", { exact: true }).count(), 0);
  await page.keyboard.press("Escape");
  await preview.waitFor({ state: "hidden" });

  const latePage = await hold("conversation.history", ids[0]);
  await first.click();
  await latePage.entered();
  const switchPage = await hold("conversation.watch", chats.get("乙"));
  await page.getByRole("button", { name: "导航乙", exact: true }).click();
  await switchPage.entered();
  await page.getByRole("button", { name: "导航丙", exact: true }).click();
  await switchPage.release();
  await rail
    .getByRole("button", { name: /丙轮次 5/ })
    .and(active)
    .waitFor();
  await latePage.release();
  await nextPaint();
  assert.equal(await rail.getByRole("button", { name: /甲轮次/ }).count(), 0);
  assert.equal(await messages.getByText("甲轮次 1", { exact: true }).count(), 0);
  assert.equal(await intro.count(), 0);

  const finish = Promise.withResolvers<void>();
  const planner = await servePlanner(() => ({
    text: "继续流式回复",
    beforeFinish: finish.promise,
  }));
  context.after(async () => {
    finish.resolve();
    await planner.close();
  });
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
            id: "example",
            name: "Example",
            context: 8192,
            output: 1024,
            reasoning: "标准",
            supportsImages: true,
          },
        ],
      }),
    planner.endpoint,
  );
  await page.getByRole("button", { name: "导航甲", exact: true }).click();
  await latest.and(active).waitFor();
  const start = rail.getByRole("button", { name: /第 66 条消息：甲轮次 66/ });
  await start.click();
  const heldOlder = await hold("conversation.history", recentStart);
  await page
    .getByRole("button", { name: "加载更早的消息", exact: true })
    .evaluate((button: HTMLElement) => button.click());
  await heldOlder.entered();
  const beforeStream = await offsetOf(recentStart);
  await page.evaluate((id) => {
    if (!id) throw new Error("缺少会话。");
    return window.desktop.application.sendMessage(id, crypto.randomUUID(), "新增轮次");
  }, chats.get("甲"));
  await messages.getByText("继续流式回复", { exact: true }).waitFor({ state: "attached" });
  assert.equal(await turns.count(), 31);
  assert.ok(Math.abs((await offsetOf(recentStart)) - beforeStream) < 2);
  await heldOlder.release();
  await messages.getByText("甲轮次 36", { exact: true }).waitFor({ state: "attached" });
  assert.equal(await turns.count(), 61);
  assert.ok(Math.abs((await offsetOf(recentStart)) - beforeStream) < 2);
  assert.equal(await page.getByText("会话历史已更新，请重试。", { exact: true }).count(), 0);
  finish.resolve();
  await page.getByRole("button", { name: "发送消息", exact: true }).waitFor();
});
