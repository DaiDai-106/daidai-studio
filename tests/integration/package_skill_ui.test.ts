import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { _electron as electron, type Locator } from "playwright";
import { openTestProject } from "./support.ts";

async function assertSkillDialogLayout(dialog: Locator) {
  const name = dialog.getByLabel("技能名称");
  const content = dialog.getByLabel("SKILL.md");
  const [bodyBox, nameBox, contentBox] = await Promise.all([
    dialog.locator(".dialog-body").boundingBox(),
    name.boundingBox(),
    content.boundingBox(),
  ]);
  assert.ok(bodyBox && nameBox && contentBox);
  assert.ok(nameBox.width >= bodyBox.width * 0.8);
  assert.ok(contentBox.width >= bodyBox.width * 0.8);
  assert.ok(Math.abs(nameBox.x - contentBox.x) <= 2);
  assert.ok(contentBox.y >= nameBox.y + nameBox.height);
  assert.ok(contentBox.x + contentBox.width <= bodyBox.x + bodyBox.width + 1);
}

test("Pi package and standard skills can be managed and restored in the settings UI", {
  timeout: 60_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-package-ui-"));
  const profile = join(root, "profile");
  const source = join(root, "sample-package");
  await mkdir(join(source, "skills", "package-skill"), { recursive: true });
  await writeFile(join(source, "package.json"), JSON.stringify({ name: "sample-pi-package" }));
  await writeFile(
    join(source, "skills", "package-skill", "SKILL.md"),
    `---\nname: package-skill\ndescription: 包内技能\n---\n${"包内说明。\n".repeat(100)}`,
  );
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
  let app = await launch();
  try {
    let page = await app.firstWindow();
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.setDefaultTimeout(10000);
    await openTestProject(app, page, profile);
    await page.getByRole("button", { name: "插件与技能", exact: true }).click();
    await page.getByRole("button", { name: "手动安装", exact: true }).click();
    await page.getByLabel("包来源").fill(source);
    const scope = page.getByRole("button", { name: "使用范围", exact: true });
    assert.match((await scope.textContent()) ?? "", /全局/);
    await scope.click();
    await page.getByRole("menuitemradio", { name: "仅 Coding 模块", exact: true }).click();
    await page.getByRole("button", { name: "继续安装" }).click();
    assert.match((await scope.textContent()) ?? "", /仅 Coding 模块/);
    await page.getByRole("button", { name: "确认安装" }).click();
    await page.getByRole("tab", { name: /已安装/ }).click();
    const packageRow = page
      .locator(".plugin-installed-row")
      .filter({ hasText: "sample-pi-package" });
    await packageRow.waitFor();
    await packageRow.getByText(/仅 Coding 模块/).waitFor();
    await page
      .getByText("全局插件与 Coding 模块插件，对所有 Coding 项目生效。", { exact: true })
      .waitFor();
    await page.screenshot({ path: join(tmpdir(), "dai-plugin-installed-scope.png") });
    await page.waitForFunction(async () =>
      (await window.desktop.application.catalogTasks()).every((task) => task.state !== "running"),
    );
    await page.getByRole("textbox", { name: "搜索已安装插件", exact: true }).fill("no-such-plugin");
    await page.getByRole("heading", { name: "没有匹配的已安装插件", exact: true }).waitFor();
    await page.getByRole("button", { name: "清除筛选", exact: true }).click();
    await packageRow.waitFor();
    const disabledPath = join(profile, "data", "agent", "packages", "disabled.json");
    await writeFile(disabledPath, "{}");
    await page.getByRole("button", { name: "刷新状态", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "包启用状态文件损坏" }).waitFor();
    await writeFile(disabledPath, "[]");
    await page.getByRole("button", { name: "刷新状态", exact: true }).click();
    await page
      .getByRole("alert")
      .filter({ hasText: "包启用状态文件损坏" })
      .waitFor({ state: "hidden" });
    assert.deepEqual(pageErrors, []);
    await packageRow.getByRole("button", { name: "sample-pi-package", exact: true }).click();
    const installedDetail = page.getByRole("dialog", { name: "已安装插件详情", exact: true });
    await page.evaluate(
      (source) =>
        window.desktop.application.packageAction({
          action: "disable",
          source,
          scope: "module",
          moduleId: "coding",
        }),
      source,
    );
    await installedDetail.getByText("已停用", { exact: true }).waitFor();
    await installedDetail
      .getByText("插件已停用，启用后可查看附带技能。", { exact: true })
      .waitFor();
    await page.evaluate(
      (source) =>
        window.desktop.application.packageAction({
          action: "enable",
          source,
          scope: "module",
          moduleId: "coding",
        }),
      source,
    );
    await installedDetail.getByText("已启用 · 暂无加载记录", { exact: true }).waitFor();
    const skillRow = page.locator(".setting-row").filter({ hasText: "package-skill" });
    await skillRow.waitFor();
    await skillRow.getByRole("button", { name: "查看" }).click();
    const view = page.getByRole("dialog", { name: "查看技能" });
    assert.equal(await view.getByLabel("SKILL.md").getAttribute("readonly"), "");
    assert.equal(
      await view
        .getByLabel("SKILL.md")
        .evaluate((element) => element.scrollHeight > element.clientHeight),
      true,
    );
    for (const width of [1200, 840]) {
      await app.evaluate(({ BrowserWindow }, value) => {
        BrowserWindow.getAllWindows()[0]?.setContentSize(value, 720);
      }, width);
      await page.waitForFunction((value) => innerWidth === value, width);
      await assertSkillDialogLayout(view);
      assert.equal(await view.getByLabel("SKILL.md").evaluate((element) => element.scrollTop), 0);
    }
    await view.getByRole("button", { name: "关闭", exact: true }).click();
    // 包版本未变化时，更新任务仍须刷新当前详情中的技能列表。
    await writeFile(
      join(source, "skills/package-skill/SKILL.md"),
      "---\nname: package-skill\ndescription: 同版本更新后的技能\n---\nUpdated content.\n",
    );
    const updated = await page.evaluate(
      (source) =>
        window.desktop.application.packageAction({
          action: "update",
          source,
          scope: "module",
          moduleId: "coding",
        }),
      source,
    );
    await page.waitForFunction(
      async (id) =>
        (await window.desktop.application.catalogTasks()).some(
          (task) => task.id === id && task.state === "completed",
        ),
      updated.id,
    );
    await installedDetail.getByText("同版本更新后的技能", { exact: true }).waitFor();
    await page
      .getByRole("dialog", { name: "已安装插件详情" })
      .getByRole("button", { name: "关闭弹窗" })
      .click();
    // 已移除的条目会关闭详情，再次安装不能意外重开旧弹窗。
    await packageRow.getByRole("button", { name: "sample-pi-package", exact: true }).click();
    await page.evaluate(
      (source) =>
        window.desktop.application.packageAction({
          action: "remove",
          source,
          scope: "module",
          moduleId: "coding",
        }),
      source,
    );
    await installedDetail.waitFor({ state: "hidden" });
    await page.evaluate(
      (source) =>
        window.desktop.application.packageAction({
          action: "install",
          source,
          scope: "module",
          moduleId: "coding",
        }),
      source,
    );
    await packageRow.waitFor();
    assert.equal(await installedDetail.count(), 0);
    await packageRow.getByRole("button", { name: "停用" }).click();
    await packageRow.getByRole("button", { name: "启用" }).waitFor();

    await packageRow.getByRole("button", { name: "启用" }).click();
    await packageRow.getByRole("button", { name: "停用" }).waitFor();
    await page.getByRole("tab", { name: "我的技能", exact: true }).click();
    await page.getByRole("button", { name: "新建技能" }).click();
    const editor = page.getByRole("dialog", { name: "新建技能" });
    await assertSkillDialogLayout(editor);
    await editor.getByLabel("技能名称").fill("user-skill");
    await editor
      .getByLabel("SKILL.md")
      .fill("---\nname: user-skill\ndescription: 用户技能\n---\n初始内容。\n");
    await editor.getByRole("button", { name: "保存" }).click();
    const userRow = page.locator(".setting-row").filter({ hasText: "user-skill" });
    await userRow.getByRole("button", { name: "编辑" }).click();
    const edit = page.getByRole("dialog", { name: "编辑技能" });
    await assertSkillDialogLayout(edit);
    await edit
      .getByLabel("SKILL.md")
      .fill("---\nname: user-skill\ndescription: 用户技能\n---\n更新后的内容。\n");
    await edit.getByRole("button", { name: "保存" }).click();
    await edit.waitFor({ state: "hidden" });
    await app.close();

    app = await launch();
    page = await app.firstWindow();
    page.setDefaultTimeout(10000);
    await page.getByRole("button", { name: "插件与技能", exact: true }).click();
    await page.getByRole("tab", { name: "我的技能", exact: true }).click();
    await page
      .locator(".setting-row")
      .filter({ hasText: "user-skill" })
      .getByRole("button", { name: "编辑" })
      .click();
    assert.match(
      await page.getByRole("dialog", { name: "编辑技能" }).getByLabel("SKILL.md").inputValue(),
      /更新后的内容/,
    );
  } finally {
    await app.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
