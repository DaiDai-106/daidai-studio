import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { _electron as electron } from "playwright";
import { chooseProject } from "./support.ts";

test("各模块和设置可回项目主页，侧栏会话可恢复草稿", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-home-navigation-"));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[0] !== "ELECTRON_RUN_AS_NODE" && entry[1] !== undefined,
    ),
  );
  const app = await electron.launch({
    args: [process.cwd(), `--user-data-dir=${join(root, "profile")}`],
    env,
    chromiumSandbox: true,
  });
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(10_000);
    for (const mode of ["coding", "scene", "robot"] as const) {
      const directory = join(root, mode);
      await mkdir(directory);
      if (mode === "coding")
        await writeFile(join(directory, "main.ts"), "export const value = 1;\n");
      await chooseProject(app, page, directory, mode);
      assert.equal(
        await page.getByText("工作区状态无法恢复，本次使用默认布局。", { exact: true }).count(),
        0,
      );
      if (mode === "coding") {
        await page.getByRole("button", { name: "展开代码工作区" }).click();
        await page.getByRole("button", { name: "main.ts", exact: true }).click();
        await page.getByRole("separator", { name: "调整聊天与代码工作区宽度" }).press("ArrowLeft");
        await page.getByRole("tab", { name: "变更", exact: true }).click();
        await page.getByRole("button", { name: "收起代码工作区" }).click();
      }
      await page.getByRole("textbox", { name: "消息内容" }).fill(`${mode} 草稿`);
      await page.getByRole("button", { name: "返回项目主页", exact: true }).click();
      await page.getByRole("heading", { name: "项目", exact: true }).waitFor();
      const group = page
        .locator(".project-group")
        .filter({ has: page.getByRole("button", { name: mode, exact: true }) });
      await group.locator(".conversation-title").click();
      assert.equal(
        await page.getByRole("textbox", { name: "消息内容" }).inputValue(),
        `${mode} 草稿`,
      );
      if (mode === "coding") {
        await page.getByRole("button", { name: "展开代码工作区" }).click();
        assert.equal(
          await page
            .getByRole("separator", { name: "调整聊天与代码工作区宽度" })
            .getAttribute("aria-valuenow"),
          "52",
        );
        assert.equal(
          await page.getByRole("tab", { name: "变更", exact: true }).getAttribute("aria-selected"),
          "true",
        );
        await page.getByRole("tab", { name: "main.ts", exact: true }).waitFor();
        await page.evaluate(async () => {
          const project = (await window.desktop.application.getWorkspace()).projects[0];
          if (!project) throw new Error("缺少项目");
          localStorage.setItem(`dai:coding:${project.id}`, "invalid json");
        });
        await page.getByRole("button", { name: "返回项目主页", exact: true }).click();
        await group.locator(".conversation-title").click();
        await page.getByRole("alert").filter({ hasText: "工作区状态无法恢复" }).waitFor();
      }
    }
    await page.getByRole("button", { name: "收起项目栏" }).click();
    await page.getByRole("button", { name: "返回项目主页", exact: true }).click();
    await page.getByRole("heading", { name: "项目", exact: true }).waitFor();
    await page.getByRole("button", { name: "打开设置", exact: true }).click();
    await page.getByRole("button", { name: "返回项目主页", exact: true }).click();
    await page.getByRole("heading", { name: "项目", exact: true }).waitFor();
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
