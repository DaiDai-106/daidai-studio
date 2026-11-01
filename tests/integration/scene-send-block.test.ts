import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { _electron as electron, type Page } from "playwright";
import { servePlanner } from "../support/planner.ts";

async function createSceneProject(page: Page, name: string) {
  await page.getByRole("button", { name: "新建项目", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "新建项目" });
  await dialog.getByLabel("项目名称").fill(name);
  await dialog.getByLabel("项目模式").click();
  await page.getByRole("menuitemradio", { name: "场景搭建" }).click();
  await dialog.getByRole("button", { name: "选择文件夹", exact: true }).click();
  await dialog.getByRole("button", { name: "创建项目", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "新建对话", exact: true }).last().click();
  await page.getByRole("textbox", { name: "消息内容" }).waitFor();
}

test("chat waits for its own scene import without blocking another project", {
  timeout: 60_000,
  skip:
    process.platform === "win32" ? "Blocking-worker fixture requires a POSIX executable." : false,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-scene-send-ui-"));
  const profile = join(root, "profile");
  const a = join(root, "a");
  const b = join(root, "b");
  const step = join(root, "pending.step");
  const marker = join(root, "worker-started");
  const python = join(profile, "data", "python", "scene", "bin", "python");
  await Promise.all([
    mkdir(a),
    mkdir(b),
    mkdir(join(profile, "data", "python", "scene", "bin"), { recursive: true }),
    writeFile(step, "STEP placeholder"),
  ]);
  await writeFile(
    python,
    `#!/usr/bin/env node\nif (process.argv[2] === '-c') process.exit(0);\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started');\nprocess.stdin.resume();\nsetInterval(() => {}, 1000);\n`,
    { mode: 0o755 },
  );
  const planner = await servePlanner(() => ({ text: "模型回复" }));
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
    page.setDefaultTimeout(10000);
    await page.getByRole("button", { name: "新建项目", exact: true }).first().waitFor();
    await page.evaluate(
      (endpoint) =>
        window.desktop.application.saveProvider({
          id: "local",
          providerType: "local",
          name: "Test",
          authMethod: "none",
          endpoint,
          enabled: true,

          models: [
            { id: "workflow-test", name: "Test", context: 8192, output: 1024, reasoning: "标准" },
          ],
        }),
      planner.endpoint,
    );
    await app.evaluate(
      ({ dialog }, paths) => {
        const selections = [...paths];
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [selections.shift() ?? ""],
        });
      },
      [a, b, step],
    );
    await createSceneProject(page, "项目 A");
    await createSceneProject(page, "项目 B");
    const groupA = page
      .locator(".project-group")
      .filter({ has: page.getByRole("button", { name: "项目 A", exact: true }) });
    const groupB = page
      .locator(".project-group")
      .filter({ has: page.getByRole("button", { name: "项目 B", exact: true }) });
    await groupA.locator(".conversation-title").click();
    await groupA.locator(".conversation-row.selected").waitFor();
    await page
      .getByRole("region", { name: "场景工作区" })
      .getByRole("button", { name: "添加 STEP" })
      .click();
    for (let attempt = 0; attempt < 150; attempt++) {
      try {
        await access(marker);
        break;
      } catch {
        await delay(50);
      }
    }
    await access(marker);
    const input = page.getByRole("textbox", { name: "消息内容" });
    await input.fill("使用新模型搭建场景");
    await page.getByText("场景处理中，请等待完成后发送。", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "发送消息" }).isDisabled(), true);
    await input.press("Enter");
    assert.equal(planner.requests.length, 0);
    await groupB.locator(".conversation-title").click();
    await groupB.locator(".conversation-row.selected").waitFor();
    await input.fill("另一个项目继续工作");
    await page.getByRole("button", { name: "发送消息" }).click();
    await page.getByText("模型回复", { exact: true }).waitFor();
    await page.getByRole("button", { name: "发送消息" }).waitFor();
    assert.equal(planner.requests.length, 1);
    await groupA.locator(".conversation-title").click();
    await groupA.locator(".conversation-row.selected").waitFor();
    await page.getByRole("button", { name: "取消导入" }).click();
    await page.getByRole("button", { name: "取消导入" }).waitFor({ state: "hidden" });
    await page
      .getByText("场景处理中，请等待完成后发送。", { exact: true })
      .waitFor({ state: "hidden" });
    assert.equal(await input.inputValue(), "使用新模型搭建场景");
    await page.getByRole("button", { name: "发送消息" }).click();
    await page.getByText("模型回复", { exact: true }).waitFor();
    assert.equal(planner.requests.length, 2);
  } finally {
    await app.close();
    await planner.close();
    await rm(root, { recursive: true, force: true });
  }
});
