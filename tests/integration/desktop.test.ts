import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { type ElectronApplication, _electron as electron } from "playwright";
import packageInfo from "../../package.json" with { type: "json" };
import { openTestProject } from "./support.ts";

test("built desktop starts with an isolated renderer and shuts down its backend", {
  timeout: 30_000,
}, async () => {
  const userData = await mkdtemp(join(tmpdir(), "daidai-pi-smoke-"));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== "ELECTRON_RUN_AS_NODE") env[key] = value;
  }
  let application: ElectronApplication | undefined;
  let appProcess: ChildProcess | undefined;
  try {
    application = await electron.launch({
      args: [fileURLToPath(new URL("../../", import.meta.url)), `--user-data-dir=${userData}`],
      env,
      chromiumSandbox: true,
    });
    appProcess = application.process();
    const page = await application.firstWindow();
    await page
      .getByRole("button", { name: `应用信息，版本 ${packageInfo.version}`, exact: true })
      .waitFor();
    const state = await page.evaluate(async () => ({
      info: await window.desktop.getAppInfo(),
      hasNode: "require" in window || "process" in window,
      bridgeKeys: Object.keys(window.desktop).sort(),
    }));
    assert.equal(state.info.name, "daidai_pi");
    assert.equal(state.info.version, packageInfo.version);
    assert.equal(state.hasNode, false);
    assert.deepEqual(state.bridgeKeys, ["application", "getAppInfo", "onBeforeQuit", "setTheme"]);
    if (process.platform !== "darwin") {
      const menuVisible = await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]?.isMenuBarVisible(),
      );
      assert.equal(menuVisible, false);
    }
    const titlebar = page.locator(".app-layout .topbar");
    assert.equal(
      await titlebar.evaluate((element) =>
        getComputedStyle(element).getPropertyValue("app-region"),
      ),
      "drag",
    );
    assert.equal(
      await page
        .getByRole("button", { name: "打开设置", exact: true })
        .evaluate((element) => getComputedStyle(element).getPropertyValue("app-region")),
      "no-drag",
    );
    if (process.platform === "darwin") {
      const hasQuit = await application.evaluate(({ Menu }) =>
        Menu.getApplicationMenu()?.items.some((item) =>
          item.submenu?.items.some((child) => child.role === "quit"),
        ),
      );
      assert.equal(hasQuit, true, "macOS must retain the native Quit menu and Cmd+Q.");
    } else {
      await page.waitForFunction(() => navigator.windowControlsOverlay?.visible);
      const safeArea = await page.evaluate(() =>
        navigator.windowControlsOverlay?.getTitlebarAreaRect().toJSON(),
      );
      const settingsButton = await page.getByRole("button", { name: "打开设置" }).boundingBox();
      assert.ok(safeArea && settingsButton);
      assert.ok(settingsButton.x >= safeArea.x);
      assert.ok(settingsButton.x + settingsButton.width <= safeArea.right);
    }
    await assert.rejects(
      page.evaluate(() => Reflect.apply(window.desktop.setTheme, window.desktop, ["invalid"])),
      /Invalid application theme/,
    );
    await page.getByRole("button", { name: "打开设置", exact: true }).click();
    await page.getByRole("button", { name: "主题", exact: true }).click();
    await page.getByRole("menuitemradio", { name: "深色", exact: true }).click();
    const darkTheme = await application.evaluate(
      ({ nativeTheme }) =>
        new Promise<string>((resolve) => {
          const updated = () => {
            if (nativeTheme.themeSource !== "dark") return;
            nativeTheme.removeListener("updated", updated);
            resolve(nativeTheme.themeSource);
          };
          nativeTheme.on("updated", updated);
          updated();
        }),
    );
    assert.equal(darkTheme, "dark");
    assert.equal(
      await page
        .locator(".settings-main .topbar")
        .evaluate((element) => getComputedStyle(element).getPropertyValue("app-region")),
      "drag",
    );
    await page.getByRole("button", { name: "主题", exact: true }).click();
    await page.getByRole("menuitemradio", { name: "浅色", exact: true }).click();
    await page.getByRole("button", { name: "返回工作台" }).click();
    const sandboxDisabled = await application.evaluate(({ app }) =>
      app.commandLine.hasSwitch("no-sandbox"),
    );
    assert.equal(sandboxDisabled, false);
    const backendPid = await application.evaluate(
      ({ app }) => app.getAppMetrics().find((metric) => metric.name === "daidai-pi-backend")?.pid,
    );
    assert.ok(backendPid, "The Node backend must run as a separate process.");
    await openTestProject(application, page, userData);
    const composer = page.locator("textarea").first();
    await composer.fill("关闭到托盘后保留草稿");
    const hidden = await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) throw new Error("Main window is missing.");
      window.close();
      return !window.isDestroyed() && !window.isVisible();
    });
    assert.equal(hidden, true, "Closing the window must hide it in the tray.");
    assert.equal(await composer.inputValue(), "关闭到托盘后保留草稿");
    globalThis.process.kill(backendPid, 0);
    const windowId = await application.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.id,
    );
    const secondary = spawn(
      appProcess.spawnfile,
      [fileURLToPath(new URL("../../", import.meta.url)), `--user-data-dir=${userData}`],
      { env, stdio: "ignore" },
    );
    try {
      const [exitCode] = await once(secondary, "exit", {
        signal: AbortSignal.timeout(10_000),
      });
      assert.equal(exitCode, 0, "A second launch must exit without starting another app.");
    } finally {
      if (secondary.exitCode === null) secondary.kill();
    }
    await page.waitForFunction(() => document.visibilityState === "visible");
    const restored = await application.evaluate(({ app, BrowserWindow }) => ({
      windowIds: BrowserWindow.getAllWindows().map((window) => window.id),
      backendPids: app
        .getAppMetrics()
        .filter((metric) => metric.name === "daidai-pi-backend")
        .map((metric) => metric.pid),
    }));
    assert.deepEqual(restored.windowIds, [windowId]);
    assert.deepEqual(restored.backendPids, [backendPid]);
    assert.equal(await composer.inputValue(), "关闭到托盘后保留草稿");
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
    await application.close();
    assert.equal(appProcess.exitCode, 0);
    assert.throws(() => globalThis.process.kill(backendPid, 0), { code: "ESRCH" });
  } finally {
    if (application && appProcess?.exitCode === null) await application.close();
    await rm(userData, { recursive: true, force: true });
  }
});
