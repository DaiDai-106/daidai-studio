import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { _electron as electron } from "playwright";
import { FILE_SNAPSHOT_MARKER } from "../../src/shared/file_references.ts";
import { openTestProject } from "./support.ts";

test("连续流式帧不重新计算已完成轮次和历史文件链接", { timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-transcript-render-"));
  let requests = 0;
  let streaming: ServerResponse | undefined;
  const chunk = (content: string, finish: string | null = null) =>
    `data: ${JSON.stringify({ id: "r", object: "chat.completion.chunk", created: 1, model: "render", choices: [{ index: 0, delta: { content }, finish_reason: finish }] })}\n\n`;
  const server = createServer(async (request, response) => {
    for await (const _body of request) {
      /* 读取真实 Pi 请求。 */
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (++requests === 1) response.end(`${chunk("历史回答 `old.ts`", "stop")}data: [DONE]\n\n`);
    else {
      streaming = response;
      response.write(chunk("新回答开始"));
    }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const app = await electron.launch({
    args: [process.cwd(), `--user-data-dir=${join(root, "profile")}`],
    env: Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] =>
          entry[0] !== "ELECTRON_RUN_AS_NODE" && entry[1] !== undefined,
      ),
    ),
    chromiumSandbox: true,
  });
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
          models: [
            { id: "render", name: "Render", context: 8192, output: 1024, reasoning: "标准" },
          ],
        }),
      `http://127.0.0.1:${address.port}/v1`,
    );
    await openTestProject(app, page, root);
    const input = page.getByRole("textbox", { name: "消息内容" });
    const previousText = "这是已有对话";
    await input.fill(previousText);
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await page.getByRole("button", { name: "old.ts", exact: true }).waitFor();
    await input.fill("继续回答");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await page.getByText("新回答开始", { exact: true }).waitFor();
    const navigation = page.getByRole("navigation", { name: "跳转到用户消息" });
    assert.equal(await navigation.getByRole("button").count(), 2);
    await navigation.getByRole("button", { name: `跳转到第 1 条消息：${previousText}` }).click();
    const firstTurn = page.locator(".conversation-turn").first();
    assert.ok(
      await firstTurn.evaluate((element) => {
        const area = element.closest(".messages");
        return (
          area !== null &&
          element.getBoundingClientRect().top >= area.getBoundingClientRect().top - 1
        );
      }),
    );
    await page.getByRole("tab", { name: "轨迹" }).click();
    assert.equal(await navigation.count(), 0);
    await page.getByRole("tab", { name: "聊天" }).click();
    // 在浏览器侧计数实际组件的文本处理，不依赖 React 私有 Fiber 或生产调试开关。
    await page.evaluate(
      ({ text, marker }) => {
        const indexOf = String.prototype.indexOf;
        const trim = String.prototype.trim;
        const count = { user: 0, link: 0 };
        String.prototype.indexOf = function (needle, position) {
          if (String(this) === text && needle === marker) ++count.user;
          return indexOf.call(this, needle, position);
        };
        String.prototype.trim = function () {
          if (String(this) === "old.ts") ++count.link;
          return trim.call(this);
        };
        Object.defineProperty(window, "historyRenderChecks", { value: count });
      },
      { text: previousText, marker: FILE_SNAPSHOT_MARKER },
    );
    let output = "新回答开始";
    assert.ok(streaming);
    for (let i = 0; i < 5; i++) {
      const piece = `片段${i}`;
      output += piece;
      streaming.write(chunk(piece));
      await page.getByText(output, { exact: true }).waitFor();
    }
    assert.deepEqual(
      await page.evaluate(
        () =>
          (window as unknown as { historyRenderChecks: { user: number; link: number } })
            .historyRenderChecks,
      ),
      { user: 0, link: 0 },
    );
    await page.locator(".message.user .message-text", { hasText: previousText }).waitFor();
    streaming.end(`${chunk("", "stop")}data: [DONE]\n\n`);
    await page.getByRole("button", { name: "发送消息", exact: true }).waitFor();
    await page.getByText(output, { exact: true }).waitFor();
  } finally {
    streaming?.end();
    await app.close();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(root, { recursive: true, force: true });
  }
});
