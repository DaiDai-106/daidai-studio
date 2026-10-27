import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { _electron as electron } from "playwright";
import { PerspectiveCamera, Vector3 } from "three";
import { planCadImport, sceneContext } from "../support/cadPlan.ts";
import { servePlanner } from "../support/planner.ts";
import { chooseProject } from "./support.ts";

const executable = process.env.DAI_CAD_TEST_WORKER;
const fixture = process.env.DAI_CAD_TEST_FIXTURE;
const alignment = process.env.DAI_ALIGNMENT_TEST_WORKER;

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
  const planner = await servePlanner((request) => {
    const user = request.messages
      .filter((message) => message.role === "user" && typeof message.content === "string")
      .at(-1)?.content;
    if (user?.includes("应用事件：用户已进入场景搭建")) return { text: "请问是什么场景？" };
    if (user === "查看场景摘要") {
      if (!request.messages.some((message) => message.tool_call_id === "summary")) {
        const current = sceneContext(request).currentDisplay;
        assert.ok(current);
        return { id: "summary", name: "scene_inspect", args: { importId: current.importId } };
      }
      const content = request.messages.find(
        (message) => message.tool_call_id === "summary",
      )?.content;
      assert.ok(content?.includes('"objectCount"'));
      return { text: "已查看场景摘要。" };
    }
    if (user === "旋转并对比") {
      if (!request.messages.some((message) => message.tool_call_id === "compare-rotate")) {
        const current = sceneContext(request).currentDisplay;
        assert.ok(current);
        return {
          id: "compare-rotate",
          name: "alignment_rotate",
          args: {
            importId: current.importId,
            expectedRevision: current.placement.revision,
            axis: [0, 0, 1],
            angleDegrees: 90,
            pivot: [0, 0, 0],
            space: "world",
          },
        };
      }
      const content = request.messages.find(
        (message) => message.tool_call_id === "compare-rotate",
      )?.content;
      assert.ok(content?.includes('"ok":true'));
      return { text: "定位已更新。" };
    }
    if (user === "观察当前视口") {
      if (!request.messages.some((message) => message.tool_call_id === "viewport")) {
        const current = sceneContext(request).currentDisplay;
        assert.ok(current);
        return {
          id: "viewport",
          name: "viewport_capture",
          args: { importId: current.importId, revision: current.placement.revision },
        };
      }
      if (!request.messages.some((message) => message.tool_call_id === "viewport-top")) {
        const current = sceneContext(request).currentDisplay;
        assert.ok(current);
        return {
          id: "viewport-top",
          name: "viewport_capture",
          args: { importId: current.importId, revision: current.placement.revision, view: "+Z" },
        };
      }
      if (!request.messages.some((message) => message.tool_call_id === "viewport-again")) {
        if (!request.messages.some((message) => message.tool_call_id === "viewport-overview")) {
          const current = sceneContext(request).currentDisplay;
          assert.ok(current);
          return {
            id: "viewport-overview",
            name: "viewport_capture",
            args: {
              importId: current.importId,
              revision: current.placement.revision,
              view: "overview",
            },
          };
        }
        const current = sceneContext(request).currentDisplay;
        assert.ok(current);
        return {
          id: "viewport-again",
          name: "viewport_capture",
          args: { importId: current.importId, revision: current.placement.revision },
        };
      }
      assert.match(JSON.stringify(request.messages), /data:image\/jpeg;base64,/);
      assert.match(JSON.stringify(request.messages), /orthographic/);
      const camera = (id: string) =>
        JSON.parse(
          request.messages
            .find((message) => message.tool_call_id === id)
            ?.content?.split("\n<harness>\n")[0] ?? "{}",
        ).camera;
      assert.deepEqual(camera("viewport"), camera("viewport-again"));
      const overview = JSON.parse(
        request.messages
          .find((message) => message.tool_call_id === "viewport-overview")
          ?.content?.split("\n<harness>\n")[0] ?? "{}",
      );
      assert.deepEqual(
        overview.views.map((item: { view: string }) => item.view),
        ["+X", "-X", "+Y", "-Y", "+Z", "-Z"],
      );
      assert.ok(
        overview.views.every(
          (item: { camera: { projection: string } }) => item.camera.projection === "orthographic",
        ),
      );
      const overviewIndex = request.messages.findIndex(
        (message) => message.tool_call_id === "viewport-overview",
      );
      const imageMessage = request.messages
        .slice(overviewIndex + 1)
        .find((message) => message.role === "user" && Array.isArray(message.content));
      const blocks = imageMessage?.content as unknown as
        | { type: string; image_url?: { url: string } }[]
        | undefined;
      const url = blocks?.find((block) => block.type === "image_url")?.image_url?.url ?? "";
      assert.match(url, /^data:image\/jpeg;base64,/);
      const bytes = Buffer.from(url.split(",")[1] ?? "", "base64");
      assert.ok(bytes.length > 10_000, "The overview must contain an actual rendered image");
      if (process.env.DAI_OVERVIEW_TEST_OUTPUT)
        writeFileSync(process.env.DAI_OVERVIEW_TEST_OUTPUT, bytes);
      return { text: "已观察视口。" };
    }
    return planCadImport(request) ?? { text: "显示资源已生成。" };
  });
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
        models: [
          {
            id: "test",
            name: "test",
            context: 128000,
            output: 2048,
            reasoning: "标准",
            supportsImages: true,
          },
        ],
      });
      const state = await api.getWorkspace();
      const id = state.conversations[0]?.id;
      if (!id) throw new Error("Missing conversation");
      await api.updateConversation({ id, modelId: "display-test:test" });
    }, planner.endpoint);
    await page.getByRole("button", { name: "通用对话", exact: true }).click();
    await page.getByRole("menuitem", { name: /^场景搭建/ }).click();
    await page.getByText("请问是什么场景？", { exact: true }).waitFor();
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
    await page.getByText(/初始定位 · 平移/).waitFor();
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
    await page.getByRole("menuitem", { name: "从世界 +X 看（前视）", exact: true }).click();
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
    await page.getByRole("textbox", { name: "消息内容", exact: true }).fill("查看场景摘要");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await page.getByText("已查看场景摘要。", { exact: true }).waitFor();
    await page.getByRole("textbox", { name: "消息内容", exact: true }).fill("观察当前视口");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await page.getByText("已观察视口。", { exact: true }).waitFor();
    const captureTurn = page.locator(".conversation-turn").filter({ hasText: "观察当前视口" });
    await captureTurn.locator(".process-header").click();
    const captureTool = captureTurn
      .locator('.tool-message[data-tool-name="viewport_capture"]')
      .first();
    await captureTool.locator(".process-row").click();
    await captureTool.getByAltText("提供给助手的场景视口截图").waitFor();
    assert.match((await captureTool.locator("figcaption").textContent()) ?? "", /场景版本 0/);
    if (alignment) {
      await page.getByRole("button", { name: "变换对比", exact: true }).click();
      const comparison = page.getByRole("region", { name: "定位变换前后对比" });
      await comparison.getByText("已开启，等待下一次定位变更", { exact: true }).waitFor();
      await page.getByRole("textbox", { name: "消息内容", exact: true }).fill("旋转并对比");
      await page.getByRole("button", { name: "发送消息", exact: true }).click();
      await page.getByText("定位已更新。", { exact: true }).waitFor();
      await page.waitForFunction(() => {
        const revision = document
          .querySelector(".scene-stage")
          ?.getAttribute("data-placement-revision");
        return revision !== null && Number(revision) > 0;
      });
      const revision = Number(await stage.getAttribute("data-placement-revision"));
      await comparison.getByAltText("定位变更前，版本 0", { exact: true }).waitFor();
      await comparison.getByAltText(`定位变更后，版本 ${revision}`, { exact: true }).waitFor();
      const images = await comparison
        .locator("img")
        .evaluateAll((items) => items.map((item) => item.getAttribute("src") ?? ""));
      assert.equal(images.length, 2);
      for (const image of images) {
        assert.match(image, /^data:image\/jpeg;base64,/);
        assert.ok(Buffer.from(image.split(",")[1] ?? "", "base64").length > 1000);
      }
      assert.notEqual(images[0], images[1], "A real rotation produces different rendered views");
      await comparison.getByRole("button", { name: "清除对照", exact: true }).click();
      assert.equal(await comparison.locator("img").count(), 0);
      await page.getByRole("button", { name: "变换对比", exact: true }).click();
      assert.equal(await comparison.count(), 0);
    }
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
    assert.equal(await page.locator(".scene-stage").getAttribute("data-import-id"), "");
    assert.equal(await page.locator(".scene-selection").count(), 0);
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
