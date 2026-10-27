import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { _electron as electron } from "playwright";
import { serveMcpHttp } from "../fixtures/mcp-http.ts";
import { servePlanner, turnResults } from "../support/planner.ts";
import { openTestProject } from "./support.ts";

function gate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
test("Electron renders public thinking and real tool details, preserves disclosures, restores history and stops cleanly", {
  timeout: 90_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-transcript-"));
  const first = gate(),
    final = gate(),
    stop = gate();
  const remote = await serveMcpHttp();
  const path = join(root, "project", ".daidai", "artifacts", "current", "features.json");
  const planner = await servePlanner((request) => {
    const user = request.messages.filter((item) => item.role === "user").at(-1)?.content;
    if (user === "停止测试")
      return {
        text: "Should not finish",
        thinking: "等待中的公开摘要",
        beforeContent: stop.promise,
      };
    const results = turnResults(request);
    if (!results.count)
      return {
        id: "read",
        name: "read",
        args: { path, offset: 20, limit: 30 },
        thinking: "先检查文件，再查看工具结果。",
        beforeContent: first.promise,
      };
    if (results.count === 1)
      return { id: "discover", name: "mcp_list_tools", args: { serverId: "transcript" } };
    const echo = results
      .read<{ items: { name: string; sourceName: string }[] }>("discover")
      .items.find((item) => item.sourceName === "echo");
    assert.ok(echo);
    if (results.count === 2)
      return { id: "echo", name: echo.name, args: { value: "Bounded output ".repeat(1000) } };
    return {
      text: "流程测试完成，读取失败已明确保留。",
      thinking: "已核对错误和返回预览。",
      beforeContent: final.promise,
    };
  });
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[0] !== "ELECTRON_RUN_AS_NODE" && entry[1] !== undefined,
    ),
  );
  let app = await electron.launch({
    args: [process.cwd(), `--user-data-dir=${root}`],
    env,
    chromiumSandbox: true,
  });
  let processHandle = app.process();
  const errors: string[] = [];
  try {
    let page = await app.firstWindow();
    page.setDefaultTimeout(8000);
    page.on("pageerror", (error) => errors.push(error.message));
    await page.getByRole("button", { name: "打开项目", exact: true }).first().waitFor();
    await page.evaluate(async (endpoint) => {
      await window.desktop.application.saveProvider({
        id: "process",
        providerType: "local",
        name: "Local process test",
        authMethod: "none",
        endpoint,
        enabled: true,
        persistCredentials: false,
        models: [
          {
            id: "process-test",
            name: "Process test",
            context: 128000,
            output: 1000,
            reasoning: "标准",
          },
        ],
      });
    }, planner.endpoint);
    await openTestProject(app, page, root);
    await page.evaluate(async (url) => {
      await window.desktop.application.saveMcp({
        id: "transcript",
        name: "Transcript MCP",
        enabled: true,
        scope: { kind: "global" },
        modes: ["scene"],
        transport: "http",
        url,
        timeoutMs: 5000,
      });
    }, remote.url);
    await page.getByRole("button", { name: "通用对话", exact: true }).click();
    await page.getByRole("menuitem", { name: /^场景搭建/ }).click();
    await page
      .getByRole("textbox", { name: "消息内容", exact: true })
      .fill("读取文件并查看工具返回");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    const processGroup = page.locator(".turn-process").first();
    await processGroup.getByRole("button", { name: "思考摘要", exact: true }).click();
    await processGroup.locator(".thinking-body").filter({ hasText: "先检查文件" }).waitFor();
    first.release();
    const read = processGroup.locator('[data-tool-name="read"]');
    await read.locator(".process-row").click();
    await read.getByLabel("工具调用参数").filter({ hasText: path }).waitFor();
    assert.match(
      (await read.locator(".tool-argument-summary").textContent()) ?? "",
      /features.json.*20.*30/,
    );
    await processGroup
      .getByText("返回预览已截断。", { exact: true })
      .waitFor({ state: "attached" });
    // Open the generic MCP row and inspect its real bounded text result.
    const echo = processGroup.locator(".tool-message").filter({ hasText: "Transcript MCP · echo" });
    await echo.locator(".process-row").click();
    await echo.getByText("返回预览已截断。", { exact: true }).waitFor();
    assert.ok(((await echo.getByLabel("工具返回内容").textContent()) ?? "").length <= 8000);
    await processGroup.locator(".thinking-body").filter({ hasText: "先检查文件" }).waitFor();
    final.release();
    await page.getByText("流程测试完成，读取失败已明确保留。", { exact: true }).waitFor();
    assert.equal(
      await processGroup.locator(".process-header").getAttribute("aria-expanded"),
      "true",
      "Manual interaction keeps the process open after completion",
    );
    assert.match(
      (await processGroup.locator(".process-header").textContent()) ?? "",
      /3 次工具调用.*1 次失败/s,
    );
    assert.equal(await read.locator(".process-row").getAttribute("aria-expanded"), "true");
    await processGroup.locator(".process-header").click();
    await processGroup.locator(".process-header").click();
    assert.equal(await read.locator(".process-row").getAttribute("aria-expanded"), "true");
    await page.screenshot({ path: "out/transcript-wide.png" });
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setContentSize(840, 700),
    );
    await page.getByRole("tab", { name: "聊天", exact: true }).click();
    await page.screenshot({ path: "out/transcript-narrow.png" });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await page.keyboard.press("ControlOrMeta+Comma");
    await page.getByRole("button", { name: "常规", exact: true }).click();
    const toggle = page.getByRole("switch", { name: "显示思考摘要", exact: true });
    assert.equal(await toggle.getAttribute("aria-checked"), "true");
    await toggle.click();
    await page.waitForFunction(
      async () => !(await window.desktop.application.getWorkspace()).settings.showThinking,
    );
    const requests = planner.requests.length;
    await page.getByRole("button", { name: "返回工作台", exact: true }).click();
    assert.equal(await page.locator(".thinking-message").count(), 0);
    assert.equal(planner.requests.length, requests, "Display preference makes no model request");
    await page.reload();
    await page.locator(".conversation-row").first().click();
    await page.getByRole("tab", { name: "聊天", exact: true }).click();
    await page.getByText("流程测试完成，读取失败已明确保留。", { exact: true }).waitFor();
    const history = page.locator(".turn-process").first();
    assert.equal(await history.locator(".process-header").getAttribute("aria-expanded"), "false");
    await history.locator(".process-header").click();
    await history.locator('[data-tool-name="read"] .process-row').click();
    await history.getByLabel("工具调用参数").filter({ hasText: path }).waitFor();
    assert.equal(
      await page.locator(".thinking-message").count(),
      0,
      "Preference survives backend snapshot and renderer reload",
    );
    await app.close();
    app = await electron.launch({
      args: [process.cwd(), `--user-data-dir=${root}`],
      env,
      chromiumSandbox: true,
    });
    processHandle = app.process();
    page = await app.firstWindow();
    page.setDefaultTimeout(8000);
    page.on("pageerror", (error) => errors.push(error.message));
    await page.locator(".conversation-row").first().click();
    const chatTab = page.getByRole("tab", { name: "聊天", exact: true });
    if (await chatTab.isVisible()) await chatTab.click();
    await page.getByText("流程测试完成，读取失败已明确保留。", { exact: true }).waitFor();
    assert.equal(
      await page.evaluate(
        async () => (await window.desktop.application.getWorkspace()).settings.showThinking,
      ),
      false,
    );
    await page.keyboard.press("ControlOrMeta+Comma");
    await page.getByRole("button", { name: "常规", exact: true }).click();
    await page.getByRole("switch", { name: "显示思考摘要", exact: true }).click();
    await page.getByRole("button", { name: "返回工作台", exact: true }).click();
    await page.getByRole("textbox", { name: "消息内容", exact: true }).fill("停止测试");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await page.locator(".message.user").filter({ hasText: "停止测试" }).waitFor();
    const current = page.locator(".turn-process.active").last();
    await current.waitFor();
    await current.getByRole("button", { name: "思考摘要", exact: true }).first().click();
    await page.getByText("等待中的公开摘要", { exact: true }).waitFor();
    await page.getByRole("button", { name: "停止回复", exact: true }).click();
    await page
      .locator(".message.assistant .message-text")
      .filter({ hasText: "请求已停止。" })
      .waitFor();
    assert.match(
      (await page.locator(".turn-process").last().locator(".process-header").textContent()) ?? "",
      /已停止/,
    );
    assert.equal(await page.locator(".turn-process.active").count(), 0);
    assert.deepEqual(planner.failures, []);
    assert.deepEqual(errors, []);
  } finally {
    first.release();
    final.release();
    stop.release();
    if (processHandle.exitCode === null) await app.close();
    await planner.close();
    await remote.close();
    await rm(root, { recursive: true, force: true });
  }
});
