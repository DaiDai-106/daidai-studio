import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { _electron as electron } from "playwright";
import { chooseProject, openTestProject } from "./support.ts";

test("Dai Robotics keeps its mode and presents selectable demo devices", {
  timeout: 60_000,
}, async () => {
  const profile = await mkdtemp(join(tmpdir(), "dai-robot-ui-"));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[0] !== "ELECTRON_RUN_AS_NODE" && entry[1] !== undefined,
    ),
  );
  const launch = () =>
    electron.launch({
      args: [process.cwd(), `--user-data-dir=${profile}`],
      env,
      chromiumSandbox: true,
    });
  let application = await launch();
  try {
    let page = await application.firstWindow();
    page.setDefaultTimeout(7000);
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 850),
    );
    const directory = await openTestProject(application, page, profile);
    await chooseProject(application, page, directory, "robot");
    const panel = page.getByRole("complementary", { name: "机器人设备" });
    await panel.waitFor();
    await panel.getByText("演示数据", { exact: true }).waitFor();
    await page.screenshot({ path: join(tmpdir(), "dai-robotics-wide.png") });
    assert.equal(
      await panel.getByRole("region", { name: "左机械臂状态" }).locator("dt").count(),
      6,
    );
    await panel.getByRole("button", { name: "右机械臂，已连接", exact: true }).click();
    const rightArm = panel.getByRole("region", { name: "右机械臂状态" });
    assert.equal(await rightArm.locator("dt").count(), 7);
    await rightArm.getByText("3.5°", { exact: true }).waitFor();
    await panel.getByRole("button", { name: "右夹爪，已断连", exact: true }).click();
    const disconnected = panel.getByRole("region", { name: "右夹爪状态" });
    await disconnected.getByText("已断连", { exact: true }).waitFor();
    await disconnected.getByText(/读数已过期/).waitFor();
    await panel.getByLabel("演示工作站").selectOption({ label: "单臂工作站" });
    assert.equal(await panel.getByRole("region", { name: "机械臂状态" }).locator("dt").count(), 6);
    assert.equal(
      await panel.getByRole("button", { name: "右机械臂，已连接", exact: true }).count(),
      0,
    );

    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setContentSize(840, 640),
    );
    await page.getByRole("tab", { name: "聊天", exact: true }).waitFor();
    assert.equal(
      await page.getByRole("tab", { name: "聊天", exact: true }).getAttribute("aria-selected"),
      "true",
    );
    assert.equal(await page.getByRole("textbox", { name: "消息内容" }).isVisible(), true);
    assert.equal(await panel.isVisible(), false);
    await page.getByRole("tab", { name: "设备", exact: true }).click();
    assert.equal(await panel.isVisible(), true);
    assert.equal(await page.getByRole("textbox", { name: "消息内容" }).isVisible(), false);
    await page.screenshot({ path: join(tmpdir(), "dai-robotics-narrow.png") });
    await page.getByRole("tab", { name: "聊天", exact: true }).click();
    const conversationId = (
      await page.evaluate(() => window.desktop.application.getWorkspace())
    ).conversations.find((item) => item.mode === "robot")?.id;
    assert.ok(conversationId);
    await page.waitForFunction(async (id) => {
      const workspace = await window.desktop.application.getWorkspace();
      return workspace.conversations.find((item) => item.id === id)?.mode === "robot";
    }, conversationId);
    await application.close();

    application = await launch();
    page = await application.firstWindow();
    page.setDefaultTimeout(7000);
    const workspace = await page.evaluate(() => window.desktop.application.getWorkspace());
    assert.equal(workspace.conversations.find((item) => item.id === conversationId)?.mode, "robot");
    const robotConversation = workspace.conversations.find((item) => item.id === conversationId);
    assert.ok(robotConversation);
    const projectIndex = workspace.projects.findIndex(
      (item) => item.id === robotConversation.projectId,
    );
    await page
      .locator(".project-group")
      .nth(projectIndex)
      .locator(".conversation-title")
      .first()
      .click();
    await page.getByRole("complementary", { name: "机器人设备" }).waitFor();
  } finally {
    if (application.process().exitCode === null) await application.close();
    await rm(profile, { recursive: true, force: true });
  }
});
