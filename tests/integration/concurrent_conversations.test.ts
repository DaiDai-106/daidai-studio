import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { chooseProject, launchTestApp, openTestProject } from "./support.ts";

const chunk = (content: string, finish: string | null = null) =>
  `data: ${JSON.stringify({ id: "r", object: "chat.completion.chunk", created: 1, model: "parallel", choices: [{ index: 0, delta: { content }, finish_reason: finish }] })}\n\n`;

test("会话可后台并行，切换和新建项目不打断任务，停止与恢复队列仅影响当前会话", {
  timeout: 60000,
}, async (context) => {
  const { application, page, profile } = await launchTestApp(context);
  const streams = new Map<string, ServerResponse>();
  const requests: { text: string; body: string }[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const part of request) body += part;
    const messages = (
      JSON.parse(body) as {
        messages: { role: string; content: string | { text?: string }[] }[];
      }
    ).messages;
    const content = messages.filter((message) => message.role === "user").at(-1)?.content;
    const text =
      typeof content === "string"
        ? content
        : (content?.map((part) => part.text ?? "").join("") ?? "");
    requests.push({ text, body });
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (text === "任务 A" || text === "任务 B") {
      streams.set(text, response);
      response.write(chunk(`${text} 正在输出`));
    } else response.end(`${chunk(`${text} 已完成`, "stop")}data: [DONE]\n\n`);
  });
  context.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  page.setDefaultTimeout(10000);
  await page.evaluate(
    (endpoint) =>
      window.desktop.application.saveProvider({
        id: "local",
        name: "Local",
        providerType: "local",
        authMethod: "none",
        endpoint,
        enabled: true,
        models: [
          { id: "parallel", name: "Parallel", context: 8192, output: 1024, reasoning: "标准" },
        ],
      }),
    `http://127.0.0.1:${address.port}/v1`,
  );
  await openTestProject(application, page, profile);
  const input = page.getByRole("textbox", { name: "消息内容", exact: true });
  const send = page.getByRole("button", { name: "发送消息", exact: true });
  const queue = page.getByRole("region", { name: "待处理消息" });
  const sidebar = page.getByRole("complementary", { name: "项目侧栏" });
  await input.fill("任务 A");
  await send.click();
  await page.getByText("任务 A 正在输出", { exact: true }).waitFor();
  await input.fill("A 待恢复");
  await send.click();
  await queue.getByText("A 待恢复", { exact: true }).waitFor();
  await input.fill("A 草稿");

  await page.getByRole("button", { name: "新建对话", exact: true }).click();
  await page.locator(".assistant-navigation strong").filter({ hasText: "新会话" }).waitFor();
  await input.fill("任务 B");
  await send.click();
  await page.getByText("任务 B 正在输出", { exact: true }).waitFor();
  await page.waitForFunction(
    async () => (await window.desktop.application.getWorkspace()).busyConversationIds.length === 2,
  );
  assert.equal(await sidebar.getByRole("status", { name: "正在回复" }).count(), 2);
  await input.fill("B 后续");
  await send.click();
  await queue.getByText("B 后续", { exact: true }).waitFor();
  await input.fill("B 草稿");

  await sidebar.locator(".project-title").first().click();
  await page.locator(".assistant-navigation strong").filter({ hasText: "AI 助手" }).waitFor();
  const other = join(profile, "other");
  await mkdir(other);
  await chooseProject(application, page, other);
  assert.equal(await input.inputValue(), "");
  assert.equal(await sidebar.getByRole("status", { name: "正在回复" }).count(), 2);

  await sidebar.locator('.conversation-title[title="任务 A"]').click();
  await page.getByText("任务 A 正在输出", { exact: true }).waitFor();
  assert.equal(await input.inputValue(), "A 草稿");
  assert.equal(await queue.getByText("B 后续", { exact: true }).count(), 0);
  const a = await page.evaluate(async () =>
    (await window.desktop.application.getWorkspace()).conversations.find(
      (item) => item.title === "任务 A",
    ),
  );
  assert.ok(a);
  await page.getByRole("button", { name: "停止回复", exact: true }).click();
  await queue.getByRole("button", { name: "继续发送", exact: true }).waitFor();
  await page.waitForFunction(async (id) => {
    const ids = (await window.desktop.application.getWorkspace()).busyConversationIds;
    return ids.length === 1 && !ids.includes(id);
  }, a.id);
  assert.equal(await sidebar.getByRole("status", { name: "正在回复" }).count(), 1);
  assert.deepEqual(
    requests.map((item) => item.text),
    ["任务 A", "任务 B"],
  );

  // B 在后台结束并处理自己的队列，不能覆盖正在查看的 A 或恢复 A 的队列。
  streams.get("任务 B")?.end(`${chunk("", "stop")}data: [DONE]\n\n`);
  await page.waitForFunction(
    async () => !(await window.desktop.application.getWorkspace()).busyConversationIds.length,
  );
  assert.equal(await queue.getByText("A 待恢复", { exact: true }).isVisible(), true);
  assert.equal(await page.getByText("B 后续 已完成", { exact: true }).count(), 0);
  await sidebar.locator('.conversation-title[title="任务 B"]').click();
  await page.getByText("B 后续 已完成", { exact: true }).waitFor();
  await queue.waitFor({ state: "hidden" });
  assert.equal(await input.inputValue(), "B 草稿");
  assert.equal(await page.getByRole("button", { name: "停止回复", exact: true }).count(), 0);

  await sidebar.locator('.conversation-title[title="任务 A"]').click();
  await queue.getByRole("button", { name: "继续发送", exact: true }).click();
  await page.getByText("A 待恢复 已完成", { exact: true }).waitFor();
  await queue.waitFor({ state: "hidden" });
  assert.equal(await input.inputValue(), "A 草稿");
  assert.deepEqual(
    requests.map((item) => item.text),
    ["任务 A", "任务 B", "B 后续", "A 待恢复"],
  );
  for (const request of requests) {
    assert.equal(
      request.body.includes(
        request.text.startsWith("B") || request.text === "任务 B" ? "任务 A" : "任务 B",
      ),
      false,
    );
  }
});
