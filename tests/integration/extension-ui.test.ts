import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { _electron as electron } from "playwright";
import { servePlanner, turnResults } from "../support/planner.ts";
import { openTestProject } from "./support.ts";

test("real Pi package dialogs support background recovery, confirm, select, input and cancellation", {
  timeout: 60_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-extension-ui-"));
  const source = join(root, "package");
  await mkdir(join(source, "extensions"), { recursive: true });
  await writeFile(join(source, "package.json"), JSON.stringify({ name: "dai-ui-test" }));
  await writeFile(
    join(source, "extensions", "index.ts"),
    `export default pi => pi.registerTool({
    name: 'ask_user', label: 'Ask', description: 'Ask the user', parameters: {type:'object',properties:{}},
    execute: async (_id, _params, _signal, _update, ctx) => {
      const confirmed = await ctx.ui.confirm('确认操作', '继续吗？');
      const choice = await ctx.ui.select('选择模式', ['A', 'B']);
      const name = await ctx.ui.input('输入名称', '例如 robot');
      const optional = await ctx.ui.input('可选说明', '可以取消');
      return {content:[{type:'text',text:JSON.stringify({confirmed,choice,name,optional})}],details:{}};
    }
  });`,
  );
  const planner = await servePlanner((request) =>
    turnResults(request).count === 0
      ? { id: "ask", name: "ask_user", args: {} }
      : { text: "扩展交互完成" },
  );
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
    page.setDefaultTimeout(10000);
    await page.evaluate(
      async (endpoint) =>
        window.desktop.application.saveProvider({
          id: "local",
          providerType: "local",
          name: "Test",
          authMethod: "none",
          endpoint,
          enabled: true,

          models: [
            { id: "workflow-test", name: "Test", context: 8192, output: 1024, reasoning: "标准" },
          ],
        }),
      planner.endpoint,
    );
    await openTestProject(app, page, root);
    const workspace = await page.evaluate(() => window.desktop.application.getWorkspace());
    const project = workspace.projects[0];
    assert.ok(project);
    await page.evaluate((input) => window.desktop.application.installPackage(input), {
      source,
      scope: "project" as const,
      projectId: project.id,
    });
    await page.getByRole("textbox", { name: "消息内容" }).fill("运行扩展交互");
    await page.getByRole("button", { name: "发送消息" }).click();
    await page.getByRole("dialog", { name: "确认操作" }).waitFor();
    await page.reload();
    await page.getByRole("status", { name: "扩展等待回复" }).waitFor();
    await page.locator(".conversation-title").first().click();
    await page
      .getByRole("dialog", { name: "确认操作" })
      .getByRole("button", { name: "确认" })
      .click();
    const select = page.getByRole("dialog", { name: "选择模式" });
    await select.getByLabel("B", { exact: true }).check();
    await select.getByRole("button", { name: "提交" }).click();
    const input = page.getByRole("dialog", { name: "输入名称" });
    await input.getByLabel("输入内容").fill("robot");
    await input.getByRole("button", { name: "提交" }).click();
    await page
      .getByRole("dialog", { name: "可选说明" })
      .getByRole("button", { name: "取消" })
      .click();
    await page.getByText("扩展交互完成", { exact: true }).waitFor();
    const result =
      planner.requests.at(-1)?.messages.find((message) => message.role === "tool")?.content ?? "";
    assert.match(result, /"confirmed":true/);
    assert.match(result, /"choice":"B"/);
    assert.match(result, /"name":"robot"/);
    await page.getByRole("textbox", { name: "消息内容" }).fill("再次运行并停止");
    await page.getByRole("button", { name: "发送消息" }).click();
    const stopped = page.getByRole("dialog", { name: "确认操作" });
    await stopped.getByRole("button", { name: "停止回复" }).click();
    await stopped.waitFor({ state: "hidden" });
    await page.waitForFunction(async () => {
      const state = await window.desktop.application.getWorkspace();
      return !state.busyConversationId && !state.extensionUiRequests?.length;
    });
  } finally {
    await app.close();
    await planner.close();
    await rm(root, { recursive: true, force: true });
  }
});
