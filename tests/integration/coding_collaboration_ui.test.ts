import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type ElectronApplication, _electron as electron } from "playwright";
import { chooseProject } from "./support.ts";

test("Coding 搜索、文件引用草稿恢复、真实模型上下文及聊天文件定位", {
  timeout: 60_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-coding-collaboration-"));
  const project = join(root, "project");
  await mkdir(join(project, "src"), { recursive: true });
  await writeFile(
    join(project, "src", "main.ts"),
    "// not selected\nconst second = 2;\nconst third = 3;\n// not selected end\n",
  );
  let requests = 0;
  let prompt = "";
  let releaseResponse!: () => void;
  const responseGate = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  const server = createServer(async (request, response) => {
    requests++;
    let body = "";
    for await (const chunk of request) body += chunk;
    const parsed = JSON.parse(body) as {
      messages: { role: string; content: string | { type: string; text?: string }[] }[];
    };
    prompt = parsed.messages
      .filter((message) => message.role === "user")
      .map((message) =>
        typeof message.content === "string"
          ? message.content
          : message.content
              .filter((part) => part.type === "text")
              .map((part) => part.text ?? "")
              .join("\n"),
      )
      .join("\n");
    await responseGate;
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(
      `data: ${JSON.stringify({ id: "response", object: "chat.completion.chunk", created: 1, model: "example", choices: [{ index: 0, delta: { role: "assistant", content: "查看 `src/main.ts:2` 或 [第三行](src/main.ts#L3)。" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[0] !== "ELECTRON_RUN_AS_NODE" && entry[1] !== undefined,
    ),
  );
  const launch = () =>
    electron.launch({
      args: [process.cwd(), `--user-data-dir=${join(root, "profile")}`],
      env,
      chromiumSandbox: true,
    });
  let app: ElectronApplication | undefined;
  try {
    app = await launch();
    let page = await app.firstWindow();
    page.setDefaultTimeout(10_000);
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900),
    );
    await chooseProject(app, page, project, "coding");
    await page.getByRole("button", { name: "展开代码工作区" }).click();
    await page.evaluate(async (port) => {
      const api = window.desktop.application;
      await api.saveProvider({
        id: "local",
        name: "Local",
        providerType: "local",
        authMethod: "none",
        endpoint: `http://127.0.0.1:${port}/v1`,
        enabled: true,
        models: [
          { id: "example", name: "Example", context: 4096, output: 1024, reasoning: "标准" },
        ],
      });
      const conversation = (await api.getWorkspace()).conversations[0];
      if (!conversation) throw new Error("缺少会话");
      await api.updateConversation({ id: conversation.id, modelId: "local:example" });
    }, address.port);
    const navigation = page.getByRole("complementary", { name: "项目文件与变更" });
    await navigation.getByRole("textbox", { name: "搜索项目文件" }).fill("main");
    await navigation.getByRole("button", { name: "src/main.ts", exact: true }).click();
    await page.getByRole("region", { name: "文件内容" }).waitFor();
    const input = page.getByRole("textbox", { name: "消息内容" });
    await input.fill("@mai");
    const picker = page.getByRole("region", { name: "引用项目文件" });
    await picker.getByRole("option", { name: "src/main.ts", exact: true }).waitFor();
    assert.equal(await input.evaluate((element) => element === document.activeElement), true);
    assert.equal(await picker.getByRole("textbox").count(), 0);
    assert.equal(await page.getByText("输入 @ 选择文件和行范围，发送时读取内容").count(), 0);
    const pickerSize = await picker.boundingBox();
    assert.ok(pickerSize && pickerSize.width <= 420 && pickerSize.height < 300);
    if (process.env.DAI_REFERENCE_SCREENSHOT) {
      await page.screenshot({ path: process.env.DAI_REFERENCE_SCREENSHOT, animations: "disabled" });
      await page.evaluate(() => window.desktop.application.updateSettings({ theme: "dark" }));
      await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
      await page.screenshot({
        path: `${process.env.DAI_REFERENCE_SCREENSHOT}.dark.png`,
        animations: "disabled",
      });
    }
    await input.press("Escape");
    await picker.waitFor({ state: "hidden" });
    assert.equal(await input.inputValue(), "@mai");
    await input.fill("@main.ts");
    await picker.getByRole("option", { name: "src/main.ts", exact: true }).waitFor();
    await input.press("ArrowDown");
    await input.press("Enter");
    assert.equal(await input.inputValue(), "");
    await page
      .locator(".composer")
      .getByRole("button", { name: "src/main.ts", exact: true })
      .waitFor();
    await page.getByRole("button", { name: "移除引用 src/main.ts", exact: true }).click();
    await input.fill("前文 后文");
    await input.evaluate((element) => {
      if (!(element instanceof HTMLTextAreaElement)) throw new Error("缺少输入框");
      element.setSelectionRange(3, 3);
    });
    await page.getByRole("button", { name: "引用项目文件", exact: true }).click();
    await picker.getByRole("option", { name: "src/main.ts", exact: true }).click();
    assert.equal(await input.inputValue(), "前文 后文");
    await page.getByRole("textbox", { name: "消息内容" }).fill("分析文件");
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    page.setDefaultTimeout(10_000);
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900),
    );
    await page.getByRole("button", { name: "project", exact: true }).click();
    await page.locator(".conversation-title").first().click();
    await page.getByRole("tab", { name: "main.ts", exact: true }).waitFor();
    assert.equal(await page.getByRole("textbox", { name: "消息内容" }).inputValue(), "分析文件");
    await page
      .locator(".composer")
      .getByRole("button", { name: "src/main.ts", exact: true })
      .waitFor();
    await page.getByRole("button", { name: "发送消息" }).click();
    await page.waitForFunction(
      async () => (await window.desktop.application.getWorkspace()).busyConversationIds.length > 0,
    );
    await page.getByRole("button", { name: "返回项目主页", exact: true }).click();
    await page.getByRole("heading", { name: "项目", exact: true }).waitFor();
    await page.locator(".conversation-title").first().click();
    await page.getByRole("button", { name: "停止回复", exact: true }).waitFor();
    await page.getByRole("status", { name: "正在回复", exact: true }).waitFor();
    assert.equal(await page.locator(".project-row.selected").count(), 0);
    if (process.env.DAI_BUSY_SCREENSHOT)
      await page.screenshot({ path: process.env.DAI_BUSY_SCREENSHOT, animations: "disabled" });
    releaseResponse();
    await page.getByRole("status", { name: "正在回复", exact: true }).waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "src/main.ts:2", exact: true }).waitFor();
    assert.equal(requests, 1);
    await page.locator(".conversation-title").getByText("分析文件", { exact: true }).waitFor();
    assert.equal(await page.locator(".file-snapshots[open]").count(), 0);
    await page.getByRole("button", { name: "收起代码工作区" }).click();
    const widths = await page.evaluate(() => {
      const message = document.querySelector(".message-column")?.getBoundingClientRect();
      const composer = document.querySelector(".composer-wrap")?.getBoundingClientRect();
      if (!message || !composer) throw new Error("缺少聊天内容");
      return { message: message.width, composer: composer.width };
    });
    assert.ok(Math.abs(widths.message - widths.composer) < 2);
    assert.ok(widths.composer <= 800);
    if (process.env.DAI_CODING_CHAT_SCREENSHOT)
      await page.screenshot({ path: process.env.DAI_CODING_CHAT_SCREENSHOT });
    await page.getByRole("button", { name: "展开代码工作区" }).click();

    const conversationId = await page.evaluate(
      async () => (await window.desktop.application.getWorkspace()).conversations[0]?.id,
    );
    assert.ok(conversationId);
    await page.evaluate(async (id) => {
      await window.desktop.application.updateConversation({ id, title: "手动命名" });
      await window.desktop.application.watchConversation(id);
    }, conversationId);
    await page.locator(".conversation-title").getByText("手动命名", { exact: true }).waitFor();
    await page.evaluate(async (id) => {
      await window.desktop.application.updateConversation({ id, title: "新会话" });
      await window.desktop.application.watchConversation(id);
    }, conversationId);
    await page.locator(".conversation-title").getByText("分析文件", { exact: true }).waitFor();
    assert.ok(prompt.includes("2: const second = 2;"));
    assert.ok(prompt.includes("3: const third = 3;"));
    assert.ok(prompt.includes("sha256"));
    assert.ok(prompt.includes("1: // not selected"));
    await page.getByRole("button", { name: "src/main.ts:2", exact: true }).click();
    await page.locator('.coding-line[data-file-line="2"][data-selected="true"]').waitFor();
    await page.getByRole("button", { name: "第三行", exact: true }).click();
    await page.locator('.coding-line[data-file-line="3"][data-selected="true"]').waitFor();
    assert.equal(await page.getByRole("tab", { name: "main.ts", exact: true }).count(), 1);
    await writeFile(
      join(project, "src", "main.ts"),
      "// not selected\nconst second = 2;\nconst third = 33;\n",
    );
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page
      .getByRole("region", { name: "文件内容" })
      .getByText("33", { exact: false })
      .waitFor();
    await page.getByRole("textbox", { name: "消息内容" }).fill('@"../secret.ts"');
    await page.getByRole("button", { name: "发送消息" }).click();
    await page.getByRole("alert").filter({ hasText: "文件引用无效" }).waitFor();
    assert.equal(requests, 1);
    assert.equal(
      await page.getByRole("textbox", { name: "消息内容" }).inputValue(),
      '@"../secret.ts"',
    );
  } finally {
    releaseResponse();
    await app?.close();
    server.closeAllConnections();
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});
