import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { chooseProject, launchTestApp } from "./support.ts";

test("回到项目主页后仍可从侧栏恢复草稿和代码工作区", { timeout: 60_000 }, async (context) => {
  const { application: app, page, profile: root } = await launchTestApp(context);
  page.setDefaultTimeout(10_000);
  const name = "coding";
  const directory = join(root, name);
  await mkdir(directory);
  await writeFile(join(directory, "main.ts"), "export const value = 1;\n");
  await chooseProject(app, page, directory);

  const intro = page.getByRole("heading", { name: "从代码任务开始", exact: true });
  const home = page.getByRole("button", { name: "返回项目主页", exact: true });
  const projectHeading = page.getByRole("heading", { name: "项目", exact: true });
  const expand = page.getByRole("button", { name: "展开代码工作区" });
  const separator = page.getByRole("separator", { name: "调整聊天与代码工作区宽度" });
  const changes = page.getByRole("tab", { name: "变更", exact: true });
  const composer = page.getByRole("textbox", { name: "消息内容" });
  const conversation = page
    .locator(".project-group")
    .filter({ has: page.getByRole("button", { name, exact: true }) })
    .locator(".conversation-title");

  await intro.waitFor();
  assert.equal(
    await page.getByText("工作区状态无法恢复，本次使用默认布局。", { exact: true }).count(),
    0,
  );
  await expand.click();
  await page.getByRole("button", { name: "main.ts", exact: true }).click();
  await separator.press("ArrowLeft");
  await changes.click();
  await page.getByRole("button", { name: "收起代码工作区" }).click();
  await composer.fill("切换前的草稿");
  await home.click();
  await projectHeading.waitFor();
  await conversation.click();
  await intro.waitFor();
  assert.equal(await composer.inputValue(), "切换前的草稿");
  await expand.click();
  assert.equal(await separator.getAttribute("aria-valuenow"), "52");
  assert.equal(await changes.getAttribute("aria-selected"), "true");
  await page.getByRole("tab", { name: "main.ts", exact: true }).waitFor();
  await page.evaluate(async () => {
    const project = (await window.desktop.application.getWorkspace()).projects[0];
    if (!project) throw new Error("缺少项目");
    localStorage.setItem(`dai:coding:${project.id}`, "invalid json");
  });
  await home.click();
  await conversation.click();
  await page.getByRole("alert").filter({ hasText: "工作区状态无法恢复" }).waitFor();

  await page.getByRole("button", { name: "收起项目栏" }).click();
  await home.click();
  await projectHeading.waitFor();
  await page.getByRole("button", { name: "打开设置", exact: true }).click();
  await home.click();
  await projectHeading.waitFor();
});
