import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { _electron as electron } from "playwright";
import packageInfo from "../../package.json" with { type: "json" };
import { chooseProject, openTestProject } from "./support.ts";

test("menus and shortcuts preserve drafts, respect dialogs and fit narrow windows", {
  timeout: 60_000,
}, async () => {
  const userData = await mkdtemp(join(tmpdir(), "dai-controls-"));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[0] !== "ELECTRON_RUN_AS_NODE" && entry[1] !== undefined,
    ),
  );
  const application = await electron.launch({
    args: [process.cwd(), `--user-data-dir=${userData}`],
    env,
    chromiumSandbox: true,
  });
  const processHandle = application.process();
  try {
    const page = await application.firstWindow();
    page.setDefaultTimeout(5000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await page
      .getByRole("button", { name: `应用信息，版本 ${packageInfo.version}`, exact: true })
      .waitFor();
    const footer = page.locator(".sidebar-footer");
    // Keyboard focus avoids native pointer interference from other Electron tests.
    await footer.getByRole("button", { name: "设置", exact: true }).focus();
    await page.getByRole("tooltip").filter({ hasText: "设置" }).waitFor();
    await footer.getByRole("button", { name: "插件与技能", exact: true }).click();
    await page.getByRole("heading", { name: "插件与技能", exact: true }).waitFor();
    await page.getByRole("button", { name: "返回工作台", exact: true }).click();
    await footer.getByRole("button", { name: "已归档对话", exact: true }).click();
    await page.getByRole("dialog", { name: "已归档对话", exact: true }).waitFor();
    await page.getByRole("button", { name: "关闭弹窗", exact: true }).click();
    await footer
      .getByRole("button", { name: `应用信息，版本 ${packageInfo.version}`, exact: true })
      .click();
    await page.getByRole("heading", { name: "信息", exact: true }).waitFor();
    await page.getByRole("button", { name: "返回工作台", exact: true }).click();
    await openTestProject(application, page, userData);
    const message = page.getByRole("textbox", { name: "消息内容" });
    await message.fill("保留这段草稿");
    const zoom = () =>
      application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]?.webContents.getZoomFactor(),
      );
    // CDP keyboard events bypass Electron's before-input-event; use its native input API.
    const zoomKey = (key: string) =>
      application.evaluate(({ BrowserWindow }, keyCode) => {
        const contents = BrowserWindow.getAllWindows()[0]?.webContents;
        const modifiers: ("meta" | "control")[] = [
          process.platform === "darwin" ? "meta" : "control",
        ];
        contents?.sendInputEvent({ type: "keyDown", keyCode, modifiers });
        contents?.sendInputEvent({ type: "keyUp", keyCode, modifiers });
      }, key);
    await zoomKey("=");
    assert.equal(await zoom(), 1.1);
    await zoomKey("+");
    assert.equal(await zoom(), 1.2);
    await zoomKey("-");
    assert.equal(await zoom(), 1.1);
    await zoomKey("numadd");
    assert.equal(await zoom(), 1.2);
    await zoomKey("numsub");
    assert.equal(await zoom(), 1.1);
    for (let index = 0; index < 10; index++) await zoomKey("=");
    assert.equal(await zoom(), 1.2);
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setContentSize(840, 640),
    );
    await page.waitForFunction(() => innerWidth < 750);
    const enlargedLayout = await page.evaluate(() => {
      const input = document.querySelector(".composer")?.getBoundingClientRect();
      return {
        overflow: document.documentElement.scrollWidth > innerWidth,
        inputVisible: !!input && input.top >= 0 && input.bottom <= innerHeight,
      };
    });
    assert.deepEqual(enlargedLayout, { overflow: false, inputVisible: true });
    if (process.platform !== "darwin") {
      const titlebar = await page.evaluate(() => ({
        actual: document.querySelector(".app-layout .topbar")?.getBoundingClientRect().height,
        native: navigator.windowControlsOverlay?.getTitlebarAreaRect().height,
      }));
      assert.equal(
        titlebar.actual,
        titlebar.native,
        "Zoom must preserve the native titlebar height.",
      );
    }
    for (let index = 0; index < 10; index++) await zoomKey("-");
    assert.equal(await zoom(), 0.6);
    await zoomKey("0");
    assert.equal(await zoom(), 1);
    assert.equal(await message.inputValue(), "保留这段草稿");
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setContentSize(1200, 800),
    );
    await page.keyboard.press("ControlOrMeta+Comma");
    await page.getByRole("heading", { name: "常规", exact: true }).waitFor();
    await page.getByRole("button", { name: "主题", exact: true }).press("ArrowDown");
    await page.getByRole("menuitemradio", { name: "跟随系统", exact: true }).press("End");
    await page.waitForFunction(() => document.activeElement?.textContent?.startsWith("深色"));
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
    await page.keyboard.press("ControlOrMeta+Slash");
    await page.getByRole("heading", { name: "快捷键", exact: true }).waitFor();
    await page.keyboard.press("ControlOrMeta+KeyL");
    await message.waitFor();
    await page.waitForFunction(
      () => document.activeElement?.getAttribute("aria-label") === "消息内容",
    );
    assert.equal(await message.inputValue(), "保留这段草稿");
    assert.equal(await message.evaluate((element) => element === document.activeElement), true);

    const model = page.getByRole("button", { name: "选择模型", exact: true });
    await model.click();
    const menu = page.getByRole("menu", { name: "选择模型", exact: true });
    const menuBox = await menu.boundingBox();
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    assert.ok(menuBox && menuBox.y >= 0 && menuBox.y + menuBox.height <= viewport.height);
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "hidden" });
    // Radix restores focus after menu unmount; invisibility can precede it.
    await page.waitForFunction(
      () => document.activeElement?.getAttribute("aria-label") === "选择模型",
    );
    assert.equal(await model.evaluate((element) => element === document.activeElement), true);
    await model.click();
    // Coding 的聊天区较窄，菜单可能覆盖输入框中心；点击仍可见的左上角来验证外部关闭。
    await message.click({ position: { x: 5, y: 5 } });
    await menu.waitFor({ state: "hidden" });

    assert.equal(await page.getByRole("button", { name: "通用对话", exact: true }).count(), 0);
    await chooseProject(application, page, join(userData, "project"), "coding");
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setContentSize(840, 640),
    );
    await page
      .getByRole("tablist", { name: "工作区视图" })
      .getByRole("tab", { name: "聊天", exact: true })
      .click();
    await model.click();
    const conversationsBefore = await page.locator(".conversation-row").count();
    await page.keyboard.press("ControlOrMeta+KeyN");
    assert.equal(await page.locator(".conversation-row").count(), conversationsBefore);
    const narrowMenu = await menu.boundingBox();
    assert.ok(narrowMenu && narrowMenu.x >= 0 && narrowMenu.x + narrowMenu.width <= 840);
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "hidden" });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    const toolbarFits = await page.locator(".composer-toolbar").evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return Array.from(element.querySelectorAll("button")).every((button) => {
        const rect = button.getBoundingClientRect();
        return rect.x >= bounds.x && rect.right <= bounds.right;
      });
    });
    assert.equal(toolbarFits, true);
    await page.keyboard.press("ControlOrMeta+KeyB");
    await page.locator(".sidebar").waitFor({ state: "hidden" });
    await page.keyboard.press("ControlOrMeta+KeyB");
    await page.locator(".sidebar").waitFor({ state: "visible" });
    await page.keyboard.press("ControlOrMeta+KeyN");
    await page.waitForFunction(
      (count) => document.querySelectorAll(".conversation-row").length === count,
      conversationsBefore + 1,
    );

    // A custom selection alone must activate the existing unsaved-change guard.
    await page.keyboard.press("ControlOrMeta+Comma");
    await page.getByRole("button", { name: "AI 设置", exact: true }).click();
    await page.getByRole("button", { name: "添加 AI 服务", exact: true }).click();
    await page.getByRole("button", { name: "模型提供方", exact: true }).click();
    await page.keyboard.press("Escape");
    await page.getByRole("menu").waitFor({ state: "hidden" });
    assert.equal(await page.getByRole("dialog", { name: "添加 AI 服务", exact: true }).count(), 1);
    await page.getByRole("button", { name: "模型提供方", exact: true }).click();
    await page.getByRole("menuitemradio", { name: "本地 OpenAI Compatible", exact: true }).click();
    await page.getByRole("button", { name: "关闭弹窗", exact: true }).click();
    await page.getByRole("button", { name: "继续编辑", exact: true }).click();
    await page.getByRole("button", { name: "模型提供方", exact: true }).waitFor();
    await page.getByRole("button", { name: "关闭弹窗", exact: true }).click();
    await page.getByRole("button", { name: "放弃修改", exact: true }).click();
    await page.getByRole("button", { name: "插件与技能", exact: true }).click();
    await page.getByRole("tab", { name: "我的技能", exact: true }).click();
    await page.getByRole("heading", { name: "我的技能", exact: true }).waitFor();
    await page.getByRole("button", { name: "新建技能", exact: true }).click();
    await page.getByRole("dialog", { name: "新建技能" }).waitFor();
    await page.getByRole("button", { name: "关闭弹窗", exact: true }).click();
    assert.deepEqual(errors, [], "Controls must preserve the existing CSP without runtime errors.");
  } finally {
    if (processHandle.exitCode === null) await application.close();
    await rm(userData, { recursive: true, force: true });
  }
});
