import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { _electron as electron } from "playwright";
import { openTestProject } from "./support.ts";

test("capabilities separate skills from MCP, preview English CAD tool summaries and preserve scoped configuration", {
  timeout: 60_000,
}, async () => {
  const profile = await mkdtemp(join(tmpdir(), "dai-capabilities-"));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[0] !== "ELECTRON_RUN_AS_NODE" && entry[1] !== undefined,
    ),
  );
  let app = await electron.launch({
    args: [process.cwd(), `--user-data-dir=${profile}`],
    env,
    chromiumSandbox: true,
  });
  try {
    let page = await app.firstWindow();
    page.setDefaultTimeout(7000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setContentSize(1320, 940),
    );
    await openTestProject(app, page, profile);
    await page
      .locator(".sidebar-footer")
      .getByRole("button", { name: "工具与技能", exact: true })
      .click();
    const skillSection = page.getByRole("region", { name: /^技能 Skills/ });
    const mcpSection = page.getByRole("region", { name: /^MCP 工具/ });
    await skillSection.getByRole("heading", { name: "scene-building", exact: true }).waitFor();
    await mcpSection.getByRole("heading", { name: "cad-mcp", exact: true }).waitFor();
    await page.getByRole("button", { name: "筛选业务模式", exact: true }).click();
    await page.getByRole("menuitemradio", { name: "通用对话", exact: true }).click();
    assert.equal(await skillSection.locator(".service-card").count(), 0);
    assert.equal(await mcpSection.locator(".service-card").count(), 0);
    await page.getByRole("button", { name: "筛选业务模式", exact: true }).click();
    await page.getByRole("menuitemradio", { name: "场景搭建", exact: true }).click();
    await mcpSection
      .getByRole("article", { name: "cad-mcp", exact: true })
      .getByRole("button", { name: "查看工具与接口", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "cad-mcp", exact: true });
    await dialog.waitFor();
    const names = await dialog.locator(".mcp-tool code").allTextContents();
    assert.equal(names.length, 12);
    assert.ok(names.every((name) => /^cad_[a-z_]+$/.test(name)));
    assert.equal(
      await dialog.getByRole("button", { name: "演示连接检查", exact: true }).count(),
      0,
    );
    assert.equal(await dialog.locator("details, summary, pre").count(), 0);
    assert.doesNotMatch(
      (await dialog.textContent()) ?? "",
      /DocumentHandle|JobHandle|Input|Output|Schema|运行顺序|PRD|示例/,
    );
    await dialog.getByText("导入项目中的 STEP 文件。", { exact: true }).waitFor();
    await page.screenshot({ path: join(tmpdir(), "dai-cad-contract-preview.png") });
    await dialog.getByRole("button", { name: "关闭弹窗", exact: true }).click();
    await mcpSection.getByRole("switch", { name: "启用 cad-mcp", exact: true }).click();
    await mcpSection.getByText("已停用配置", { exact: true }).waitFor();
    const baseSkill = skillSection.getByRole("article", { name: "scene-building", exact: true });
    await baseSkill.getByText("随模式加载", { exact: true }).waitFor();
    assert.equal(await baseSkill.getByRole("switch").count(), 0);
    await mcpSection.getByRole("switch", { name: "启用 cad-mcp", exact: true }).click();
    await skillSection
      .getByRole("article", { name: "scene-building", exact: true })
      .getByRole("button", { name: "查看技能", exact: true })
      .click();
    const skill = page.getByRole("dialog", { name: "查看内置技能", exact: true });
    assert.equal(
      await skill.getByLabel("技能名称", { exact: true }).inputValue(),
      "scene-building",
    );
    assert.equal(await skill.getByLabel("技能名称", { exact: true }).getAttribute("readonly"), "");
    await skill.getByRole("button", { name: "关闭弹窗", exact: true }).click();
    await page.getByRole("textbox", { name: "搜索工具或技能", exact: true }).fill("cad-mcp");
    assert.equal(await skillSection.locator(".service-card").count(), 0);
    assert.equal(await mcpSection.locator(".service-card").count(), 1);
    await page.getByRole("textbox", { name: "搜索工具或技能", exact: true }).fill("");
    await page.screenshot({ path: join(tmpdir(), "dai-scene-capabilities.png") });

    await page.getByRole("button", { name: "当前项目", exact: true }).click();
    await mcpSection.getByRole("button", { name: "添加 MCP 服务", exact: true }).click();
    const custom = page.getByRole("dialog", { name: "添加 MCP 服务", exact: true });
    assert.equal(
      await custom.getByRole("button", { name: "适用范围", exact: true }).textContent(),
      "项目：project",
    );
    await custom.getByLabel("服务名称", { exact: true }).fill("inspection-tools");
    await custom.getByLabel("启动命令", { exact: true }).fill(process.execPath);
    const args = [
      "--experimental-strip-types",
      resolve("tests/fixtures/mcp-stdio.ts"),
      join(profile, "service exit"),
    ];
    for (let index = 0; index < args.length; index++) {
      await custom.getByRole("button", { name: "添加参数", exact: true }).click();
      await custom.getByLabel(`启动参数 ${index + 1}`, { exact: true }).fill(args[index] ?? "");
    }
    await custom.getByRole("button", { name: "连接并查看工具", exact: true }).click();
    await custom.locator(".mcp-tool").getByText("echo", { exact: true }).waitFor();
    assert.equal(await custom.locator(".mcp-tool").count(), 2);
    assert.equal(await custom.locator("pre").count(), 0);
    await custom.getByRole("button", { name: /^保存配置/ }).click();
    await mcpSection.getByRole("heading", { name: "inspection-tools", exact: true }).waitFor();
    await skillSection.getByRole("button", { name: "导入技能", exact: true }).click();
    const imported = page.getByRole("dialog", { name: "导入技能", exact: true });
    await imported.getByRole("button", { name: "填入示例技能", exact: true }).click();
    await imported.getByRole("button", { name: "解析并预览", exact: true }).click();
    await imported.getByLabel("业务场景（可选）", { exact: true }).selectOption("steel-structure");
    await imported
      .getByLabel("参考图片", { exact: true })
      .setInputFiles(resolve("resources/skills/steel-structure/images/upright-reference.png"));
    await imported.getByRole("img", { name: "upright-reference.png", exact: true }).waitFor();
    assert.match(
      await imported.getByLabel("Markdown 正文", { exact: true }).inputValue(),
      /images\/.*\.png/,
    );
    await imported.getByRole("button", { name: "保存技能", exact: true }).click();
    await skillSection.getByRole("heading", { name: "step-review", exact: true }).waitFor();
    await page.getByRole("button", { name: "返回工作台", exact: true }).click();
    await page
      .locator(".sidebar-footer")
      .getByRole("button", { name: "工具与技能", exact: true })
      .click();
    assert.equal(await page.locator(".service-card").count(), 8);
    await page.waitForFunction(async () =>
      (await window.desktop.application.getWorkspace()).settings.skills.some(
        (skill) => skill.name === "step-review",
      ),
    );
    await app.close();
    app = await electron.launch({
      args: [process.cwd(), `--user-data-dir=${profile}`],
      env,
      chromiumSandbox: true,
    });
    page = await app.firstWindow();
    page.setDefaultTimeout(7000);
    page.on("pageerror", (error) => errors.push(error.message));
    await page
      .locator(".sidebar-footer")
      .getByRole("button", { name: "工具与技能", exact: true })
      .click();
    const savedSkill = page.getByRole("article", { name: "step-review", exact: true });
    await savedSkill.getByRole("heading", { name: "step-review", exact: true }).waitFor();
    await savedSkill.getByRole("switch", { name: "启用 step-review", exact: true }).click();
    await page.waitForFunction(async () =>
      (await window.desktop.application.getWorkspace()).settings.skills.some(
        (skill) => skill.name === "step-review" && !skill.enabled,
      ),
    );
    await savedSkill.getByRole("button", { name: "编辑技能", exact: true }).click();
    const edit = page.getByRole("dialog", { name: "编辑技能", exact: true });
    await edit.getByRole("img", { name: "upright-reference.png", exact: true }).waitFor();
    await edit.getByRole("button", { name: "移除", exact: true }).click();
    await edit
      .getByLabel("Markdown 正文", { exact: true })
      .fill("使用当前场景事实检查装配，不假定关节参数。");
    await edit.getByRole("button", { name: "保存技能", exact: true }).click();
    await page.waitForFunction(async () =>
      (await window.desktop.application.getWorkspace()).settings.skills.some(
        (skill) =>
          skill.body === "使用当前场景事实检查装配，不假定关节参数。" && !skill.images?.length,
      ),
    );
    await savedSkill.getByRole("button", { name: "移除", exact: true }).click();
    await page
      .getByRole("dialog", { name: "移除自定义配置", exact: true })
      .getByRole("button", { name: "移除配置", exact: true })
      .click();
    await savedSkill.waitFor({ state: "hidden" });
    assert.equal(
      await page.evaluate(
        async () => (await window.desktop.application.getWorkspace()).settings.skills.length,
      ),
      0,
    );
    assert.deepEqual(errors, []);
  } finally {
    await app.close();
    await rm(profile, { recursive: true, force: true });
  }
});
