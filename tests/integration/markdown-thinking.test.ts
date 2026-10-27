import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { _electron as electron } from "playwright";
import { servePlanner, turnResults } from "../support/planner.ts";
import { openTestProject } from "./support.ts";

const response = [
  "## 定位结果",
  "",
  "**已完成**，保留原模型。",
  "",
  "| 项 | 值 |",
  "| --- | --- |",
  "| min | (0, 0, 0) |",
  "| 状态 | 已保存 |",
  "",
  "- 保留颜色",
  "- 保留层级",
  "",
  "> 使用米为单位。",
  "",
  "```json",
  '{"revision": 12}',
  "```",
  "",
  "[文档](https://example.com/document)",
  "[无效链接](javascript:alert(1))",
  "![外部图片](https://example.com/never-fetch.png)",
  "<script>window.untrustedMarkdownExecuted=true</script>",
].join("\n");

test("Electron selects native reasoning, renders streamed/history GFM and keeps narrow/dark layouts usable", {
  timeout: 60_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-markdown-"));
  let release = () => {};
  const finished = new Promise<void>((resolve) => {
    release = resolve;
  });
  const planner = await servePlanner((request) =>
    !turnResults(request).count
      ? {
          id: "read",
          name: "read",
          args: { path: join(root, "project", "missing.json") },
          thinking: "**公开摘要**：检查模型状态。",
        }
      : { text: response, splitAt: response.indexOf("| 状态"), beforeFinish: finished },
  );
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (item): item is [string, string] =>
        item[0] !== "ELECTRON_RUN_AS_NODE" && item[1] !== undefined,
    ),
  );
  const app = await electron.launch({
    args: [process.cwd(), `--user-data-dir=${root}`],
    env,
    chromiumSandbox: true,
  });
  const child = app.process();
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(8000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.getByRole("button", { name: "打开项目", exact: true }).first().waitFor();
    await page.evaluate(async (endpoint) => {
      const api = window.desktop.application;
      const login = await api.startLogin("deepseek", "api_key");
      if (!login.prompt) throw new Error("Missing local test login prompt");
      await api.answerLogin(login.id, login.prompt.id, "isolated-ui-key");
      const config = {
        id: "reasoning",
        providerType: "deepseek",
        name: "Native UI test",
        authMethod: "api_key" as const,
        endpoint,
        enabled: true,
        persistCredentials: false,
        models: [],
      };
      const catalog = await api.getModels(config, login.id, false);
      const model = catalog.find((item) => item.thinkingLevels?.includes("low"));
      if (!model) throw new Error("Missing native reasoning model");
      await api.saveProvider({ ...config, models: [{ ...model, output: 4096 }] }, login.id);
    }, planner.endpoint);
    await openTestProject(app, page, root);
    const thinking = page.getByRole("button", { name: "推理档位", exact: true });
    await thinking.click();
    assert.equal(
      await page.getByRole("menuitemradio", { name: "medium", exact: true }).count(),
      0,
      "Unsupported native levels must not be offered",
    );
    await page.getByRole("menuitemradio", { name: "high", exact: true }).click();
    await page.waitForFunction(
      async () =>
        (await window.desktop.application.getWorkspace()).conversations[0]?.thinkingLevel ===
        "high",
    );
    await page.getByRole("button", { name: "通用对话", exact: true }).click();
    await page.getByRole("menuitem", { name: /^场景搭建/ }).click();
    await page
      .getByRole("textbox", { name: "消息内容", exact: true })
      .fill("检查状态，以 Markdown 返回");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await page.getByRole("cell", { name: "(0, 0, 0)", exact: true }).waitFor();
    assert.equal(await thinking.isDisabled(), true);
    assert.equal(
      await page.getByRole("button", { name: "停止回复", exact: true }).isVisible(),
      true,
    );
    release();
    await page.getByRole("cell", { name: "已保存", exact: true }).waitFor();
    await page.getByRole("button", { name: "发送消息", exact: true }).waitFor();
    assert.equal(planner.requests.length, 2);
    assert.ok(
      planner.requests.every(
        (request) => request.thinking?.type === "enabled" && request.reasoning_effort === "high",
      ),
    );
    await page.getByRole("heading", { name: "定位结果", exact: true }).waitFor();
    assert.equal(await page.locator(".markdown strong").filter({ hasText: "已完成" }).count(), 1);
    assert.equal(await page.locator(".markdown pre code").textContent(), '{"revision": 12}\n');
    assert.equal(await page.locator('.markdown a[href^="javascript:"]').count(), 0);
    assert.equal(await page.locator(".markdown script, .markdown img").count(), 0);
    const opened = app.evaluate(
      ({ shell }) =>
        new Promise<string>((resolve) => {
          shell.openExternal = async (url) => {
            resolve(url);
          };
        }),
    );
    await page.getByRole("link", { name: "文档", exact: true }).click();
    assert.equal(await opened, "https://example.com/document");
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setContentSize(840, 700),
    );
    await page.getByRole("tab", { name: "聊天", exact: true }).click();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await page.screenshot({ path: "out/markdown-thinking-light.png" });
    await page.evaluate(() => window.desktop.application.updateSettings({ theme: "dark" }));
    await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
    await page.screenshot({ path: "out/markdown-thinking-dark.png" });
    await page.reload();
    await page.locator(".conversation-row").first().click();
    await page.getByRole("tab", { name: "聊天", exact: true }).click();
    await page.getByRole("cell", { name: "已保存", exact: true }).waitFor();
    assert.match(
      (await page.getByRole("button", { name: "推理档位", exact: true }).textContent()) ?? "",
      /high/,
    );
    assert.equal(planner.requests.length, 2, "Restoring history must not replay a model request");
    assert.deepEqual(planner.failures, []);
    assert.deepEqual(errors, []);
  } finally {
    release();
    if (child.exitCode === null) await app.close();
    await planner.close();
    await rm(root, { recursive: true, force: true });
  }
});
