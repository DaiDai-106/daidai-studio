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
    page.setDefaultTimeout(10000);
    await openTestProject(app, page, profile);
    await page.getByRole("button", { name: "工具与技能", exact: true }).click();
    await page.getByLabel("包来源").fill(source);
    await page.getByRole("button", { name: "安装扩展包" }).click();
    const packageRow = page.locator(".setting-row").filter({ hasText: source });
    await packageRow.waitFor();
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
    await packageRow.getByRole("button", { name: "停用" }).click();
    await packageRow.getByRole("button", { name: "启用" }).waitFor();
    await skillRow.waitFor({ state: "hidden" });
    await packageRow.getByRole("button", { name: "启用" }).click();
    await skillRow.waitFor();
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
    await page.getByRole("button", { name: "工具与技能", exact: true }).click();
    await page.locator(".setting-row").filter({ hasText: source }).waitFor();
    await page.locator(".setting-row").filter({ hasText: "package-skill" }).waitFor();
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
