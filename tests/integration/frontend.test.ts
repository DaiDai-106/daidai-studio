import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { _electron as electron } from "playwright";
import { openTestProject } from "./support.ts";

test("desktop configures a real local service, streams chat and restores Pi history", {
  timeout: 60000,
}, async () => {
  const profile = await mkdtemp(join(tmpdir(), "dai-real-ui-"));
  let requestCount = 0;
  let authorization: string | undefined;
  const server = createServer(async (request, response) => {
    if (request.url === "/v1/models") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ data: [{ id: "ui-test-model" }] }));
      return;
    }
    requestCount++;
    authorization = request.headers.authorization;
    for await (const _chunk of request) {
      /* Drain the SDK request. */
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write(
      `data: ${JSON.stringify({ id: "ui-response", object: "chat.completion.chunk", created: 1, model: "ui-test-model", choices: [{ index: 0, delta: { role: "assistant", content: "本地服务的真实协议回复" }, finish_reason: null }] })}\n\n`,
    );
    response.write(
      `data: ${JSON.stringify({ id: "ui-response", object: "chat.completion.chunk", created: 1, model: "ui-test-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
    );
    response.write(
      `data: ${JSON.stringify({ id: "ui-response", object: "chat.completion.chunk", created: 1, model: "ui-test-model", choices: [], usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100, prompt_tokens_details: { cached_tokens: 800 } } })}\n\n`,
    );
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
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
  let application = await launch();
  let child = application.process();
  try {
    let page = await application.firstWindow();
    page.setDefaultTimeout(7000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await openTestProject(application, page, profile);
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "AI 设置", exact: true }).click();
    await page.getByRole("button", { name: "添加 AI 服务", exact: true }).click();
    await page.getByRole("button", { name: "模型提供方", exact: true }).click();
    await page.getByRole("menuitemradio", { name: "本地 OpenAI Compatible", exact: true }).click();
    await page.getByLabel("服务名称", { exact: true }).fill("UI 本地服务");
    await page.getByLabel("API 地址", { exact: true }).fill(`http://127.0.0.1:${address.port}/v1`);
    await page.getByRole("button", { name: "认证方式", exact: true }).click();
    await page.getByRole("menuitemradio", { name: "API Key", exact: true }).click();
    await page.getByRole("button", { name: "配置 API Key", exact: true }).click();
    await page.getByRole("button", { name: "取消授权", exact: true }).click();
    await page.getByRole("button", { name: "配置 API Key", exact: true }).click();
    await page.getByLabel("Enter API Key", { exact: true }).fill("isolated-ui-test-key");
    await page.getByRole("button", { name: "继续认证", exact: true }).click();
    await page.getByRole("button", { name: "使用此认证", exact: true }).click();
    await page.getByRole("button", { name: "下一步：选择模型", exact: true }).click();
    await page.getByRole("button", { name: "读取服务模型目录", exact: true }).click();
    await page.getByRole("checkbox", { name: /^ui-test-model/ }).check();
    await page.getByRole("button", { name: "保存服务", exact: true }).click();
    await page.getByRole("heading", { name: "UI 本地服务", exact: true }).waitFor();
    await page.screenshot({ path: join(tmpdir(), "dai-real-ai-settings.png") });
    await page.getByRole("button", { name: "返回工作台", exact: true }).click();
    // Existing conversations retain their model, including an empty selection.
    await page.getByRole("button", { name: "选择模型", exact: true }).click();
    await page.getByRole("menuitem", { name: "ui-test-model · UI 本地服务", exact: true }).click();
    await page.getByRole("textbox", { name: "消息内容", exact: true }).fill("真实聊天验收");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await page.getByText("本地服务的真实协议回复", { exact: true }).waitFor();
    await page.getByRole("button", { name: "发送消息", exact: true }).waitFor();
    assert.equal(requestCount, 1);
    assert.equal(authorization, "Bearer isolated-ui-test-key");
    await page.locator(".message-author").getByText("ui-test-model", { exact: true }).waitFor();
    await page.getByRole("button", { name: "对话用量", exact: true }).click();
    const usageDialog = page.getByRole("dialog", { name: "对话用量", exact: true });
    await usageDialog.waitFor();
    assert.equal(
      await usageDialog.locator("dt", { hasText: "缓存命中率" }).locator("+ dd").textContent(),
      "80.0%",
    );
    assert.equal(
      await usageDialog.locator("dt", { hasText: "总 tokens" }).locator("+ dd").textContent(),
      "1,100",
    );
    assert.equal(
      await usageDialog.locator("dt", { hasText: "估算费用" }).locator("+ dd").textContent(),
      "未提供价格",
    );
    await usageDialog.getByRole("button", { name: "关闭弹窗", exact: true }).click();
    await page.getByRole("button", { name: "本次响应用量", exact: true }).click();
    await page
      .getByRole("dialog", { name: "本次响应用量", exact: true })
      .getByRole("button", { name: "关闭弹窗", exact: true })
      .click();
    await page.getByRole("textbox", { name: "消息内容", exact: true }).fill("重启后保留的草稿");
    await page.waitForFunction(
      async () =>
        (await window.desktop.application.getWorkspace()).conversations[0]?.draft ===
        "重启后保留的草稿",
    );
    const beforeRemoval = await page.evaluate(() => window.desktop.application.getWorkspace());
    const project = beforeRemoval.projects[0];
    assert.ok(project);
    const source = await readFile(join(project.path, "bracket.stp"));
    await page.getByRole("button", { name: `${project.name} 项目操作`, exact: true }).click();
    await page.getByRole("menuitem", { name: /^移除项目/ }).click();
    await page.locator(".project-group").waitFor({ state: "hidden" });
    await page.getByRole("heading", { name: "今天想和呆呆完成什么？", exact: true }).waitFor();
    assert.ok((await readFile(join(project.path, "bracket.stp"))).equals(source));
    await application.close();
    application = await launch();
    child = application.process();
    page = await application.firstWindow();
    page.setDefaultTimeout(7000);
    await page.getByRole("heading", { name: "今天想和呆呆完成什么？", exact: true }).waitFor();
    assert.deepEqual(
      (await page.evaluate(() => window.desktop.application.getWorkspace())).projects,
      [],
    );
    await page.getByRole("button", { name: "已隐藏项目" }).click();
    const hidden = page.getByRole("dialog", { name: "已隐藏项目" });
    await hidden.getByRole("button", { name: "恢复" }).click();
    await hidden.getByRole("button", { name: "关闭弹窗" }).click();
    await page.getByRole("button", { name: project.name, exact: true }).click();
    await page.locator(".conversation-title").first().click();
    await page.getByText("本地服务的真实协议回复", { exact: true }).waitFor();
    await page.getByRole("button", { name: "对话用量", exact: true }).waitFor();
    assert.equal(
      await page.getByRole("textbox", { name: "消息内容", exact: true }).inputValue(),
      "重启后保留的草稿",
    );
    assert.equal(requestCount, 1, "Restart must restore history without replaying requests.");
    const state = await page.evaluate(() => window.desktop.application.getWorkspace());
    assert.equal(state.projects[0]?.id, project.id);
    assert.equal(state.conversations[0]?.id, beforeRemoval.conversations[0]?.id);
    assert.equal(state.conversations.length, beforeRemoval.conversations.length);
    assert.equal(state.settings.providers[0]?.configured, true);
    assert.equal(state.projects[0]?.filesComplete, false);
    assert.equal(state.dataRoot, join(profile, "data"));
    assert.ok((await readFile(join(profile, "data", "projects.sqlite"))).length > 0);
    assert.equal(
      (await readFile(join(profile, "data", "projects.sqlite"))).includes(
        Buffer.from("isolated-ui-test-key"),
      ),
      false,
    );
    const credentials = await readFile(join(profile, "data", "auth.json"), "utf8");
    assert.ok(credentials.includes("isolated-ui-test-key"));
    assert.deepEqual(errors, []);
    await page.screenshot({ path: join(tmpdir(), "dai-real-chat.png") });
  } finally {
    if (child.exitCode === null) await application.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(profile, { recursive: true, force: true });
  }
});
