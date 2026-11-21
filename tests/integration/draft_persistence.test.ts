import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { launchElectron, openTestProject } from "./support.ts";

test("switching conversations and quitting immediately persist the latest draft", {
  timeout: 45000,
}, async () => {
  const profile = await mkdtemp(join(tmpdir(), "dai-drafts-"));
  let application = await launchElectron(profile);
  try {
    let page = await application.firstWindow();
    page.setDefaultTimeout(8000);
    await openTestProject(application, page, profile);
    const input = page.getByRole("textbox", { name: "消息内容" });
    await input.fill("切换前的草稿");
    await page.getByRole("button", { name: "新建对话", exact: true }).first().click();
    await page.waitForFunction(
      () =>
        (document.querySelector('textarea[aria-label="消息内容"]') as HTMLTextAreaElement)
          ?.value === "",
    );
    const values = await page.evaluate(async () =>
      (await window.desktop.application.getWorkspace()).conversations.map((item) => item.draft),
    );
    assert.ok(values.includes("切换前的草稿"));
    await input.fill("退出前的草稿");
    const exited = once(application.process(), "exit");
    await application.evaluate(({ app }) => app.quit());
    await exited;
    application = await launchElectron(profile);
    page = await application.firstWindow();
    page.setDefaultTimeout(8000);
    const workspace = await page.evaluate(() => window.desktop.application.getWorkspace());
    const conversationIndex = workspace.conversations.findIndex(
      (item) => item.draft === "退出前的草稿",
    );
    assert.ok(conversationIndex >= 0);
    await page.locator(".conversation-title").nth(conversationIndex).click();
    await page.getByRole("textbox", { name: "消息内容" }).waitFor();
    assert.equal(
      await page.getByRole("textbox", { name: "消息内容" }).inputValue(),
      "退出前的草稿",
    );
    const intro = page.getByRole("heading", { name: "从代码任务开始", exact: true });
    await intro.waitFor();
    const restored = await page.evaluate(async () =>
      (await window.desktop.application.getWorkspace()).conversations.map((item) => item.draft),
    );
    assert.ok(restored.includes("切换前的草稿"));
    await page.getByRole("tab", { name: "轨迹", exact: true }).click();
    await page.getByRole("button", { name: "新建对话", exact: true }).first().click();
    await intro.waitFor();
    assert.equal(
      await page.getByRole("tab", { name: "聊天", exact: true }).getAttribute("aria-selected"),
      "true",
    );
  } finally {
    await application.close();
    await rm(profile, { recursive: true, force: true });
  }
});
