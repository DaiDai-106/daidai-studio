import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { launchElectron, openTestProject } from "./support.ts";

test("会话访问权限可切换，重启保留且新会话默认请求批准", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-access-ui-"));
  let app = await launchElectron(root);
  try {
    let page = await app.firstWindow();
    page.setDefaultTimeout(15000);
    await openTestProject(app, page, root);
    const select = page.getByRole("button", { name: "访问权限" });
    assert.match((await select.textContent()) ?? "", /请求批准/);
    await select.click();
    await page.getByRole("menuitemradio", { name: "完全访问" }).click();
    await page.waitForFunction(
      async () =>
        (await window.desktop.application.getWorkspace()).conversations[0]?.accessMode === "full",
    );
    assert.match((await select.textContent()) ?? "", /完全访问/);
    assert.equal(
      await select
        .locator("span")
        .first()
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
      true,
    );
    await app.close();
    app = await launchElectron(root);
    page = await app.firstWindow();
    page.setDefaultTimeout(15000);
    await page.locator(".conversation-row").first().click();
    await page.getByRole("button", { name: "访问权限" }).waitFor();
    assert.match(
      (await page.getByRole("button", { name: "访问权限" }).textContent()) ?? "",
      /完全访问/,
    );
    await page.getByRole("button", { name: "新建对话", exact: true }).first().click();
    await page.waitForFunction(() =>
      document.querySelector('[aria-label="访问权限"]')?.textContent?.includes("请求批准"),
    );
  } finally {
    await app.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
