import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { chooseProject, launchTestApp, openTestProject } from "./support.ts";

test("新建规划项目显示规划图标并打开独立工作区", { timeout: 30_000 }, async (context) => {
  const { application, page, profile } = await launchTestApp(context);
  await application.evaluate(({ app }, directory) => app.setPath("documents", directory), profile);
  await page.setViewportSize({ width: 1360, height: 860 });
  await page.getByRole("button", { name: "新建项目", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "新建项目" });
  await dialog.getByLabel("项目名称").fill("坡口切割规划");
  await dialog.getByLabel("项目类型").selectOption("planning");
  await dialog.locator('.project-mode-icon[data-mode="planning"] svg').waitFor();
  assert.equal(await dialog.getByRole("button", { name: "选择文件夹" }).count(), 0);
  await dialog.getByRole("button", { name: "创建项目", exact: true }).click();

  const planning = page.getByRole("region", { name: "规划工作区" });
  await planning.getByText("请加载 URDF 文件或 Package 目录。", { exact: true }).waitFor();
  assert.ok(await planning.getByRole("button", { name: "运行规划" }).isDisabled());
  await planning.getByRole("button", { name: "加载场景", exact: true }).click();
  const menu = page.getByRole("menu", { name: "加载场景" });
  assert.deepEqual(await menu.getByRole("menuitem").allTextContents(), [
    "选择 URDF 文件",
    "选择 Package 目录",
  ]);
  const pickerCalls = await application.evaluateHandle(({ dialog }) => {
    const calls: string[][] = [];
    dialog.showOpenDialog = async (_window, options?: Electron.OpenDialogOptions) => {
      calls.push(options?.properties ?? []);
      return { canceled: true, filePaths: [] };
    };
    return calls;
  });
  await menu.getByRole("menuitem", { name: "选择 URDF 文件" }).click();
  await planning.getByRole("button", { name: "加载场景", exact: true }).click();
  await menu.getByRole("menuitem", { name: "选择 Package 目录" }).click();
  await planning
    .getByRole("button", { name: "加载场景", exact: true })
    .and(planning.locator("button:enabled"))
    .waitFor();
  assert.deepEqual(await pickerCalls.jsonValue(), [["openFile"], ["openDirectory"]]);
  await pickerCalls.dispose();
  assert.ok(await planning.getByRole("button", { name: "运行规划" }).isDisabled());
  await page
    .getByRole("navigation", { name: "项目", exact: true })
    .locator('.project-mode-icon[data-mode="planning"] svg')
    .waitFor();
  await page.locator(".assistant-navigation").getByRole("button", { name: "新建对话" }).click();
  await page.getByPlaceholder("描述下一轮规划目标…").waitFor();
  const { projects, conversations } = await page.evaluate(() =>
    window.desktop.application.getWorkspace(),
  );
  const project = projects.find(({ name }) => name === "坡口切割规划");
  assert.equal(project?.mode, "planning");
  assert.equal(conversations.find(({ projectId }) => projectId === project?.id)?.mode, "planning");

  await page.getByRole("button", { name: "返回项目主页", exact: true }).click();
  const item = page.getByRole("button", { name: "打开项目 坡口切割规划", exact: true });
  await item.locator('.project-mode-icon[data-mode="planning"] svg').waitFor();
  await item.click();
  await planning.waitFor();
});

test("projects sharing a directory keep separate identities and hidden projects restore their history", {
  timeout: 60_000,
}, async (context) => {
  const { application, page, profile } = await launchTestApp(context);
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
});
