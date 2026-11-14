import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { _electron as electron } from "playwright";
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
  const path = join(root, "project", "missing.json");
  const largePath = join(root, "project", "large.txt");
  const planner = await servePlanner((request) => {
    const content: unknown = request.messages
      .filter((item) => item.role === "user")
      .at(-1)?.content;
    const user =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content.map((item) => (typeof item?.text === "string" ? item.text : "")).join("")
          : "";
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
    if (results.count === 1) return { id: "large", name: "read", args: { path: largePath } };
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
    await page.getByRole("button", { name: "新建项目", exact: true }).first().waitFor();
    await page.evaluate(async (endpoint) => {
      const api = window.desktop.application;
      const login = await api.startLogin("deepseek", "api_key");
      if (!login.prompt) throw new Error("Missing test login prompt");
      await api.answerLogin(login.id, login.prompt.id, "transcript-test-key");
      const provider = {
        id: "process",
        providerType: "deepseek",
        name: "Local process test",
        authMethod: "api_key" as const,
        endpoint,
        enabled: true,

        models: [],
      };
      const model = (await api.getModels(provider, login.id, false)).find((item) =>
        item.thinkingLevels?.includes("low"),
      );
      if (!model) throw new Error("Missing reasoning model");
      await api.saveProvider({ ...provider, models: [{ ...model, output: 4096 }] }, login.id);
    }, planner.endpoint);
    await openTestProject(app, page, root);
    await writeFile(largePath, "Bounded output ".repeat(1000));
    await page.getByRole("button", { name: "推理档位" }).click();
    await page.getByRole("menuitemradio", { name: "high", exact: true }).click();
    await page
      .getByRole("textbox", { name: "消息内容", exact: true })
      .fill("读取文件并查看工具返回");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    const processGroup = page.locator(".turn-process").first();
    await processGroup.getByRole("button", { name: "思考摘要", exact: true }).click();
    await processGroup.locator(".thinking-body").filter({ hasText: "先检查文件" }).waitFor();
    first.release();
    const read = processGroup.locator('[data-tool-name="read"]').first();
    await read.locator(".process-row").click();
    await read.getByLabel("工具调用参数").filter({ hasText: path }).waitFor();
    assert.match(
      (await read.locator(".tool-argument-summary").textContent()) ?? "",
      /missing.json.*20.*30/,
    );
    await processGroup
      .getByText("返回预览已截断。", { exact: true })
      .waitFor({ state: "attached" });
    // 使用 Pi 的 read 工具验证长结果预览的上限。
    const echo = processGroup.locator('[data-tool-name="read"]').nth(1);
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
      /2 次工具调用.*1 次失败/s,
    );
    assert.equal(await read.locator(".process-row").getAttribute("aria-expanded"), "true");
    await processGroup.locator(".process-header").click();
    await processGroup.locator(".process-header").click();
    assert.equal(await read.locator(".process-row").getAttribute("aria-expanded"), "true");
    await page.screenshot({ path: "out/transcript-wide.png" });
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setContentSize(840, 700),
    );
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
    await page.getByText("流程测试完成，读取失败已明确保留。", { exact: true }).waitFor();
    const history = page.locator(".turn-process").first();
    assert.equal(await history.locator(".process-header").getAttribute("aria-expanded"), "false");
    await history.locator(".process-header").click();
    await history.locator('[data-tool-name="read"] .process-row').first().click();
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
    await page.evaluate(async (endpoint) => {
      const api = window.desktop.application;
      const login = await api.startLogin("deepseek", "api_key");
      if (!login.prompt) throw new Error("Missing test login prompt");
      await api.answerLogin(login.id, login.prompt.id, "transcript-test-key");
      const provider = {
        id: "process",
        providerType: "deepseek",
        name: "Local process test",
        authMethod: "api_key" as const,
        endpoint,
        enabled: true,

        models: [],
      };
      const model = (await api.getModels(provider, login.id, false)).find((item) =>
        item.thinkingLevels?.includes("low"),
      );
      if (!model) throw new Error("Missing reasoning model");
      await api.saveProvider({ ...provider, models: [{ ...model, output: 4096 }] }, login.id);
    }, planner.endpoint);
    await page.locator(".conversation-row").first().click();
    const chatTab = page
      .getByRole("tablist", { name: "工作区视图" })
      .getByRole("tab", { name: "聊天", exact: true });
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
    if ((await current.locator(".process-header").getAttribute("aria-expanded")) === "false")
      await current.locator(".process-header").click();
    await current.getByRole("button", { name: "思考摘要", exact: true }).first().click();
    await page.getByText("等待中的公开摘要", { exact: true }).waitFor();
    await page.getByRole("button", { name: "停止回复", exact: true }).click();
    await page
      .locator(".message.assistant .message-text")
      .filter({ hasText: "请求已停止。" })
      .waitFor();
    // 停止消息先到达，运行终态由随后的会话事件提交。
    await page.waitForFunction(() =>
      Array.from(document.querySelectorAll(".turn-process .process-header"))
        .at(-1)
        ?.textContent?.includes("已停止"),
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
    await rm(root, { recursive: true, force: true });
  }
});
