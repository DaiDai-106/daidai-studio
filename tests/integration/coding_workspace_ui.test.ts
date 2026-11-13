import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { _electron as electron } from "playwright";
import { chooseProject } from "./support.ts";

test("Coding 工作区显示语法高亮与区分基准的 Git 差异", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-coding-ui-"));
  const projectDir = join(root, "project");
  const profile = join(root, "profile");
  await mkdir(projectDir);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: projectDir, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Test");
  await writeFile(join(projectDir, "sample.ts"), "const value = 1;\n\n// end\n");
  await writeFile(join(projectDir, "guide.md"), "# 使用指南\n\n示例内容\n");
  git("add", "sample.ts");
  git("commit", "-qm", "initial");
  await writeFile(join(projectDir, "sample.ts"), "const value = 2;\n\n// end\n");
  git("add", "sample.ts");
  await writeFile(join(projectDir, "sample.ts"), "const value = 3;\n\n// end\n");
  await writeFile(join(projectDir, "new.py"), "print(1)\n");
  await mkdir(join(projectDir, "src"));
  await writeFile(join(projectDir, "src", "nested.ts"), "export const nested = true;\n");
  await writeFile(
    join(projectDir, "src", "guide.md"),
    "# 嵌套指南\n\n[打开项目文件](../guide.md#L1)\n",
  );
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[0] !== "ELECTRON_RUN_AS_NODE" && entry[1] !== undefined,
    ),
  );
  const app = await electron.launch({
    args: [process.cwd(), `--user-data-dir=${profile}`],
    env,
    chromiumSandbox: true,
  });
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(10_000);
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900),
    );
    await chooseProject(app, page, projectDir, "coding");
    assert.equal(await page.getByRole("region", { name: "代码工作区" }).isVisible(), false);
    const collapsed = await page.evaluate(() => {
      const chat = document.querySelector(".assistant-workspace");
      const composer = document.querySelector(".composer-wrap");
      if (!chat || !composer) throw new Error("缺少聊天布局");
      const column = chat.getBoundingClientRect(),
        input = composer.getBoundingClientRect();
      return {
        width: input.width,
        centered: Math.abs((input.left + input.right - column.left - column.right) / 2),
        compact: chat.querySelector(".chat-panel")?.classList.contains("compact"),
        reopenInHeader: !!chat.querySelector('.assistant-navigation [aria-label="展开代码工作区"]'),
      };
    });
    assert.ok(collapsed.width <= 800);
    assert.ok(collapsed.centered < 2);
    assert.equal(collapsed.compact, false);
    assert.equal(collapsed.reopenInHeader, true);
    assert.equal(
      await page.getByRole("button", { name: "展开代码工作区" }).getAttribute("aria-expanded"),
      "false",
    );
    if (process.env.DAI_CODING_COLLAPSED_SCREENSHOT)
      await page.screenshot({ path: process.env.DAI_CODING_COLLAPSED_SCREENSHOT });
    await page.getByRole("button", { name: "展开代码工作区" }).click();
    assert.equal(
      await page.locator(".topbar").getByRole("button", { name: "收起代码工作区" }).count(),
      0,
    );
    await page
      .getByRole("region", { name: "代码工作区" })
      .getByRole("button", { name: "收起代码工作区" })
      .waitFor();
    await page.getByRole("button", { name: "▸ src", exact: true }).click();
    await page.getByRole("button", { name: "nested.ts", exact: true }).waitFor();
    await page.getByRole("button", { name: "guide.md", exact: true }).last().click();
    await page.getByRole("button", { name: "预览 Markdown" }).click();
    await page.getByRole("button", { name: "guide.md", exact: true }).first().click();
    await page.getByRole("button", { name: "预览 Markdown" }).click();
    await page.getByRole("button", { name: "打开项目文件", exact: true }).click();
    await page.getByRole("region", { name: "文件内容" }).waitFor();
    await page.locator('.coding-line[data-file-line="1"][data-selected="true"]').waitFor();
    assert.equal(await page.getByRole("region", { name: "Markdown 预览" }).isVisible(), false);
    await page.getByRole("button", { name: "guide.md", exact: true }).last().click();
    await page.getByRole("button", { name: "预览 Markdown" }).click();
    await page
      .getByRole("region", { name: "Markdown 预览" })
      .getByRole("heading", { name: "使用指南" })
      .waitFor();
    const toolbar = await page
      .getByRole("group", { name: "Markdown 显示方式" })
      .evaluate((group) => {
        const actions = group.parentElement;
        const heading = actions?.parentElement;
        if (!actions || !heading) throw new Error("缺少文件工具栏");
        return {
          height: heading.getBoundingClientRect().height,
          actionsWidth: actions.getBoundingClientRect().width,
        };
      });
    assert.ok(toolbar.height <= 48);
    assert.ok(toolbar.actionsWidth < 190);
    if (process.env.DAI_CODING_PREVIEW_SCREENSHOT) {
      await page.evaluate(() => window.desktop.application.updateSettings({ theme: "light" }));
      await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
      await page.screenshot({
        path: process.env.DAI_CODING_PREVIEW_SCREENSHOT,
        animations: "disabled",
      });
      await page.evaluate(() => window.desktop.application.updateSettings({ theme: "dark" }));
      await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
      await page.screenshot({
        path: `${process.env.DAI_CODING_PREVIEW_SCREENSHOT}.dark.png`,
        animations: "disabled",
      });
    }
    await page.getByRole("button", { name: "查看源码" }).click();
    await page.getByRole("button", { name: "sample.ts", exact: true }).click();
    const code = page.getByRole("region", { name: "文件内容" });
    await code.locator(".coding-line-text").first().waitFor();
    assert.equal(
      await code.locator(".coding-content").textContent(),
      "const value = 3;\n\n// end\n",
    );
    await page.waitForFunction(
      () => document.querySelectorAll(".coding-line-text span[style]").length > 1,
    );
    const layout = await page.evaluate(() => {
      const bounds = (selector: string) => {
        const element = document.querySelector(selector);
        if (!element) throw new Error(`缺少布局元素：${selector}`);
        return element.getBoundingClientRect();
      };
      const chat = bounds(".assistant-workspace");
      const coding = bounds(".coding-workspace");
      const navigation = bounds(".coding-tree");
      const content = bounds(".coding-editor");
      return {
        chatRight: chat.right,
        chatWidth: chat.width,
        codingLeft: coding.left,
        codingWidth: coding.width,
        contentRight: content.right,
        navigationLeft: navigation.left,
      };
    });
    assert.ok(layout.chatRight <= layout.codingLeft);
    assert.ok(Math.abs(layout.chatWidth - layout.codingWidth) < 2);
    assert.ok(layout.contentRight <= layout.navigationLeft);
    await page.getByRole("tab", { name: "文件", exact: true }).click();
    assert.equal(
      await page.getByRole("complementary", { name: "项目文件与变更" }).isVisible(),
      false,
    );
    assert.equal(await code.isVisible(), true);
    await page.getByRole("tab", { name: "文件", exact: true }).click();
    const splitter = page.getByRole("separator", { name: "调整聊天与代码工作区宽度" });
    await splitter.focus();
    await page.keyboard.press("ArrowLeft");
    assert.equal(await splitter.getAttribute("aria-valuenow"), "52");
    const splitBounds = await splitter.boundingBox();
    assert.ok(splitBounds);
    await page.mouse.move(splitBounds.x + splitBounds.width / 2, splitBounds.y + 30);
    await page.mouse.down();
    await page.mouse.move(splitBounds.x - 60, splitBounds.y + 30);
    await page.mouse.up();
    await page.waitForFunction(
      () =>
        Number(document.querySelector(".coding-mode > .splitter")?.getAttribute("aria-valuenow")) >
        52,
    );
    const resizedWidth = await splitter.getAttribute("aria-valuenow");
    assert.ok(Number(resizedWidth) > 52);
    await page.getByRole("textbox", { name: "消息内容" }).fill("布局调整保留草稿");
    await page.getByRole("button", { name: "收起代码工作区" }).click();
    assert.equal(await page.getByRole("region", { name: "代码工作区" }).isVisible(), false);
    await page.getByRole("button", { name: "展开代码工作区" }).click();
    assert.equal(await splitter.getAttribute("aria-valuenow"), resizedWidth);
    assert.equal(await code.isVisible(), true);
    assert.equal(
      await page.getByRole("textbox", { name: "消息内容" }).inputValue(),
      "布局调整保留草稿",
    );
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setContentSize(900, 800),
    );
    await page.getByRole("tab", { name: "聊天", exact: true }).click();
    assert.equal(await code.isVisible(), false);
    assert.equal(await page.getByRole("textbox", { name: "消息内容" }).isVisible(), true);
    await page.getByRole("tab", { name: "代码", exact: true }).click();
    assert.equal(await code.isVisible(), true);
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900),
    );
    await page.evaluate(() => window.desktop.application.updateSettings({ theme: "light" }));
    await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
    const lightColors = await code
      .locator(".coding-line-text span[style]")
      .evaluateAll((items) => items.map((item) => (item as HTMLElement).style.color));
    await page.evaluate(() => window.desktop.application.updateSettings({ theme: "dark" }));
    await page.waitForFunction((previous) => {
      const current = Array.from(document.querySelectorAll(".coding-line-text span[style]")).map(
        (item) => (item as HTMLElement).style.color,
      );
      return (
        document.documentElement.dataset.theme === "dark" &&
        current.length > 0 &&
        current.join(",") !== previous.join(",")
      );
    }, lightColors);
    if (process.env.DAI_CODING_SCREENSHOT)
      await page.screenshot({ path: process.env.DAI_CODING_SCREENSHOT });
    await page.getByRole("tab", { name: "变更" }).click();
    await page.getByRole("tab", { name: "文件", exact: true }).click();
    await page.getByRole("button", { name: "nested.ts", exact: true }).waitFor();
    await page.getByRole("tab", { name: "变更" }).click();
    const row = page.locator(".coding-change").filter({ hasText: "sample.ts" });
    await row.getByRole("button", { name: "已暂存" }).click();
    await page.getByRole("region", { name: "文件差异" }).getByText("+const value = 2;").waitFor();
    await row.getByRole("button", { name: "未暂存" }).click();
    await page.getByRole("region", { name: "文件差异" }).getByText("+const value = 3;").waitFor();
    await page.getByRole("region", { name: "文件差异" }).getByText("-const value = 2;").click();
    await page
      .getByRole("region", { name: "文件差异" })
      .getByText("+const value = 3;")
      .click({ modifiers: ["Shift"] });
    await page.getByLabel(/批注差异第/).fill("请检查此修改");
    const diffPanel = page
      .getByRole("tabpanel")
      .filter({ has: page.getByRole("region", { name: "文件差异" }) });
    await diffPanel.getByRole("button", { name: "刷新", exact: true }).click();
    await page.waitForFunction(() => !document.body.textContent?.includes("正在刷新…"));
    assert.equal(await page.getByLabel(/批注差异第/).inputValue(), "请检查此修改");
    await page.getByRole("button", { name: "添加到聊天草稿" }).click();
    const draft = await page.getByRole("textbox", { name: "消息内容" }).inputValue();
    assert.match(draft, /请检查此修改/);
    assert.match(draft, /-const value = 2;/);
    assert.match(draft, /\+const value = 3;/);
    await page.getByRole("textbox", { name: "消息内容" }).fill("");
    await page.getByRole("region", { name: "文件差异" }).getByText("+const value = 3;").click();
    await page.getByLabel(/批注差异第/).fill("不能沿用的旧批注");
    await writeFile(join(projectDir, "sample.ts"), "const value = 4;\n\n// end\n");
    await diffPanel.getByRole("button", { name: "刷新", exact: true }).click();
    await page.getByRole("region", { name: "文件差异" }).getByText("+const value = 4;").waitFor();
    assert.equal(await page.getByLabel(/批注差异第/).count(), 0);
    await page.getByText("差异已变化，请重新选择需要批注的行。", { exact: true }).waitFor();
    if (process.env.DAI_CODING_DIFF_SCREENSHOT)
      await page.screenshot({ path: process.env.DAI_CODING_DIFF_SCREENSHOT });
    await page
      .locator(".coding-change")
      .filter({ hasText: "new.py" })
      .getByRole("button", { name: "未跟踪" })
      .click();
    await page.getByRole("region", { name: "文件差异" }).getByText("+print(1)").waitFor();
    assert.equal(await page.getByRole("textbox", { name: "文件内容" }).count(), 0);
    await page.getByRole("button", { name: "project", exact: true }).click();
    await page.getByRole("textbox", { name: "消息内容" }).waitFor({ state: "detached" });
    assert.equal(await page.getByRole("region", { name: "文件差异" }).isVisible(), true);
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setContentSize(900, 800),
    );
    await page.getByRole("tab", { name: "代码", exact: true }).click();
    await page.getByRole("button", { name: "收起代码工作区" }).click();
    await page.getByRole("button", { name: "project", exact: true }).click();
    await page.waitForFunction(
      () => document.querySelector(".workspace")?.getAttribute("data-mobile-tab") === "chat",
    );
    assert.equal(await page.getByRole("region", { name: "代码工作区" }).isVisible(), false);
    await page.getByRole("button", { name: "展开代码工作区" }).click();
    await page.getByRole("region", { name: "文件差异" }).waitFor();
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
