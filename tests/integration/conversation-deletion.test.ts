import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { _electron as electron } from "playwright";
import { openTestProject } from "./support.ts";

test("conversation deletion confirms inline, preserves the STEP binding and shared viewport and blocks access after restart", {
  timeout: 60_000,
}, async () => {
  const profile = await mkdtemp(join(tmpdir(), "dai-delete-chat-"));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[0] !== "ELECTRON_RUN_AS_NODE" && entry[1] !== undefined,
    ),
  );
  const launch = () =>
    electron.launch({
      args: [process.cwd(), `--user-data-dir=${profile}`],
      env,
      chromiumSandbox: true,
    });
  let app = await launch();
  try {
    let page = await app.firstWindow();
    page.setDefaultTimeout(7000);
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setContentSize(1500, 940),
    );
    const directory = await openTestProject(app, page, profile);
    const first = await page.evaluate(async () => {
      const item = (await window.desktop.application.getWorkspace()).conversations[0];
      if (!item) throw new Error("Missing first conversation");
      await window.desktop.application.updateConversation({ id: item.id, title: "A" });
      return item.id;
    });
    await page.getByRole("button", { name: "通用对话", exact: true }).click();
    await page.getByRole("menuitem", { name: /^场景搭建/ }).click();
    await page.getByRole("button", { name: "当前 STEP", exact: true }).click();
    await page.getByRole("button", { name: /^assemblies\/robot-arm.step/ }).click();
    await page
      .locator(".scene-source")
      .getByText("assemblies/robot-arm.step", { exact: true })
      .waitFor();
    const canvas = await page.getByLabel("三维场景视图", { exact: true }).elementHandle();
    assert.ok(canvas);
    await page.getByRole("button", { name: "在当前项目新建对话", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll(".conversation-row").length === 2);
    await page.getByRole("button", { name: "A 对话操作", exact: true }).click();
    const menu = page.getByRole("menu", { name: "A 对话操作", exact: true });
    assert.equal(await menu.getByRole("menuitem").count(), 3);
    assert.equal(await menu.locator(".menu-option > svg").count(), 3);
    await menu.getByRole("menuitem", { name: "删除", exact: true }).click();
    await menu.getByRole("menuitem", { name: "确认删除", exact: true }).waitFor();
    assert.equal(await page.getByRole("dialog").count(), 0);
    assert.equal(await page.locator(".conversation-row").count(), 2);
    await menu.screenshot({ path: join(tmpdir(), "dai-delete-menu-confirm.png") });
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "hidden" });
    assert.equal(await page.locator(".conversation-row").count(), 2);
    await page.getByRole("button", { name: "A 对话操作", exact: true }).click();
    assert.equal(await menu.getByRole("menuitem", { name: "确认删除", exact: true }).count(), 0);
    await menu.getByRole("menuitem", { name: "删除", exact: true }).click();
    await menu.getByRole("menuitem", { name: "确认删除", exact: true }).press("Enter");
    await page.waitForFunction(() => document.querySelectorAll(".conversation-row").length === 1);
    assert.equal(await canvas.evaluate((node) => node.isConnected), true);
    const second = await page.evaluate(
      async () => (await window.desktop.application.getWorkspace()).conversations[0]?.id,
    );
    assert.ok(second);
    await page.getByRole("button", { name: "新建对话 对话操作", exact: true }).click();
    await page.getByRole("menuitem", { name: "归档对话", exact: true }).click();
    await page
      .locator(".sidebar-footer")
      .getByRole("button", { name: "已归档对话", exact: true })
      .click();
    const archives = page.getByRole("dialog", { name: "已归档对话", exact: true });
    await archives.getByRole("button", { name: "新建对话 归档操作", exact: true }).click();
    const archivedMenu = page.getByRole("menu", { name: "新建对话 归档操作", exact: true });
    await archivedMenu.getByRole("menuitem", { name: "删除", exact: true }).click();
    assert.equal(await archives.locator(".archive-row").count(), 1);
    await archivedMenu.getByRole("menuitem", { name: "确认删除", exact: true }).click();
    await archives.getByText("没有已归档对话。", { exact: true }).waitFor();
    await archives.getByRole("button", { name: "关闭弹窗", exact: true }).click();
    assert.deepEqual(
      (await page.evaluate(() => window.desktop.application.getWorkspace())).conversations,
      [],
    );
    await page.getByRole("button", { name: "新建对话", exact: true }).first().click();
    await page.getByRole("button", { name: "通用对话", exact: true }).click();
    await page.getByRole("menuitem", { name: /^场景搭建/ }).click();
    await page.getByRole("button", { name: "当前 STEP", exact: true }).click();
    await page.getByRole("button", { name: /^assemblies\/robot-arm.step/ }).click();
    assert.equal(
      await readFile(join(directory, "bracket.stp"), "utf8"),
      "STEP test placeholder; deliberately not parsed.",
    );
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    const ids = await page.evaluate(async () =>
      (await window.desktop.application.getWorkspace()).conversations.map((item) => item.id),
    );
    assert.equal(ids.length, 1);
    assert.ok(!ids.includes(first) && !ids.includes(second));
    await assert.rejects(
      page.evaluate((id) => window.desktop.application.watchConversation(id), first),
      /已删除/,
    );
  } finally {
    await app.close();
    await rm(profile, { recursive: true, force: true });
  }
});
