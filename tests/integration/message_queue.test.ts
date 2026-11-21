import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { launchElectron, openTestProject } from "./support.ts";

test("运行中默认排队，箭头升级插话，可取消单条并在停止后继续", { timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-queue-ui-"));
  const requests: string[] = [];
  let streaming: ServerResponse | undefined;
  const chunk = (content: string, finish: string | null = null) =>
    `data: ${JSON.stringify({ id: "r", object: "chat.completion.chunk", created: 1, model: "queue", choices: [{ index: 0, delta: { content }, finish_reason: finish }] })}\n\n`;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const part of request) body += part;
    requests.push(body);
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (requests.length === 1 || requests.length === 4) {
      streaming = response;
      response.write(chunk(`正在输出 ${requests.length}`));
    } else response.end(`${chunk(`回答 ${requests.length}`, "stop")}data: [DONE]\n\n`);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const app = await launchElectron(join(root, "profile"));
  try {
    const page = await app.firstWindow();
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
          models: [{ id: "queue", name: "Queue", context: 8192, output: 1024, reasoning: "标准" }],
        }),
      `http://127.0.0.1:${address.port}/v1`,
    );
    await openTestProject(app, page, root);
    const input = page.getByRole("textbox", { name: "消息内容", exact: true });
    await input.fill("开始任务");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await page.getByText("正在输出 1", { exact: true }).waitFor();
    await input.fill("插话 A");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    const queue = page.getByRole("region", { name: "待处理消息" });
    await queue.getByText("插话 A", { exact: true }).waitFor();
    assert.equal(
      await page.getByRole("button", { name: "运行中发送方式", exact: true }).count(),
      0,
    );
    assert.equal(await queue.getByText("完成后发送", { exact: true }).count(), 1);
    await input.fill("后续 B");
    await input.press("Enter");
    await queue.getByText("后续 B", { exact: true }).waitFor();
    await input.fill("取消 C");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await queue.getByRole("button", { name: "取消待处理消息：取消 C", exact: true }).click();
    await queue.getByText("取消 C", { exact: true }).waitFor({ state: "hidden" });
    assert.equal(await queue.locator("li").count(), 2);
    const arrow = queue.getByRole("button", { name: "改为插话：插话 A", exact: true });
    await arrow.click();
    await arrow.waitFor({ state: "hidden" });
    await queue.getByText("等待插话", { exact: true }).waitFor();
    assert.equal(
      await queue.getByRole("button", { name: "改为插话：后续 B", exact: true }).count(),
      1,
    );
    assert.equal(requests.length, 1);
    streaming?.end(`${chunk("", "stop")}data: [DONE]\n\n`);
    await page.getByText("回答 3", { exact: true }).waitFor();
    await queue.waitFor({ state: "hidden" });
    assert.equal(requests.length, 3);
    assert.ok(requests[1]?.includes("插话 A"));
    assert.ok(!requests[1]?.includes("后续 B"));
    assert.ok(requests[2]?.includes("后续 B"));
    assert.ok(requests.every((body) => !body.includes("取消 C")));
    await page.getByRole("button", { name: "发送消息", exact: true }).waitFor();
    await input.fill("再次执行");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await page.getByText("正在输出 4", { exact: true }).waitFor();
    await input.fill("停止后保留");
    await input.press("Enter");
    await queue.getByText("停止后保留", { exact: true }).waitFor();
    await page.getByRole("button", { name: "停止回复", exact: true }).click();
    const resume = queue.getByRole("button", { name: "继续发送", exact: true });
    await resume.waitFor();
    assert.equal(requests.length, 4);
    await input.fill("保留编辑中的草稿");
    await resume.click();
    await page.getByText("回答 5", { exact: true }).waitFor();
    await queue.waitFor({ state: "hidden" });
    assert.equal(await input.inputValue(), "保留编辑中的草稿");
    assert.equal(requests.length, 5);
  } finally {
    streaming?.end();
    await app.close();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(root, { recursive: true, force: true });
  }
});
