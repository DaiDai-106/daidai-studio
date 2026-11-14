import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { _electron as electron } from "playwright";
import { chooseProject, openTestProject } from "./support.ts";

test("projects sharing a directory keep separate identities and hidden projects restore their history", {
  timeout: 60_000,
}, async () => {
  const profile = await mkdtemp(join(tmpdir(), "dai-project-ui-"));
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
    page.setDefaultTimeout(8000);
    const directory = await openTestProject(application, page, profile);
    await page.getByRole("textbox", { name: "消息内容" }).fill("第一个项目的草稿");
    await page.waitForFunction(async () =>
      (await window.desktop.application.getWorkspace()).conversations.some(
        (item) => item.draft === "第一个项目的草稿",
      ),
    );
    const original = await page.evaluate(() => window.desktop.application.getWorkspace());
    const first = original.projects[0];
    const firstConversation = original.conversations[0];
    assert.ok(first && firstConversation);
    await chooseProject(application, page, directory);
    const both = await page.evaluate(() => window.desktop.application.getWorkspace());
    assert.equal(both.projects.length, 2);
    const second = both.projects.find((item) => item.id !== first.id);
    assert.ok(second);
    assert.equal(second.path, first.path);
    assert.ok(both.conversations.some((item) => item.projectId === second.id));
    await assert.rejects(access(join(directory, ".dai")));
    assert.match(await readFile(join(directory, "example.ts"), "utf8"), /example/);

    const firstIndex = both.projects.findIndex((item) => item.id === first.id);
    await page
      .locator(".project-group")
      .nth(firstIndex)
      .getByRole("button", { name: "project 项目操作" })
      .click();
    await page.getByRole("menuitem", { name: /移除项目/ }).click();
    await page.waitForFunction(
      async (id) =>
        !(await window.desktop.application.getWorkspace()).projects.some((item) => item.id === id),
      first.id,
    );
    await page.getByRole("button", { name: "已隐藏项目" }).click();
    const dialog = page.getByRole("dialog", { name: "已隐藏项目" });
    await dialog.getByText("project", { exact: true }).waitFor();
    await dialog.getByRole("button", { name: "恢复" }).click();
    await page.waitForFunction(
      async (id) =>
        (await window.desktop.application.getWorkspace()).projects.some((item) => item.id === id),
      first.id,
    );
    await dialog.getByRole("button", { name: "关闭弹窗" }).click();
    const restored = await page.evaluate(() => window.desktop.application.getWorkspace());
    assert.equal(restored.projects.length, 2);
    assert.equal(
      restored.conversations.find((item) => item.id === firstConversation.id)?.draft,
      "第一个项目的草稿",
    );
    assert.ok(restored.conversations.some((item) => item.projectId === second.id));
  } finally {
    await application.close();
    await rm(profile, { recursive: true, force: true });
  }
});
