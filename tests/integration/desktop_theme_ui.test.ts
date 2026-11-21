import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createThemePackage } from "../support/desktop_theme.ts";
import { launchElectron, openTestProject } from "./support.ts";

test("真实桌面可安装主题、切换浅深色、重启恢复，并在停用/移除后恢复默认", {
  timeout: 90_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-theme-ui-"));
  const screenshots = await mkdtemp(join(tmpdir(), "dai-theme-ui-screenshots-"));
  const profile = join(root, "profile");
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
  let app = await launchElectron(profile);
  try {
    let page = await app.firstWindow();
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.getByRole("button", { name: "打开设置", exact: true }).click();
    await page.getByRole("button", { name: "插件与技能", exact: true }).click();
    await page.getByRole("button", { name: "手动安装", exact: true }).click();
    await page.getByLabel("包来源").fill(source);
    await page.getByRole("button", { name: "插件类型", exact: true }).click();
    await page.getByRole("menuitemradio", { name: "桌面插件", exact: true }).click();
    await page.getByRole("button", { name: "继续安装", exact: true }).click();
    await page.getByRole("button", { name: "确认安装", exact: true }).click();
    await page.getByRole("tab", { name: /已安装/ }).click();
    let row = page.locator(".plugin-installed-row").filter({ hasText: manifest.name });
    await row.getByText("主题可用", { exact: true }).waitFor();
    await row.getByRole("button", { name: "选择主题", exact: true }).click();
    await page.getByRole("button", { name: "主题方案", exact: true }).click();
    await page.getByRole("menuitemradio", { name: declaration.label, exact: true }).click();
    await page.waitForFunction((id) => document.documentElement.dataset.daiTheme === id, id);

    for (const mode of ["light", "dark"] as const) {
      const palette = JSON.parse(await readFile(join(source, declaration[mode]), "utf8"));
      await page.getByRole("button", { name: "主题", exact: true }).click();
      await page
        .getByRole("menuitemradio", { name: mode === "light" ? "浅色" : "深色", exact: true })
        .click();
      await page.waitForFunction((mode) => document.documentElement.dataset.theme === mode, mode);
      assert.equal(
        await page.evaluate(() =>
          getComputedStyle(document.documentElement).getPropertyValue("--surface").trim(),
        ),
        palette.variables["--surface"],
      );
      const background = await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]?.getBackgroundColor(),
      );
      assert.ok(
        background?.toLowerCase().endsWith(palette.variables["--surface"].slice(1)),
        background,
      );
      for (const width of [840, 1200, 1600]) {
        await app.evaluate(
          ({ BrowserWindow }, width) =>
            BrowserWindow.getAllWindows()[0]?.setContentSize(width, 900),
          width,
        );
        await page.waitForFunction((width) => innerWidth === width, width);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false,
        );
        await page.screenshot({ path: join(screenshots, `settings_${mode}_${width}.png`) });
      }
    }
    await page.getByRole("button", { name: "主题", exact: true }).click();
    await page.getByRole("menuitemradio", { name: "跟随系统", exact: true }).click();
    assert.equal(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource), "system");
    await app.close();
    app = await launchElectron(profile);
    page = await app.firstWindow();
    page.setDefaultTimeout(15_000);
    page.on("pageerror", (error) => errors.push(error.message));
    await page.waitForFunction((id) => document.documentElement.dataset.daiTheme === id, id);
    const workspace = await page.evaluate(() => window.desktop.application.getWorkspace());
    assert.equal(workspace.settings.desktopTheme, id);
    assert.equal(workspace.settings.theme, "system");

    await openTestProject(app, page, profile);
    for (const mode of ["light", "dark"] as const) {
      await page.evaluate((theme) => window.desktop.application.updateSettings({ theme }), mode);
      await page.waitForFunction((mode) => document.documentElement.dataset.theme === mode, mode);
      await page.screenshot({ path: join(screenshots, `chat_${mode}.png`) });
    }
    await page.getByRole("button", { name: "打开设置", exact: true }).click();
    await page.getByRole("button", { name: "插件与技能", exact: true }).click();
    await page.getByRole("tab", { name: /已安装/ }).click();
    row = page.locator(".plugin-installed-row").filter({ hasText: manifest.name });
    await row.getByRole("button", { name: "停用", exact: true }).click();
    await page.waitForFunction(() => !document.documentElement.hasAttribute("data-dai-theme"));
    await row.getByRole("button", { name: "启用", exact: true }).click();
    await row.getByText("主题可用", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.daiTheme), undefined);
    await row.getByRole("button", { name: "选择主题", exact: true }).click();
    await page.getByRole("button", { name: "主题方案", exact: true }).click();
    await page.getByRole("menuitemradio", { name: declaration.label, exact: true }).click();
    await page.waitForFunction((id) => document.documentElement.dataset.daiTheme === id, id);
    await page.getByRole("button", { name: "插件与技能", exact: true }).click();
    await page.getByRole("tab", { name: /已安装/ }).click();
    await row.getByRole("button", { name: "移除", exact: true }).click();
    await page.getByRole("button", { name: "确认移除", exact: true }).click();
    await page.waitForFunction(() => !document.documentElement.hasAttribute("data-dai-theme"));
    assert.equal(await page.evaluate(() => document.documentElement.style.length), 0);
    assert.deepEqual(errors, []);
    console.log(`Theme UI screenshots: ${screenshots}`);
  } catch (error) {
    const page = await app.firstWindow();
    await page.screenshot({ path: join(screenshots, "failure.png") }).catch(() => {});
    console.error(
      await page
        .evaluate(async () => {
          const state = await window.desktop.getThemes();
          return {
            themes: state.themes.map((theme) => theme.id),
            errors: state.errors,
            rows: document.querySelector(".plugin-center")?.textContent,
          };
        })
        .catch(() => "无法读取桌面状态"),
    );
    console.error(`Theme UI screenshots: ${screenshots}`);
    throw error;
  } finally {
    await app.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
