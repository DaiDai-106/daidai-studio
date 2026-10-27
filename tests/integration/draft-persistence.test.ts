import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { _electron as electron } from "playwright";
import { openTestProject } from "./support.ts";

test("switching conversations and quitting immediately persist the latest draft", {
  timeout: 45000,
}, async () => {
  const profile = await mkdtemp(join(tmpdir(), "dai-drafts-"));
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
  let application = await launch();
  try {
    let page = await application.firstWindow();
    page.setDefaultTimeout(8000);
    await openTestProject(application, page, profile);
    const input = page.getByRole("textbox", { name: "消息内容" });
    await input.fill("切换前的草稿");
    await page.getByRole("button", { name: "新建对话", exact: true }).first().click();
    await page.waitForFunction(
      () =>
        (document.querySelector('textarea[aria-label="消息内容"]') as HTMLTextAreaElement)
          ?.value === "",
    );
    const values = await page.evaluate(async () =>
      (await window.desktop.application.getWorkspace()).conversations.map((item) => item.draft),
    );
    assert.ok(values.includes("切换前的草稿"));
    await input.fill("退出前的草稿");
    const exited = once(application.process(), "exit");
    await application.evaluate(({ app }) => app.quit());
    await exited;
    application = await launch();
    page = await application.firstWindow();
    page.setDefaultTimeout(8000);
    await page.getByRole("textbox", { name: "消息内容" }).waitFor();
    assert.equal(
      await page.getByRole("textbox", { name: "消息内容" }).inputValue(),
      "退出前的草稿",
    );
    const restored = await page.evaluate(async () =>
      (await window.desktop.application.getWorkspace()).conversations.map((item) => item.draft),
    );
    assert.ok(restored.includes("切换前的草稿"));
  } finally {
    await application.close();
    await rm(profile, { recursive: true, force: true });
  }
});
