import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import packageInfo from "../../package.json" with { type: "json" };
import { launchTestApp, openTestProject, testElectronEnvironment } from "./support.ts";

test("startup writes the welcome message, draws the icon, and opens the workbench", async (context) => {
  const { page } = await launchTestApp(context);
  const workbench = page.getByRole("button", { name: "打开设置", exact: true });
  await workbench.waitFor();
  await page.waitForLoadState("load");
  await page.addInitScript(() => {
    const observer = new MutationObserver(() => {
      const title = document.querySelector(".startup-intro-title");
      if (!title) return;
      document.documentElement.dataset.startupTitle = title.textContent ?? "";
      const schedule = (selector: string) =>
        Array.from(document.querySelectorAll(selector), (element) => {
          const timing = element.getAnimations()[0]?.effect?.getTiming();
          const start = timing?.delay ?? 0;
          return timing && [start, start + Number(timing.duration)];
        });
      document.documentElement.dataset.startupSchedule = JSON.stringify({
        text: schedule(".startup-writing path"),
        icon: schedule(".startup-logo-outline :is(rect, path)"),
        exit: schedule(".startup-intro"),
      });
      observer.disconnect();
    });
    observer.observe(document, { childList: true, subtree: true });
  });

  const root = page.locator("html");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.reload();
  await page.locator("html[data-startup-schedule]").waitFor();
  await page.locator(".startup-intro").waitFor({ state: "detached" });
  await workbench.waitFor();
  assert.equal(
    await root.getAttribute("data-startup-title"),
    `Welcome to ${packageInfo.productName}`,
  );
  const timing = await root.getAttribute("data-startup-schedule");
  assert.ok(timing);
  const { text, icon, exit } = JSON.parse(timing) as Record<string, [number, number][]>;
  assert.ok(text && text.length > 20);
  assert.ok(icon && icon.length > 1);
  assert.ok(exit && exit.length === 1);
  const strokes = [...text, ...icon, ...exit];
  for (const [index, stroke] of strokes.entries()) {
    assert.ok(stroke, "Each stroke should have its own animation");
    const previous = strokes[index - 1];
    if (previous) assert.ok(stroke[0] >= previous[1], "Each stroke starts after the preceding one");
  }

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.reload();
  await workbench.waitFor();
  assert.equal(await root.getAttribute("data-startup-title"), null);
});

test("built desktop starts with an isolated renderer and shuts down its backend", {
  timeout: 30_000,
}, async (context) => {
  const { application, page, profile: userData } = await launchTestApp(context);
  const appProcess = application.process();
  await page
    .getByRole("button", { name: `应用信息，版本 ${packageInfo.version}`, exact: true })
    .waitFor();
  const state = await page.evaluate(async () => ({
    info: await window.desktop.getAppInfo(),
    hasNode: "require" in window || "process" in window,
    bridgeKeys: Object.keys(window.desktop).sort(),
    previewKeys: Object.keys(window.desktop.preview).sort(),
  }));
  assert.equal(state.info.name, packageInfo.productName);
  assert.equal(await page.title(), packageInfo.productName);
  assert.equal(await page.locator(".brand strong").textContent(), packageInfo.productName);
  assert.equal(state.info.version, packageInfo.version);
  assert.equal(state.hasNode, false);
  assert.deepEqual(state.bridgeKeys, [
    "application",
    "getAppInfo",
    "getThemes",
    "onBeforeQuit",
    "preview",
    "setTheme",
  ]);
  assert.deepEqual(state.previewKeys, ["control", "open", "openFile", "show", "subscribe"]);
  if (process.platform !== "darwin") {
    const menuVisible = await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.isMenuBarVisible(),
    );
    assert.equal(menuVisible, false);
  }
  const titlebar = page.locator(".app-layout .topbar");
  assert.equal(
    await titlebar.evaluate((element) => getComputedStyle(element).getPropertyValue("app-region")),
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
    ({ app }) => app.getAppMetrics().find((metric) => metric.name === "dai-studio-backend")?.pid,
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
  const secondary = spawn(appProcess.spawnfile, [process.cwd(), `--user-data-dir=${userData}`], {
    env: testElectronEnvironment(),
    stdio: "ignore",
  });
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
      .filter((metric) => metric.name === "dai-studio-backend")
      .map((metric) => metric.pid),
  }));
  assert.deepEqual(restored.windowIds, [windowId]);
  assert.deepEqual(restored.backendPids, [backendPid]);
  assert.equal(await composer.inputValue(), "关闭到托盘后保留草稿");
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
  await application.close();
  assert.equal(appProcess.exitCode, 0);
  assert.throws(() => globalThis.process.kill(backendPid, 0), { code: "ESRCH" });
});
