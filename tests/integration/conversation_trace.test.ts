import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { _electron as electron } from "playwright";
import { createPiHistory } from "../../src/backend/agent/pi_history.ts";
import { openProjectStore } from "../../src/backend/projects/store.ts";

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

test("统一轨迹入口展示角色、历史系统注入、工具定义和完整结果，切换会话不串数据", {
  timeout: 60000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-trace-ui-"));
  const profile = join(root, "profile");
  const dataRoot = join(profile, "data");
  const cwd = join(root, "project");
  await mkdir(cwd);
  const store = openProjectStore(dataRoot);
  let userId = "",
    toolId = "",
    secondResponse = "",
    conversationId = "";
  try {
    const project = store.createProject({ name: "轨迹项目", mode: "coding", path: cwd });
    const conversation = store.createConversation(project.id);
    conversationId = conversation.id;
    const history = createPiHistory(store, dataRoot);
    const session = history.open(conversation.id);
    session.appendMessage({
      role: "system",
      content: "BASE_SYSTEM_PROMPT",
      sections: { preamble: "基础指令" },
      toolsAdded: [
        {
          name: "fetch_content",
          description: "读取网页工具定义",
          parameters: { type: "object", properties: { url: { type: "string" } } },
        },
      ],
      timestamp: 1,
    });
    userId = session.appendMessage({ role: "user", content: "检查网页请求", timestamp: 2 });
    session.appendMessage({
      role: "system",
      content: "",
      sections: { ponytail: "PONYTAIL MODE ACTIVE — level: full" },
      timestamp: 3,
    });
    session.appendCustomMessageEntry("runtime-rules", "HIDDEN_PLUGIN_INJECTION", false);
    session.appendMessage({
      role: "assistant",
      provider: "fixture",
      api: "openai-completions",
      model: "fixture",
      usage,
      stopReason: "toolUse",
      timestamp: 4,
      content: [
        {
          type: "toolCall",
          id: "fetch-1",
          name: "fetch_content",
          arguments: { url: "https://example.com", api_key: "SHOULD_BE_HIDDEN" },
        },
      ],
    });
    toolId = session.appendMessage({
      role: "toolResult",
      toolName: "fetch_content",
      toolCallId: "fetch-1",
      content: [{ type: "text", text: `${"正文".repeat(5000)} COMPLETE_RESULT_END` }],
      isError: true,
      timestamp: 5,
    });
    session.appendMessage({
      role: "assistant",
      provider: "fixture",
      api: "openai-completions",
      model: "fixture",
      usage,
      stopReason: "stop",
      timestamp: 6,
      content: [{ type: "text", text: "第一轮回答" }],
    });
    session.appendMessage({ role: "user", content: "切换规则继续", timestamp: 7 });
    session.appendMessage({
      role: "system",
      content: "",
      sections: { ponytail: null },
      toolsRemoved: [{ name: "fetch_content" }],
      toolsAdded: [{ name: "write", description: "新的写入定义", parameters: { type: "object" } }],
      timestamp: 8,
    });
    secondResponse = session.appendMessage({
      role: "assistant",
      provider: "fixture",
      api: "openai-completions",
      model: "fixture",
      usage,
      stopReason: "stop",
      timestamp: 9,
      content: [{ type: "text", text: "第二轮回答" }],
    });
    store.updateConversation(conversation.id, { title: "轨迹验收", hasMessages: true });
    const other = store.createConversation(project.id);
    const otherSession = history.open(other.id);
    otherSession.appendMessage({ role: "user", content: "另一条旧对话", timestamp: 1 });
    otherSession.appendMessage({
      role: "assistant",
      provider: "fixture",
      api: "openai-completions",
      model: "fixture",
      usage,
      stopReason: "stop",
      timestamp: 2,
      content: [{ type: "text", text: "旧版记录回答" }],
    });
    store.updateConversation(other.id, { title: "没有系统快照", hasMessages: true });
  } finally {
    store.close();
  }
  const app = await electron.launch({
    args: [process.cwd(), `--user-data-dir=${profile}`],
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
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setContentSize(1800, 900),
    );
    await page.getByRole("button", { name: "轨迹验收", exact: true }).click();
    await page.getByText("第二轮回答", { exact: true }).waitFor();
    assert.equal(await page.getByText("BASE_SYSTEM_PROMPT", { exact: true }).count(), 0);
    assert.equal(await page.getByText("HIDDEN_PLUGIN_INJECTION", { exact: true }).count(), 0);
    await page.getByRole("tab", { name: "轨迹", exact: true }).click();
    const trace = page.getByRole("region", { name: "对话轨迹" });
    await trace.locator(".trace-record").first().waitFor();
    const layout = await trace.evaluate((element) => {
      const column = element.closest(".message-column");
      const messages = element.closest(".messages");
      const summary = element.querySelector(".trace-record > summary");
      if (!column || !messages || !summary) throw new Error("Missing trace layout");
      const style = getComputedStyle(messages);
      return {
        column: column.getBoundingClientRect().width,
        available:
          messages.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
        rowHeight: summary.getBoundingClientRect().height,
      };
    });
    assert.ok(layout.column > 800, "轨迹不受聊天列的 800px 宽度限制");
    assert.ok(Math.abs(layout.column - layout.available) < 2, "轨迹填满消息区可用宽度");
    assert.ok(layout.rowHeight >= 36 && layout.rowHeight <= 44, "轨迹行更紧凑且保留点击区域");
    const narrowPreview = await trace.evaluate((element) => {
      const column = element.closest<HTMLElement>(".message-column");
      const preview = element.querySelector<HTMLElement>(".trace-preview");
      if (!column || !preview) throw new Error("Missing trace layout");
      column.style.width = "400px";
      const basis = getComputedStyle(preview).flexBasis;
      column.style.removeProperty("width");
      return basis;
    });
    assert.equal(narrowPreview, "100%", "宽窗口中的窄轨迹面板也应换行显示预览");
    for (const role of ["system", "user", "assistant", "tool"])
      assert.ok(await trace.locator(`.role-${role}`).count());
    const colors = await trace.evaluate((element) =>
      ["system", "user", "assistant", "tool"].map((role) => {
        const row = element.querySelector(`.role-${role}`);
        if (!row) throw new Error(`Missing trace role: ${role}`);
        return getComputedStyle(row).borderLeftColor;
      }),
    );
    assert.equal(new Set(colors).size, 4, "角色配色需要可区分，角色文字始终保留");
    const user = trace.locator(`[data-entry-id="${userId}"]`);
    await user.locator(":scope > summary").click();
    await user.locator(".trace-context > summary").click();
    await user
      .locator("summary")
      .filter({ hasText: /^ponytail$/ })
      .click();
    await user.getByText("PONYTAIL MODE ACTIVE — level: full", { exact: true }).waitFor();
    const injection = user.getByRole("region", { name: "插件消息与上下文注入" });
    await injection
      .locator("summary")
      .filter({ hasText: /^runtime-rules$/ })
      .click();
    await injection.getByText("HIDDEN_PLUGIN_INJECTION", { exact: true }).waitFor();
    await user
      .getByRole("region", { name: "本次可用工具定义" })
      .locator("summary")
      .filter({ hasText: /^fetch_content$/ })
      .click();
    await user.getByText("读取网页工具定义", { exact: true }).waitFor();
    assert.equal(await user.getByText("新的写入定义", { exact: true }).count(), 0);
    const result = trace.locator(`[data-entry-id="${toolId}"]`);
    await result.locator(":scope > summary").click();
    await result
      .getByRole("region", { name: "工具返回内容" })
      .locator("pre")
      .filter({ hasText: "COMPLETE_RESULT_END" })
      .waitFor();
    assert.ok((await result.textContent())?.includes("[已隐藏]"));
    assert.ok(!(await trace.textContent())?.includes("SHOULD_BE_HIDDEN"));
    const next = trace.locator(`[data-entry-id="${secondResponse}"]`);
    await next.locator(":scope > summary").click();
    await next.locator(".trace-context > summary").click();
    const definitions = next.getByRole("region", { name: "本次可用工具定义" });
    await definitions
      .locator("summary")
      .filter({ hasText: /^write$/ })
      .waitFor();
    assert.equal(
      await definitions
        .locator("summary")
        .filter({ hasText: /^fetch_content$/ })
        .count(),
      0,
    );
    assert.equal(
      await next
        .locator("summary")
        .filter({ hasText: /^ponytail$/ })
        .count(),
      0,
    );
    await page.screenshot({ path: "/tmp/dai-trace-light.png" });
    await page.evaluate(() => window.desktop.application.updateSettings({ theme: "dark" }));
    await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
    await page.screenshot({ path: "/tmp/dai-trace-dark.png" });
    const before = await page.evaluate(
      (id) => window.desktop.application.watchConversation(id),
      conversationId,
    );
    assert.equal(
      before.messages.some((message) => message.role === ("system" as string)),
      false,
      "聊天仍使用原来的投影",
    );
    await page.getByRole("button", { name: "没有系统快照", exact: true }).click();
    await trace.getByText("另一条旧对话", { exact: true }).waitFor();
    const old = trace.locator(".role-user");
    await old.locator(":scope > summary").click();
    await old.locator(".trace-context > summary").click();
    await old.getByText("这段历史没有记录系统提示或工具定义。", { exact: true }).waitFor();
    assert.equal(
      await trace.getByText("PONYTAIL MODE ACTIVE — level: full", { exact: true }).count(),
      0,
    );
    await page
      .getByRole("tablist", { name: "对话视图" })
      .getByRole("tab", { name: "聊天", exact: true })
      .click();
    await page.getByText("旧版记录回答", { exact: true }).waitFor();
    const chatBounds = await page.locator(".message-column").boundingBox();
    assert.ok(chatBounds && chatBounds.width <= 800, "切回聊天后保留原有宽度限制");
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
