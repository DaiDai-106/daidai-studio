import { strict as assert } from "node:assert";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { openProjectStore } from "../../src/backend/projects/store.ts";
import { launchTestApp } from "./support.ts";

test("Dashboard 从空用量刷新，绘制模型趋势并支持筛选", {
  timeout: 60000,
}, async (context) => {
  const { page, profile } = await launchTestApp(context);
  page.setDefaultTimeout(10000);
  await page.evaluate(() =>
    window.desktop.application.saveProvider({
      id: "provider-test-id",
      name: "我的服务",
      providerType: "local",
      authMethod: "none",
      endpoint: "http://127.0.0.1:11434/v1",
      enabled: true,
      models: [{ id: "model", name: "Model", context: 8192, output: 1024, reasoning: "标准" }],
    }),
  );
  await page.getByRole("button", { name: "打开设置", exact: true }).click();
  const nav = page.getByRole("navigation", { name: "设置分类" });
  const labels = await nav.getByRole("button").allTextContents();
  assert.equal(labels.indexOf("Dashboard"), labels.indexOf("本地数据") + 1);
  assert.equal(labels.indexOf("信息"), labels.indexOf("Dashboard") + 1);
  await nav.getByRole("button", { name: "Dashboard", exact: true }).click();
  const calendar = page.locator(".usage-calendar");
  await calendar
    .getByRole("button", { name: /总计：0 Token.*无用量/ })
    .first()
    .waitFor();
  assert.equal(
    await page.getByRole("button", { name: "每天", exact: true }).getAttribute("aria-pressed"),
    "true",
  );
  const root = join(profile, "data");
  const store = openProjectStore(root);
  try {
    const project = store.createProject({ name: "测试项目", mode: "coding", path: profile });
    const directory = join(root, "agent", "sessions", project.id);
    await mkdir(directory, { recursive: true });
    const history = join(directory, "history.jsonl");
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(1);
    yesterday.setMonth(yesterday.getMonth() - 1);
    const lastYear = new Date(now.getFullYear() - 1, 0, 15, 12);
    const usage = (input: number) => ({
      input,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: input,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    });
    const entries = [
      { type: "session", version: 3, id: "session", timestamp: now.toISOString(), cwd: profile },
      {
        type: "usage",
        id: "a",
        parentId: null,
        timestamp: yesterday.toISOString(),
        provider: "provider-test-id",
        model: "模型甲",
        kind: "usage",
        usage: usage(100),
      },
      {
        type: "usage",
        id: "b",
        parentId: "a",
        timestamp: now.toISOString(),
        provider: "provider-test-id",
        model: "模型乙",
        kind: "usage",
        usage: usage(200),
      },
      {
        type: "usage",
        id: "c",
        parentId: "b",
        timestamp: now.toISOString(),
        provider: "removed-123456",
        model: "模型甲",
        kind: "usage",
        usage: usage(50),
      },
      {
        type: "usage",
        id: "d",
        parentId: "c",
        timestamp: lastYear.toISOString(),
        provider: "provider-test-id",
        model: "模型甲",
        kind: "usage",
        usage: usage(300),
      },
    ];
    await writeFile(history, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    const conversation = store.createConversation(project.id, "", history);
    store.updateConversation(conversation.id, { hasMessages: true, title: "不应显示的会话" });
  } finally {
    store.close();
  }
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await page.locator(".usage-cards").getByText("350", { exact: true }).waitFor();
  assert.equal(await page.locator(".usage-months span").count(), 12);
  const aligned = await calendar.locator(".usage-day").evaluateAll((cells) => {
    const first = new Date();
    first.setMonth(first.getMonth() - 11, 1);
    const leading = (first.getDay() + 6) % 7;
    const firstTop = cells[0]?.getBoundingClientRect().top ?? 0;
    return cells.every(
      (cell, index) =>
        Math.abs(
          cell.getBoundingClientRect().top - (firstTop + (((leading + index) % 7) - leading) * 18),
        ) < 1,
    );
  });
  assert.equal(aligned, true);
  assert.equal(await page.getByRole("columnheader", { name: "会话" }).count(), 0);
  assert.equal(await page.locator(".usage-dashboard").getByText("不应显示的会话").count(), 0);
  assert.ok((await page.getByText("我的服务", { exact: true }).count()) > 0);
  assert.ok((await page.getByText("已删除或未知服务 · removed-", { exact: true }).count()) > 0);
  const today = calendar.getByRole("button", {
    name: /总计：250 Token/,
  });
  assert.equal(await today.count(), 1);
  assert.ok((await today.boundingBox())?.width);
  assert.equal(
    await today.evaluate((element) => element.classList.contains("usage-level-4")),
    true,
  );
  await today.hover();
  const tooltip = page.locator(".tooltip:visible");
  await tooltip.waitFor();
  assert.match((await tooltip.textContent()) ?? "", /模型甲：50 Token/);
  assert.match((await tooltip.textContent()) ?? "", /模型乙：200 Token/);
  const unused = calendar.getByRole("button", { name: /总计：0 Token.*无用量/ }).first();
  assert.equal(await calendar.locator('button[tabindex="0"]').count(), 1);
  await unused.focus();
  await page.keyboard.press("ArrowDown");
  assert.equal(await calendar.locator('button[tabindex="0"]').count(), 1);
  assert.equal(
    await calendar
      .locator("button.usage-day")
      .nth(1)
      .evaluate((element) => element === document.activeElement),
    true,
  );
  await page.keyboard.press("ArrowUp");
  await page.locator(".tooltip:visible").getByText("无用量", { exact: false }).waitFor();
  assert.equal(
    await unused.evaluate((element) => element.classList.contains("usage-level-0")),
    true,
  );
  const colors = await page.evaluate(() => {
    const root = document.documentElement;
    const active = document.querySelector(".usage-calendar .usage-level-4");
    const empty = document.querySelector(".usage-calendar .usage-level-0");
    if (!active || !empty) throw new Error("missing calendar cells");
    const original = root.getAttribute("data-theme");
    const result = ["light", "dark"].map((theme) => {
      root.setAttribute("data-theme", theme);
      return [getComputedStyle(active).backgroundColor, getComputedStyle(empty).backgroundColor];
    });
    if (original === null) root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", original);
    return result;
  });
  assert.ok(colors.every(([active, empty]) => active !== empty));
  await page.getByRole("button", { name: "模型", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "模型乙", exact: true }).click();
  assert.equal(await page.locator(".usage-cards").getByText("200", { exact: true }).count(), 1);
  assert.equal(await page.locator(".usage-table tbody tr").count(), 1);
  await page.getByRole("button", { name: "Provider", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "我的服务", exact: true }).click();
  assert.equal(await page.locator(".usage-cards").getByText("300", { exact: true }).count(), 1);
  await page.getByRole("button", { name: "每周", exact: true }).click();
  assert.equal(
    await page.getByRole("button", { name: "每周", exact: true }).getAttribute("aria-pressed"),
    "true",
  );
  assert.ok(
    (await calendar.getByRole("button", { name: /本范围内本周合计：200 Token/ }).count()) > 0,
  );
  await page.getByRole("button", { name: "累计总量", exact: true }).click();
  assert.ok(
    (await calendar.getByRole("button", { name: /本范围内截至当日累计：300 Token/ }).count()) > 0,
  );
  await page.getByRole("button", { name: "年份", exact: true }).click();
  await page
    .getByRole("menuitemradio", { name: `${new Date().getFullYear() - 1}年`, exact: true })
    .click();
  const expected = new Date().getMonth() === 0 ? "400" : "300";
  assert.equal(await page.locator(".usage-cards").getByText(expected, { exact: true }).count(), 1);
});
