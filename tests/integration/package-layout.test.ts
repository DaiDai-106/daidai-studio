import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { _electron as electron } from "playwright";

test("扩展包表单在浅色、深色及窄窗口中保持清晰可操作", { timeout: 60_000 }, async () => {
  const profile = await mkdtemp(join(tmpdir(), "dai-package-layout-"));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[0] !== "ELECTRON_RUN_AS_NODE" && entry[1] !== undefined,
    ),
  );
  const application = await electron.launch({
    args: [process.cwd(), `--user-data-dir=${profile}`],
    env,
    chromiumSandbox: true,
  });

  try {
    const page = await application.firstWindow();
    page.setDefaultTimeout(15_000);
    await page.getByRole("button", { name: "打开设置", exact: true }).click();
    await page.getByRole("button", { name: "工具与技能", exact: true }).click();
    const source = page.getByLabel("包来源");
    const scope = page.getByRole("button", { name: "范围" });
    const install = page.getByRole("button", { name: "安装扩展包" });
    await source.waitFor();
    assert.equal(await install.isDisabled(), true);
    await source.fill("npm:example");
    assert.equal(await install.isEnabled(), true);
    await scope.click();
    assert.equal(
      await page.getByRole("menuitemradio", { name: "当前项目" }).getAttribute("aria-disabled"),
      "true",
    );
    await page.keyboard.press("Escape");

    for (const width of [1200, 840]) {
      await application.evaluate(({ BrowserWindow }, value) => {
        BrowserWindow.getAllWindows()[0]?.setContentSize(value, 720);
      }, width);
      await page.waitForFunction((value) => innerWidth === value, width);
      const layout = await page.locator(".package-install-form").evaluate((form) => {
        const bounds = form.getBoundingClientRect();
        const elements = [
          form.querySelector("input"),
          form.querySelector(".select-trigger"),
          form.querySelector("button[type=submit]"),
        ];
        const present = elements.filter((element): element is Element => element !== null);
        if (present.length !== elements.length) return null;
        const boxes = present.map((element) => element.getBoundingClientRect());
        const within = boxes.every(
          (box) => box.left >= bounds.left - 1 && box.right <= bounds.right + 1,
        );
        const overlap = boxes.some((box, index) =>
          boxes
            .slice(index + 1)
            .some(
              (other) =>
                box.left < other.right &&
                box.right > other.left &&
                box.top < other.bottom &&
                box.bottom > other.top,
            ),
        );
        return { within, overlap, sourceWidth: boxes[0]?.width ?? 0 };
      });
      assert.ok(layout);
      assert.equal(layout.within, true);
      assert.equal(layout.overlap, false);
      assert.ok(layout.sourceWidth >= 160);
    }

    await page.getByRole("button", { name: "常规", exact: true }).click();
    await page.getByRole("button", { name: "主题", exact: true }).click();
    await page.getByRole("menuitemradio", { name: "深色", exact: true }).click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
    await page.getByRole("button", { name: "工具与技能", exact: true }).click();
    assert.equal(await page.getByLabel("包来源").isVisible(), true);
    assert.equal(await page.getByRole("button", { name: "范围" }).isVisible(), true);
  } finally {
    await application.close();
    await rm(profile, { recursive: true, force: true });
  }
});
