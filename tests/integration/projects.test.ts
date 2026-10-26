import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { _electron as electron } from "playwright";
import { chooseProject, openTestProject } from "./support.ts";

test("removing projects preserves the active view, local files and the original conversation", {
  timeout: 60000,
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
    page.setDefaultTimeout(7000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const directory = await openTestProject(application, page, profile);
    await page
      .getByRole("textbox", { name: "消息内容", exact: true })
      .fill("项目移除后也保留的草稿");
    await page.waitForFunction(
      async () =>
        (await window.desktop.application.getWorkspace()).conversations[0]?.draft ===
        "项目移除后也保留的草稿",
    );
    const original = await page.evaluate(() => window.desktop.application.getWorkspace());
    const otherDirectory = join(profile, "other-project");
    await mkdir(otherDirectory);
    await writeFile(join(otherDirectory, "keep.txt"), "Keep local project files");
    await chooseProject(application, page, otherDirectory);
    const otherGroup = page
      .locator(".project-group")
      .filter({ has: page.getByRole("button", { name: "other-project", exact: true }) });
    await otherGroup.locator(".conversation-row.selected").waitFor();
    const originalGroup = page
      .locator(".project-group")
      .filter({ has: page.getByRole("button", { name: "project", exact: true }) });
    await originalGroup.locator(".conversation-title").click();
    await originalGroup.locator(".conversation-row.selected").waitFor();
    await page.getByRole("button", { name: "通用对话", exact: true }).click();
    await page.getByRole("menuitem", { name: /^场景搭建/ }).click();
    await page.getByLabel("三维场景视图", { exact: true }).waitFor();
    await page.getByRole("button", { name: "网格", exact: true }).click();
    await otherGroup.getByRole("button", { name: "other-project 项目操作", exact: true }).click();
    await page.getByRole("menuitem", { name: /^移除项目/ }).click();
    await otherGroup.waitFor({ state: "hidden" });
    assert.equal(
      await page.getByRole("dialog", { name: "场景有未保存的修改", exact: true }).count(),
      0,
    );
    assert.equal(
      await page.getByRole("button", { name: "网格", exact: true }).getAttribute("aria-pressed"),
      "false",
    );
    assert.equal(
      await readFile(join(otherDirectory, "keep.txt"), "utf8"),
      "Keep local project files",
    );
    await originalGroup.getByRole("button", { name: "project 项目操作", exact: true }).click();
    await page.getByRole("menuitem", { name: /^移除项目/ }).click();
    await page.locator(".project-group").waitFor({ state: "hidden" });
    await page.getByRole("heading", { name: "今天想和呆呆完成什么？", exact: true }).waitFor();
    await chooseProject(application, page, directory);
    await page.getByLabel("三维场景视图", { exact: true }).waitFor();
    assert.equal(
      await page.getByRole("textbox", { name: "消息内容", exact: true }).inputValue(),
      "项目移除后也保留的草稿",
    );
    const restored = await page.evaluate(() => window.desktop.application.getWorkspace());
    assert.equal(restored.projects[0]?.id, original.projects[0]?.id);
    assert.equal(restored.conversations[0]?.id, original.conversations[0]?.id);
    assert.equal(restored.conversations.length, 1);
    // Put the original conversation beyond the first page before restoring again.
    await chooseProject(application, page, otherDirectory);
    await otherGroup.locator(".conversation-row.selected").waitFor();
    const other = (
      await page.evaluate(() => window.desktop.application.getWorkspace())
    ).projects.find((project) => project.name === "other-project");
    assert.ok(other);
    await page.evaluate(async (id) => {
      for (let index = 0; index < 100; index++)
        await window.desktop.application.createConversation(id);
    }, other.id);
    await originalGroup.getByRole("button", { name: "project 项目操作", exact: true }).click();
    await page.getByRole("menuitem", { name: /^移除项目/ }).click();
    await originalGroup.waitFor({ state: "hidden" });
    await chooseProject(application, page, directory);
    await originalGroup.locator(".conversation-row.selected").waitFor();
    assert.equal(
      await page.getByRole("textbox", { name: "消息内容", exact: true }).inputValue(),
      "项目移除后也保留的草稿",
    );
    const afterPaging = await page.evaluate(async () => {
      const first = await window.desktop.application.getWorkspace();
      if (!first.nextCursor) throw new Error("Expected a second history page");
      return [
        ...first.conversations,
        ...(await window.desktop.application.getWorkspace(first.nextCursor)).conversations,
      ];
    });
    assert.equal(
      afterPaging.length,
      102,
      "Restoring an older project must not create another conversation.",
    );
    assert.ok(
      afterPaging.some((conversation) => conversation.id === original.conversations[0]?.id),
    );
    await originalGroup.getByRole("button", { name: "新建对话 对话操作", exact: true }).click();
    await page.getByRole("menuitem", { name: "归档对话", exact: true }).click();
    await originalGroup.locator(".conversation-row").waitFor({ state: "hidden" });
    await originalGroup.getByRole("button", { name: "project 项目操作", exact: true }).click();
    await page.getByRole("menuitem", { name: /^移除项目/ }).click();
    await originalGroup.waitFor({ state: "hidden" });
    await chooseProject(application, page, directory);
    await originalGroup.waitFor();
    await page.getByRole("heading", { name: "今天想和呆呆完成什么？", exact: true }).waitFor();
    const archivedOnly = await page.evaluate(async () => {
      const first = await window.desktop.application.getWorkspace();
      if (!first.nextCursor) throw new Error("Expected a second history page");
      return [
        ...first.conversations,
        ...(await window.desktop.application.getWorkspace(first.nextCursor)).conversations,
      ];
    });
    assert.equal(
      archivedOnly.length,
      102,
      "An archived-only project must not acquire a new conversation on reopen.",
    );
    assert.equal(
      archivedOnly.find((conversation) => conversation.id === original.conversations[0]?.id)
        ?.archived,
      true,
    );
    assert.deepEqual(errors, []);
  } finally {
    await application.close();
    await rm(profile, { recursive: true, force: true });
  }
});
