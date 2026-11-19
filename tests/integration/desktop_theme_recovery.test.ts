import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { _electron as electron } from "playwright";
import { openApplication } from "../../src/backend/application.ts";
import { createPackageService } from "../../src/backend/extensions/package_service.ts";
import { REQUEST_CHANNEL, THEMES_CHANNEL } from "../../src/contracts/desktop.ts";
import { runPackageAction, waitForCatalogTask } from "../support/catalog_task.ts";
import { createThemePackage } from "../support/desktop_theme.ts";

async function openThemeApp() {
  const root = await mkdtemp(join(tmpdir(), "dai-theme-recovery-"));
  const profile = join(root, "profile");
  const dataRoot = join(profile, "data");
  const source = join(root, "theme");
  if (process.env.DAI_TEST_THEME_PACKAGE) {
    await mkdir(source);
    for (const path of ["package.json", "palettes"])
      await cp(join(process.env.DAI_TEST_THEME_PACKAGE, path), join(source, path), {
        recursive: true,
      });
  } else await createThemePackage(source);
  const manifest = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
  const declaration = manifest.dai.themes[0];
  const id = `${manifest.name}:${declaration.id}`;
  const seed = await openApplication({ dataRoot, publish: () => {} });
  try {
    await runPackageAction(seed, { action: "install", host: "desktop", source, scope: "global" });
    await seed.request("settings.update", { desktopTheme: id });
  } finally {
    await seed.close();
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
  const page = await app.firstWindow();
  page.setDefaultTimeout(10_000);
  await page.waitForFunction((id) => document.documentElement.dataset.daiTheme === id, id);
  return {
    app,
    page,
    dataRoot,
    source,
    id,
    light: declaration.light as string,
    refresh: () =>
      page.evaluate(() => {
        dispatchEvent(new Event("focus"));
      }),
    selected: () =>
      page.evaluate(
        async () => (await window.desktop.application.getWorkspace()).settings.desktopTheme,
      ),
    async close() {
      await app.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("公司目录及来源关联损坏不影响 Desktop 主题发现和选择", { timeout: 30_000 }, async () => {
  const fixture = await openThemeApp();
  const { page, dataRoot, id } = fixture;
  try {
    const root = join(dataRoot, "catalog");
    await mkdir(root, { recursive: true });
    for (const name of ["sources.json", "origins.json"]) {
      const path = join(root, name);
      await writeFile(path, "{");
      await assert.rejects(
        page.evaluate(() => window.desktop.application.installedPlugins()),
        /目录配置损坏/,
      );
      const state = await page.evaluate((id) => window.desktop.getThemes(id), id);
      assert.equal(state.selection, "available");
      await page.evaluate(
        (desktopTheme) => window.desktop.application.updateSettings({ desktopTheme }),
        id,
      );
      await fixture.refresh();
      assert.equal(await fixture.selected(), id);
      assert.equal(await page.evaluate(() => document.documentElement.dataset.daiTheme), id);
      await rm(path);
    }
    assert.equal(await page.locator(".bridge-error").count(), 0);
  } finally {
    await fixture.close();
  }
});

test("配色或清单暂时缺失时保留选择，资源恢复后重新应用", { timeout: 30_000 }, async () => {
  const fixture = await openThemeApp();
  const { page, source, id } = fixture;
  try {
    for (const name of [fixture.light, "package.json"]) {
      const path = join(source, name);
      await rename(path, `${path}.updating`);
      await fixture.refresh();
      await page.waitForFunction(() => !document.documentElement.dataset.daiTheme);
      assert.equal(await fixture.selected(), id);
      assert.equal(
        (await page.evaluate((id) => window.desktop.getThemes(id), id)).selection,
        "error",
      );
      await rename(`${path}.updating`, path);
      await fixture.refresh();
      await page.waitForFunction((id) => document.documentElement.dataset.daiTheme === id, id);
      assert.equal(await fixture.selected(), id);
    }
    // 暂时回退时，用户仍能明确选择默认主题；资源恢复不能覆盖这个新偏好。
    const palette = join(source, fixture.light);
    await rename(palette, `${palette}.updating`);
    await fixture.refresh();
    await page.waitForFunction(() => !document.documentElement.dataset.daiTheme);
    await page.getByRole("button", { name: "打开设置", exact: true }).click();
    await page.getByRole("button", { name: "主题方案", exact: true }).click();
    await page.getByRole("menuitemradio", { name: "Dai Studio 默认", exact: true }).click();
    await page.waitForFunction(
      async () => !(await window.desktop.application.getWorkspace()).settings.desktopTheme,
    );
    await page
      .getByText("主题资源暂不可用，暂用默认外观并保留原选择。", { exact: true })
      .waitFor({ state: "hidden" });
    await rename(`${palette}.updating`, palette);
    await fixture.refresh();
    assert.equal(await fixture.selected(), "");
  } finally {
    await fixture.close();
  }
});

test("读取失败恢复后清除主题错误提示，并保留原来的主题选择", { timeout: 30_000 }, async () => {
  const fixture = await openThemeApp();
  const { page, dataRoot, id } = fixture;
  try {
    const path = join(dataRoot, "desktop/packages/disabled.json");
    // 默认启用无需创建禁用文件；故障注入后恢复为空列表即可。
    await writeFile(path, "{}");
    await fixture.refresh();
    await page.getByText("桌面主题读取失败，可继续使用默认外观。", { exact: true }).waitFor();
    await page.waitForFunction(() => !document.documentElement.dataset.daiTheme);
    assert.equal(await fixture.selected(), id);
    await writeFile(path, "[]");
    await fixture.refresh();
    await page.waitForFunction((id) => document.documentElement.dataset.daiTheme === id, id);
    await page
      .getByText("桌面主题读取失败，可继续使用默认外观。", { exact: true })
      .waitFor({ state: "hidden" });
    assert.equal(await fixture.selected(), id);
  } finally {
    await fixture.close();
  }
});

type ThemeRace = {
  missingRead: boolean;
  holdWorkspace: boolean;
  workspaceHeld: number;
  fallbacks: number;
  releaseMissing(): void;
  releaseWorkspace(): void;
};

test("工作区响应延迟时，旧主题的回退不能覆盖已经保存的新主题", { timeout: 30_000 }, async () => {
  const fixture = await openThemeApp();
  const { app, page, dataRoot, id } = fixture;
  const second = join(fixture.source, "../second");
  const secondId = "second-desktop-theme:paper";
  try {
    await createThemePackage(second);
    const path = join(second, "package.json");
    const manifest = JSON.parse(await readFile(path, "utf8"));
    manifest.name = "second-desktop-theme";
    await writeFile(path, JSON.stringify(manifest));
    const task = await page.evaluate(
      (source) =>
        window.desktop.application.packageAction({
          source,
          host: "desktop",
          scope: "global",
          action: "install",
        }),
      second,
    );
    assert.equal(
      (
        await waitForCatalogTask(
          () => page.evaluate(() => window.desktop.application.catalogTasks()),
          task.id,
        )
      ).state,
      "completed",
    );

    // 只控制 IPC 响应顺序，主题发现、设置写入和 React 恢复均运行生产实现。
    await app.evaluate(
      ({ ipcMain }, channels) => {
        const state: ThemeRace = {
          missingRead: false,
          holdWorkspace: false,
          workspaceHeld: 0,
          fallbacks: 0,
          releaseMissing() {},
          releaseWorkspace() {},
        };
        Object.assign(globalThis, { themeRace: state });
        const missingGate = new Promise<void>((resolve) => {
          state.releaseMissing = resolve;
        });
        const workspaceGate = new Promise<void>((resolve) => {
          state.releaseWorkspace = resolve;
        });
        const handlers = (
          ipcMain as unknown as {
            _invokeHandlers: Map<string, Parameters<typeof ipcMain.handle>[1]>;
          }
        )._invokeHandlers;
        const themes = handlers.get(channels.themes);
        const request = handlers.get(channels.request);
        if (!themes || !request) throw new Error("Desktop IPC 未注册。");
        ipcMain.removeHandler(channels.themes);
        ipcMain.handle(channels.themes, async (...args) => {
          const result = await themes(...args);
          if (result.selection === "missing") {
            state.missingRead = true;
            await missingGate;
          }
          return result;
        });
        ipcMain.removeHandler(channels.request);
        ipcMain.handle(channels.request, async (event, method, args) => {
          const result = await request(event, method, args);
          if (method === "settings.update" && args.desktopTheme === "") state.fallbacks++;
          if (method === "workspace.get" && state.holdWorkspace) {
            state.workspaceHeld++;
            await workspaceGate;
          }
          return result;
        });
      },
      { themes: THEMES_CHANNEL, request: REQUEST_CHANNEL },
    );

    async function waitForGate(key: "missingRead" | "workspaceHeld" | "fallbacks") {
      await app.evaluate(async (_, key) => {
        const state = (globalThis as unknown as { themeRace: ThemeRace }).themeRace;
        const deadline = Date.now() + 5_000;
        while (!state[key]) {
          if (Date.now() > deadline) throw new Error(`未收到 ${key}。`);
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }, key);
    }

    await createPackageService({ dataRoot, host: "desktop" }).setEnabled(
      fixture.source,
      "global",
      false,
    );
    await fixture.refresh();
    await waitForGate("missingRead");
    await app.evaluate(() => {
      (globalThis as unknown as { themeRace: ThemeRace }).themeRace.holdWorkspace = true;
    });
    await page.evaluate(
      (desktopTheme) => window.desktop.application.updateSettings({ desktopTheme }),
      secondId,
    );
    await waitForGate("workspaceHeld");
    await app.evaluate(() => {
      (globalThis as unknown as { themeRace: ThemeRace }).themeRace.releaseMissing();
    });
    await waitForGate("fallbacks");
    const saved = JSON.parse(await readFile(join(dataRoot, "desktop/settings.json"), "utf8"));
    assert.equal(saved.desktopTheme, secondId);
    assert.notEqual(saved.desktopTheme, id);
    await app.evaluate(() => {
      const state = (globalThis as unknown as { themeRace: ThemeRace }).themeRace;
      state.holdWorkspace = false;
      state.releaseWorkspace();
    });
    await page.waitForFunction((id) => document.documentElement.dataset.daiTheme === id, secondId);
    assert.equal(await fixture.selected(), secondId);
  } finally {
    await app.evaluate(() => {
      const state = (globalThis as unknown as { themeRace?: ThemeRace }).themeRace;
      state?.releaseMissing();
      state?.releaseWorkspace();
    });
    await fixture.close();
  }
});
