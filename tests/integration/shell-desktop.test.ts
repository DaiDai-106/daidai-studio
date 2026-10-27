import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { _electron as electron } from "playwright";
import { servePlanner, turnResults } from "../support/planner.ts";
import { openTestProject } from "./support.ts";

test("desktop shows the complete shell command and requires confirmation before execution", {
  timeout: 45000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-shell-ui-"));
  const shell = process.platform === "win32" ? "powershell" : "bash";
  const command = `node -e "require('fs').writeFileSync('marker.txt','approved')"`;
  const planner = await servePlanner((request) =>
    turnResults(request).count === 0
      ? { id: "shell-call", name: shell, args: { command } }
      : { text: "命令已处理" },
  );
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[0] !== "ELECTRON_RUN_AS_NODE" && entry[1] !== undefined,
    ),
  );
  const app = await electron.launch({
    args: [process.cwd(), `--user-data-dir=${root}`],
    env,
    chromiumSandbox: true,
  });
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(10000);
    await page.getByRole("button", { name: "打开项目", exact: true }).first().waitFor();
    await page.evaluate(async (endpoint) => {
      await window.desktop.application.saveProvider({
        id: "local",
        providerType: "local",
        name: "Test",
        authMethod: "none",
        endpoint,
        enabled: true,
        persistCredentials: false,
        models: [
          { id: "workflow-test", name: "Test", context: 8192, output: 1024, reasoning: "标准" },
        ],
      });
    }, planner.endpoint);
    const project = await openTestProject(app, page, root);
    await page.getByRole("button", { name: "通用对话", exact: true }).click();
    await page.getByRole("menuitem", { name: /^场景搭建/ }).click();
    await page.getByRole("textbox", { name: "消息内容" }).fill("检查场景");
    await page.getByRole("button", { name: "发送消息" }).click();
    const approval = page.getByRole("region", { name: "确认执行命令" });
    await approval.waitFor();
    assert.equal(await page.locator(".chat-panel .shell-approval").count(), 1);
    assert.equal(await page.locator("dialog[open]").count(), 0);
    assert.equal(await approval.locator("pre").textContent(), command);
    assert.match((await approval.textContent()) ?? "", /当前用户权限/);
    await assert.rejects(access(join(project, "marker.txt")));
    await approval.getByRole("button", { name: "确认执行" }).click();
    await page.getByText("命令已处理", { exact: true }).waitFor();
    assert.equal(await readFile(join(project, "marker.txt"), "utf8"), "approved");
    await rm(join(project, "marker.txt"));
    await page.getByRole("textbox", { name: "消息内容" }).fill("再次检查场景");
    await page.getByRole("button", { name: "发送消息" }).click();
    await approval.waitFor();
    await approval.getByRole("button", { name: "拒绝" }).click();
    await approval.waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "发送消息" }).waitFor();
    await assert.rejects(access(join(project, "marker.txt")));
  } finally {
    await app.close();
    await planner.close();
    await rm(root, { recursive: true, force: true });
  }
});
