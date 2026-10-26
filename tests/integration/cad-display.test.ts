import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { _electron as electron } from "playwright";
import { PerspectiveCamera, Vector3 } from "three";
import { planCadImport } from "../support/cadPlan.ts";
import { servePlanner } from "../support/planner.ts";
import { chooseProject } from "./support.ts";

const executable = process.env.DAI_CAD_TEST_WORKER;
const fixture = process.env.DAI_CAD_TEST_FIXTURE;

test("desktop renders real CAD through Harness, picks instances and reopens saved models without another tool call", {
  skip: !executable || !fixture,
  timeout: 60000,
}, async () => {
  assert.ok(executable && fixture);
  const profile = await mkdtemp(join(tmpdir(), "dai-display-ui-"));
  const project = join(profile, "project");
  await mkdir(project);
  await promisify(execFile)(fixture, ["--write-fixture", join(project, "assembly.step")]);
  await promisify(execFile)(fixture, ["--write-fixture", join(project, "other.step")]);
  const planner = await servePlanner(
    (request) => planCadImport(request) ?? { text: "显示资源已生成。" },
  );
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[0] !== "ELECTRON_RUN_AS_NODE" && entry[1] !== undefined,
    ),
  );
  env.DAI_NATIVE_DIRECTORY = dirname(executable);
  const launch = () =>
    electron.launch({
      args: [process.cwd(), `--user-data-dir=${profile}`],
      env,
      chromiumSandbox: true,
    });
  let app = await launch();
  try {
    let page = await app.firstWindow();
    page.setDefaultTimeout(10000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const network: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") network.push(message.text());
    });
    page.on("requestfailed", (request) =>
      network.push(`${request.url()} ${request.failure()?.errorText}`),
    );
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setContentSize(1500, 950),
    );
    await chooseProject(app, page, project);
    await page.evaluate(async (endpoint) => {
      const api = window.desktop.application;
      await api.saveProvider({
        id: "display-test",
        name: "CAD test",
        providerType: "local",
        authMethod: "none",
        endpoint,
        enabled: true,
        persistCredentials: false,
        models: [{ id: "test", name: "test", context: 128000, output: 2048, reasoning: "标准" }],
      });
      const state = await api.getWorkspace();
      const id = state.conversations[0]?.id;
      if (!id) throw new Error("Missing conversation");
      await api.updateConversation({ id, modelId: "display-test:test" });
    }, planner.endpoint);
    await page.getByRole("button", { name: "通用对话", exact: true }).click();
    await page.getByRole("menuitem", { name: /^场景搭建/ }).click();
    await page.getByRole("button", { name: "当前 STEP", exact: true }).click();
    await page.getByRole("button", { name: /^assembly.step/ }).click();
    await page.getByRole("textbox", { name: "消息内容", exact: true }).fill("导入选中的 STEP");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await page.getByRole("button", { name: "打开设置", exact: true }).click();
    await page.waitForFunction(
      () => document.querySelector(".scene-stage")?.getAttribute("data-display-status") === "ready",
    );
    await page.getByRole("button", { name: "返回工作台", exact: true }).click();
    const stage = page.locator('.scene-stage[data-scene-loaded="true"]');
    try {
      await stage.waitFor();
    } catch (error) {
      console.log({
        requests: planner.requests.length,
        messages: await page
          .locator(".bridge-error, .viewport-error, .message-text")
          .allTextContents(),
        stage: await page.locator(".scene-stage").getAttribute("data-display-status"),
        errors,
        network,
      });
      await page.screenshot({ path: resolve("out/cad-display-failure.png") });
      throw error;
    }
    const importId = await stage.getAttribute("data-import-id");
    assert.ok(importId);
    await page.getByRole("button", { name: "first box", exact: true }).click();
    await page.getByText("已选择：first box", { exact: true }).waitFor();
    const transparency = page.getByRole("slider", { name: "对象透明度", exact: true });
    assert.equal(await transparency.inputValue(), "0");
    await transparency.press("End");
    assert.equal(await transparency.inputValue(), "100");
    await transparency.press("PageDown");
    await transparency.press("PageDown");
    for (let i = 0; i < 5; i++) await transparency.press("ArrowLeft");
    assert.equal(await transparency.inputValue(), "75");
    await page.screenshot({ path: resolve("out/cad-selection-light.png") });
    await page.getByRole("button", { name: "second box", exact: true }).click();
    assert.equal(await transparency.inputValue(), "0");
    await page.getByRole("button", { name: "first box", exact: true }).click();
    assert.equal(await transparency.inputValue(), "75");
    await page.getByRole("button", { name: "assembly", exact: true }).click();
    await transparency.press("End");
    await page.getByRole("button", { name: "second box", exact: true }).click();
    assert.equal(await transparency.inputValue(), "100", "children inherit assembly transparency");
    await page.getByRole("button", { name: "重置", exact: true }).click();
    assert.equal(await transparency.inputValue(), "0");
    await page.getByRole("button", { name: "assembly", exact: true }).click();
    await page.getByRole("button", { name: "重置", exact: true }).click();
    await page.getByRole("button", { name: "first box", exact: true }).click();
    assert.equal(
      await transparency.inputValue(),
      "0",
      "resetting the parent clears child overrides",
    );
    await page.getByRole("button", { name: "视角", exact: true }).click();
    await page.getByRole("menuitem", { name: "前视图", exact: true }).click();
    const canvas = page.getByLabel("三维场景视图", { exact: true });
    const box = await canvas.boundingBox();
    assert.ok(box);
    const center = new Vector3(0.925, 0.175, 0.25);
    const radius = new Vector3(1.95, 0.45, 0.5).length() / 2;
    const camera = new PerspectiveCamera(45, box.width / box.height, 0.001, 100);
    const vertical = Math.PI / 8;
    const distance =
      (radius / Math.sin(Math.min(vertical, Math.atan(Math.tan(vertical) * camera.aspect)))) * 1.15;
    camera.up.set(0, 0, 1);
    camera.position.copy(center).add(new Vector3(distance, 0, 0));
    camera.lookAt(center);
    camera.updateMatrixWorld();
    const point = new Vector3(1.9, 0.2, 0.125).project(camera);
    await canvas.click({
      position: { x: ((point.x + 1) * box.width) / 2, y: ((1 - point.y) * box.height) / 2 },
    });
    await page.getByText("已选择：second box", { exact: true }).waitFor();
    await transparency.press("End");
    const handle = await canvas.elementHandle();
    assert.ok(handle);
    await page.getByText("显示资源已生成。", { exact: true }).waitFor();
    await page.getByRole("button", { name: "在当前项目新建对话", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll(".conversation-row").length === 2);
    assert.equal(await handle.evaluate((node) => node.isConnected), true);
    assert.equal(await stage.getAttribute("data-import-id"), importId);
    await page.getByText("已选择：second box", { exact: true }).waitFor();
    assert.equal(
      await transparency.inputValue(),
      "100",
      "same-source chats retain viewing overrides",
    );
    await page.getByRole("button", { name: "打开设置", exact: true }).click();
    await page.getByRole("button", { name: "返回工作台", exact: true }).click();
    assert.equal(await handle.evaluate((node) => node.isConnected), true);
    await page.getByRole("button", { name: "当前 STEP", exact: true }).click();
    await page.getByRole("button", { name: /^other.step/ }).click();
    await page.locator('.scene-stage[data-scene-loaded="false"]').waitFor();
    assert.equal(await handle.evaluate((node) => node.isConnected), false);
    await page.getByRole("button", { name: "当前 STEP", exact: true }).click();
    await page.getByRole("button", { name: /^assembly.step/ }).click();
    await stage.waitFor();
    assert.equal(await stage.getAttribute("data-import-id"), importId);
    // Fail only the next model's resource transfer, not its real CAD computation or save.
    await app.evaluate(({ session }) =>
      session.defaultSession.webRequest.onBeforeRequest(
        { urls: ["dai-resource://*/*"] },
        (_details, callback) => callback({ cancel: true }),
      ),
    );
    await page.getByRole("textbox", { name: "消息内容", exact: true }).fill("再次生成显示资源");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await page
      .locator(".viewport-error")
      .getByRole("button", { name: "重新加载", exact: true })
      .waitFor();
    assert.equal(
      await stage.getAttribute("data-import-id"),
      importId,
      "A failed load preserves the previous GPU model",
    );
    await app.evaluate(({ session }) => session.defaultSession.webRequest.onBeforeRequest(null));
    await page
      .locator(".viewport-error")
      .getByRole("button", { name: "重新加载", exact: true })
      .click();
    await page.waitForFunction((old) => {
      const stage = document.querySelector(".scene-stage");
      return (
        stage?.getAttribute("data-display-status") === "ready" &&
        stage.getAttribute("data-import-id") !== old
      );
    }, importId);
    const restoredId = await stage.getAttribute("data-import-id");
    assert.ok(restoredId);
    await page.getByRole("button", { name: "second box", exact: true }).click();
    assert.equal(await transparency.inputValue(), "0", "new artifacts start without old overrides");
    await page.screenshot({ path: resolve("out/cad-display.png") });
    const requests = planner.requests.length;
    assert.deepEqual(errors, []);
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await page.locator('.scene-stage[data-scene-loaded="true"]').waitFor({ timeout: 15000 });
    assert.equal(await page.locator(".scene-stage").getAttribute("data-import-id"), restoredId);
    assert.equal(planner.requests.length, requests);
  } finally {
    await app.close();
    await planner.close();
    await rm(profile, { recursive: true, force: true });
  }
});
