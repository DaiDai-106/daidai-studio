import assert from "node:assert/strict";
import { test } from "node:test";
import { launchTestApp } from "./support.ts";

test("AI 设置保持简洁，添加服务按钮适配浅色和深色主题", { timeout: 60_000 }, async (context) => {
  const { page } = await launchTestApp(context);
  page.setDefaultTimeout(15_000);
  await page.getByRole("button", { name: "打开设置", exact: true }).click();
  for (const [theme, label] of [
    ["light", "浅色"],
    ["dark", "深色"],
  ] as const) {
    await page.getByRole("button", { name: "常规", exact: true }).click();
    await page.getByRole("button", { name: "主题", exact: true }).click();
    await page.getByRole("menuitemradio", { name: label, exact: true }).click();
    await page.waitForFunction((value) => document.documentElement.dataset.theme === value, theme);
    await page.getByRole("button", { name: "AI 设置", exact: true }).click();

    const add = page.getByRole("button", { name: "添加 AI 服务", exact: true });
    assert.equal(await add.isVisible(), true);
    assert.equal(await page.getByRole("button", { name: "默认模型" }).isVisible(), true);
    const colors = await add.evaluate((element) => {
      const style = getComputedStyle(element);
      const rgb = (color: string) => color.match(/\d+/g)?.slice(0, 3).map(Number) ?? [];
      const luminance = (channels: number[]) => {
        const [r = 0, g = 0, b = 0] = channels.map((channel) => {
          const value = channel / 255;
          return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      return {
        foreground: luminance(rgb(style.color)),
        background: luminance(rgb(style.backgroundColor)),
      };
    });
    assert.ok(theme === "dark" ? colors.background < 0.3 : colors.background > 0.5);
    assert.ok(
      (Math.max(colors.foreground, colors.background) + 0.05) /
        (Math.min(colors.foreground, colors.background) + 0.05) >=
        4.5,
    );
    await add.click();
    const dialog = page.getByRole("dialog", { name: "添加 AI 服务", exact: true });
    await dialog.waitFor();
    await dialog.getByRole("button", { name: "关闭弹窗", exact: true }).click();
  }
});
