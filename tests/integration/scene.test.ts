import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { _electron as electron } from "playwright";
import { openTestProject } from "./support.ts";

test("scene mode keeps a read-only viewport and STEP selection without legacy editing APIs", {
  timeout: 30_000,
}, async () => {
  const profile = await mkdtemp(join(tmpdir(), "dai-viewer-cleanup-"));
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
    page.setDefaultTimeout(7000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setContentSize(1400, 900),
    );
    await openTestProject(app, page, profile);
    await page.getByRole("button", { name: "通用对话", exact: true }).click();
    await page.getByRole("menuitem", { name: /^场景搭建/ }).click();
    await page.getByLabel("三维场景视图", { exact: true }).waitFor();
    const tabs = page.getByRole("tablist", { name: "工作区视图", includeHidden: true });
    assert.equal(await tabs.isVisible(), false);
    assert.equal(await page.locator('.scene-stage[data-scene-loaded="false"]').count(), 1);
    for (const name of ["体验三维示例", "解析选中的 STEP", "导出 URDF", "暂存示例", "创建关节"])
      assert.equal(await page.getByRole("button", { name, exact: true }).count(), 0);
    assert.equal(await page.getByLabel("对象颜色", { exact: true }).count(), 0);
    const methods = await page.evaluate(() => Object.keys(window.desktop.application));
    for (const name of [
      "getScene",
      "applySceneCommand",
      "importScene",
      "exportScene",
      "revealExport",
      "restoreScene",
    ])
      assert.equal(methods.includes(name), false);
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
    assert.equal(await canvas.evaluate((node) => node.isConnected), true);
    await page.getByRole("button", { name: "视角", exact: true }).click();
    await page.getByRole("menuitem", { name: "前视图", exact: true }).click();
    await page.getByRole("button", { name: "网格", exact: true }).click();
    assert.equal(
      await page.getByRole("button", { name: "网格", exact: true }).getAttribute("aria-pressed"),
      "false",
    );
    await page.getByRole("button", { name: "场景搭建", exact: true }).click();
    await page.getByRole("menuitem", { name: /^通用对话/ }).click();
    await page
      .getByRole("region", { name: "场景工作区", exact: true })
      .waitFor({ state: "hidden" });
    assert.equal(await canvas.evaluate((node) => node.isConnected), true);
    await page.getByRole("button", { name: "通用对话", exact: true }).click();
    await page.getByRole("menuitem", { name: /^场景搭建/ }).click();
    await page.getByRole("region", { name: "场景工作区", exact: true }).waitFor();
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setContentSize(1000, 900),
    );
    await tabs.waitFor();
    await page.getByRole("tab", { name: "聊天", exact: true }).click();
    await page.getByRole("textbox", { name: "消息内容", exact: true }).waitFor();
    assert.equal(await page.getByRole("region", { name: "场景工作区" }).isVisible(), false);
    await page.getByRole("tab", { name: "场景", exact: true }).click();
    await page.getByRole("region", { name: "场景工作区", exact: true }).waitFor();
    assert.equal(await canvas.evaluate((node) => node.isConnected), true);
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setContentSize(1400, 900),
    );
    await tabs.waitFor({ state: "hidden" });
    await page.screenshot({ path: resolve("out/cleanup-viewer.png") });
    assert.deepEqual(errors, []);
  } finally {
    await app.close();
    await rm(profile, { recursive: true, force: true });
  }
});
