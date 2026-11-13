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
  "```mermaid",
  "flowchart TD",
  "  A[读取任务] --> B[执行抓取]",
  "```",
  "",
  "```mermaid",
  "flowchart TD",
  ...Array.from({ length: 20 }, (_, index) => `  N${index}[步骤${index}] --> N${index + 1}`),
  "```",
  "",
  "```mermaid",
  "flowchart TD\n A -->",
  "```",
  "",
  "[文档](https://example.com/document)",
  "[无效链接](javascript:alert(1))",
  "![外部图片](https://example.com/never-fetch.png)",
  "<script>window.untrustedMarkdownExecuted=true</script>",
].join("\n");

test("Electron selects native reasoning, renders streamed/history GFM and keeps narrow/dark layouts usable", {
  timeout: 60_000,
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "dai-markdown-"));
  let release = () => {};
  const finished = new Promise<void>((resolve) => {
    release = resolve;
  });
  const planner = await servePlanner((request) => {
    const user = request.messages.filter((message) => message.role === "user").at(-1)?.content;
    if (user?.includes("应用事件：用户已进入场景搭建")) return { text: "请问是什么场景？" };
    return !turnResults(request).count
      ? {
          id: "read",
          name: "read",
          args: { path: join(root, "project", "missing.json") },
          thinking: "**公开摘要**：检查模型状态。",
        }
      : { text: response, splitAt: response.indexOf("| 状态"), beforeFinish: finished };
  });
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
    await page.getByRole("button", { name: "新建项目", exact: true }).first().waitFor();
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
    assert.equal(
      await page.locator(".markdown pre code.language-json").textContent(),
      '{"revision": 12}\n',
    );
    const diagram = page.getByRole("img", { name: "Mermaid 图表" }).first();
    await diagram.waitFor({ timeout: 15_000 });
    assert.equal(
      await diagram.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0),
      true,
    );
    assert.match(decodeURIComponent((await diagram.getAttribute("src")) ?? ""), /读取任务/);
    const tallDiagram = page.getByRole("img", { name: "Mermaid 图表" }).nth(1);
    await tallDiagram.waitFor({ timeout: 15_000 });
    const fit = await tallDiagram.evaluate((image: HTMLImageElement) => {
      const box = image.getBoundingClientRect();
      const container = image.parentElement?.getBoundingClientRect();
      return {
        width: box.width,
        height: box.height,
        containerWidth: container?.width ?? 0,
        viewportHeight: innerHeight,
        naturalRatio: image.naturalWidth / image.naturalHeight,
      };
    });
    assert.ok(fit.width <= fit.containerWidth + 1);
    assert.ok(fit.height <= fit.viewportHeight * 0.65 + 1);
    assert.ok(Math.abs(fit.width / fit.height - fit.naturalRatio) < 0.01, JSON.stringify(fit));
    await page.getByRole("button", { name: "展开查看" }).first().click();
    const preview = page.getByRole("dialog", { name: "查看图表" });
    await preview.waitFor();
    await page.screenshot({ path: "out/mermaid-expanded.png" });
    const expandedDiagram = preview.getByRole("img", { name: "放大的 Mermaid 图表" });
    const originalWidth = await expandedDiagram.evaluate(
      (image) => image.getBoundingClientRect().width,
    );
    await preview.getByRole("button", { name: "放大图表" }).click();
    assert.ok(
      (await expandedDiagram.evaluate((image) => image.getBoundingClientRect().width)) >
        originalWidth,
    );
    await preview.getByRole("button", { name: "缩小图表" }).click();
    assert.equal(
      await expandedDiagram.evaluate((image) => image.getBoundingClientRect().width),
      originalWidth,
    );
    await preview.getByRole("button", { name: "原始大小" }).click();
    assert.equal(await preview.getByText("100%", { exact: true }).count(), 1);
    await page.keyboard.press("Escape");
    await preview.waitFor({ state: "hidden" });
    assert.match(
      (await page.locator(".markdown pre code").allTextContents()).join("\n"),
      /flowchart TD\n A -->/,
    );
    assert.equal(await page.locator('.markdown a[href^="javascript:"]').count(), 0);
    assert.equal(
      await page.locator(".markdown script, .markdown img:not(.mermaid-diagram img)").count(),
      0,
    );
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
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await page.screenshot({ path: "out/markdown-thinking-light.png" });
    await page.evaluate(() => window.desktop.application.updateSettings({ theme: "dark" }));
    await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
    await diagram.waitFor({ timeout: 15_000 });
    await page.screenshot({ path: "out/markdown-thinking-dark.png" });
    await page.reload();
    await page.locator(".conversation-row").first().click();
    await page.getByRole("cell", { name: "已保存", exact: true }).waitFor();
    await diagram.waitFor({ timeout: 15_000 });
    assert.match(
      (await page.getByRole("button", { name: "推理档位", exact: true }).textContent()) ?? "",
      /high/,
    );
    assert.equal(planner.requests.length, 2, "Restoring history must not replay a model request");
    assert.deepEqual(planner.failures, []);
    assert.deepEqual(errors, []);
  } catch (error) {
    const page = await app.firstWindow();
    context.diagnostic(
      JSON.stringify(
        await page.evaluate(() => ({
          tab: document.querySelector(".workspace")?.getAttribute("data-mobile-tab"),
          width: innerWidth,
          diagrams: document.querySelectorAll(".mermaid-diagram").length,
          source: Array.from(document.querySelectorAll(".markdown pre code")).map(
            (element) => element.textContent,
          ),
        })),
      ),
    );
    await page.screenshot({ path: "out/markdown-thinking-failure.png" });
    throw error;
  } finally {
    release();
    if (child.exitCode === null) await app.close();
    await planner.close();
    await rm(root, { recursive: true, force: true });
  }
});
