import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { _electron as electron } from "playwright";
import type { CadFaceMap, CadManifest } from "../../resources/mcp/cad/contract.ts";
import { currentDisplayId, planCadImport, sceneContext } from "../support/cadPlan.ts";
import { servePlanner, turnResults } from "../support/planner.ts";
import { chooseProject } from "./support.ts";

const executable = process.env.DAI_CAD_TEST_WORKER;
const source = process.env.DAI_CAD_REAL_STEP;

test("real STEP partial display reaches Electron through Harness and survives a restart", {
  skip: !executable || !source,
  timeout: 180_000,
}, async () => {
  assert.ok(executable && source);
  const profile = await mkdtemp(join(tmpdir(), "dai-partial-ui-"));
  const project = join(profile, "project");
  await mkdir(project);
  const name = basename(source);
  await copyFile(source, join(project, name));
  const planner = await servePlanner((request) => {
    const user =
      request.messages
        .filter((message) => message.role === "user" && typeof message.content === "string")
        .at(-1)?.content ?? "";
    if (user.includes("应用事件：用户已进入场景搭建")) return { text: "请问是什么场景？" };
    if (user === "观察六视图") {
      const index = request.messages.findIndex(
        (message) => message.tool_call_id === "real-overview",
      );
      if (index < 0) {
        const current = sceneContext(request).currentDisplay;
        assert.ok(current);
        return {
          id: "real-overview",
          name: "viewport_capture",
          args: {
            importId: current.importId,
            revision: current.placement.revision,
            view: "overview",
          },
        };
      }
      const message = request.messages
        .slice(index + 1)
        .find((item) => item.role === "user" && Array.isArray(item.content));
      const blocks = message?.content as unknown as
        | { type: string; image_url?: { url: string } }[]
        | undefined;
      const url = blocks?.find((item) => item.type === "image_url")?.image_url?.url ?? "";
      assert.match(url, /^data:image\/jpeg;base64,/);
      if (process.env.DAI_OVERVIEW_TEST_OUTPUT)
        writeFileSync(
          process.env.DAI_OVERVIEW_TEST_OUTPUT,
          Buffer.from(url.split(",")[1] ?? "", "base64"),
        );
      return { text: "已观察六视图。" };
    }
    if (user.includes("重新定向")) {
      const current = sceneContext(request).currentDisplay;
      if (!turnResults(request).has("frame"))
        return {
          id: "frame",
          name: "alignment_align_frame",
          args: {
            importId: current?.importId,
            expectedRevision: current?.placement?.revision,
            sourceUp: { kind: "model_axis", axis: "Y" },
            sourceForward: { kind: "model_axis", axis: "X" },
            anchor: "min_corner",
            target: { origin: [0, 0, 0], up: [0, 0, 1], forward: [1, 0, 0] },
          },
        };
      return { text: "整机旋转已计算。" };
    }
    if (user.includes("角点归零")) {
      if (!turnResults(request).has("align")) {
        const importId = currentDisplayId(request);
        if (!importId) throw new Error("Missing saved model");
        return { id: "align", name: "alignment_align_min_corner", args: { importId } };
      }
      return { text: "整机定位已计算。" };
    }
    return planCadImport(request, "preview", true) ?? { text: "显示资源已生成，诊断仍然保留。" };
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
  let application = await launch();
  try {
    let page = await application.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setContentSize(1500, 950),
    );
    await chooseProject(application, page, project);
    const id = await page.evaluate(async (endpoint) => {
      const api = window.desktop.application;
      await api.saveProvider({
        id: "partial-test",
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
      await api.updateConversation({ id, modelId: "partial-test:test" });
      return id;
    }, planner.endpoint);
    await page.getByRole("button", { name: "通用对话", exact: true }).click();
    await page.getByRole("menuitem", { name: /^场景搭建/ }).click();
    await page.getByText("请问是什么场景？", { exact: true }).waitFor();
    await page.getByRole("button", { name: "当前 STEP", exact: true }).click();
    await page.getByRole("button", { name, exact: false }).click();
    await page.getByRole("textbox", { name: "消息内容", exact: true }).fill("解析选中的 STEP");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    const ready = '.scene-stage[data-display-status="ready"][data-scene-loaded="true"]';
    await page.locator(ready).waitFor({ timeout: 130_000 });
    await page.getByRole("button", { name: "发送消息", exact: true }).waitFor();
    await page.getByRole("textbox", { name: "消息内容", exact: true }).fill("观察六视图");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await page.getByText("已观察六视图。", { exact: true }).waitFor();
    const result = (await page.evaluate(async (conversationId) => {
      const model = await window.desktop.application.getDisplay(conversationId);
      if (!model) throw new Error("Missing display");
      const manifest = await (await fetch(model.manifest.url)).json();
      const faceMap = model.resources.find((resource) => resource.mediaType === "application/json");
      if (!faceMap) throw new Error("Missing CAD map");
      return {
        importId: model.importId,
        manifest,
        mapping: await (await fetch(faceMap.url)).json(),
      };
    }, id)) as { importId: string; manifest: CadManifest; mapping: CadFaceMap };
    assert.ok(result.manifest.complete || (result.manifest.omittedFaceCount ?? 0) > 0);
    if (
      result.manifest.source.sourceHash ===
      "a61a79d8ec01692539c51792aa2a7d2a8dd5fe642084b1632f97788a6f5eedae"
    ) {
      assert.equal(result.manifest.complete, false);
      assert.equal(result.manifest.omittedFaceCount, 4);
      assert.equal(result.manifest.objects.length, 361);
      assert.equal(result.mapping.recoveries?.length, 7);
      await page.getByText("部分显示 · 4 个 CAD 面未显示", { exact: true }).waitFor();
    }
    for (const omitted of result.mapping.omittedFaces ?? [])
      assert.equal(
        result.mapping.ranges.some(
          (range) =>
            range.geometryId === omitted.geometryId &&
            range.topologyRef.id === omitted.topologyRef.id,
        ),
        false,
      );
    await page.locator(".object-tree-name").first().click();
    await page.locator(".scene-selection").waitFor();
    await page.screenshot({ path: resolve("out/cad-partial.png") });
    const transparency = page.getByRole("slider", { name: "对象透明度", exact: true });
    for (let index = 0; index < 5; index++) await transparency.press("PageUp");
    assert.equal(await transparency.inputValue(), "50");
    await page.screenshot({ path: resolve("out/cad-transparency-light.png") });
    await page.evaluate(() => window.desktop.application.updateSettings({ theme: "dark" }));
    await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
    assert.equal(await transparency.inputValue(), "50");
    await page.screenshot({ path: resolve("out/cad-transparency-dark.png") });
    const canvas = await page.getByLabel("三维场景视图", { exact: true }).elementHandle();
    assert.ok(canvas);
    await page
      .getByRole("textbox", { name: "消息内容", exact: true })
      .fill("将整套装配的最小角点归零");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await page.waitForFunction(
      () =>
        Number(document.querySelector(".scene-stage")?.getAttribute("data-placement-revision")) > 0,
    );
    await page.getByText("整机定位已计算。", { exact: true }).waitFor();
    assert.equal(
      await canvas.evaluate((node) => node.isConnected),
      true,
      "Placement must reuse the current GPU model/canvas",
    );
    let placement = await page.evaluate(
      async (id) => (await window.desktop.application.getDisplay(id))?.placement,
      id,
    );
    assert.ok(placement?.revision && placement.translation.some((value) => Math.abs(value) > 1e-8));
    assert.equal(
      await page.getByRole("slider", { name: "对象透明度", exact: true }).inputValue(),
      "50",
    );
    await page.screenshot({ path: resolve("out/cad-aligned.png") });
    const beforeRotation = await page.getByLabel("三维场景视图", { exact: true }).screenshot();
    const previousRevision = placement.revision;
    await page
      .getByRole("textbox", { name: "消息内容", exact: true })
      .fill("重新定向：原 Y 朝上，旋转后最小角点归零");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await page.waitForFunction(
      (revision) =>
        Number(document.querySelector(".scene-stage")?.getAttribute("data-placement-revision")) >
        revision,
      previousRevision,
    );
    await page.getByText("整机旋转已计算。", { exact: true }).waitFor();
    placement = await page.evaluate(
      async (id) => (await window.desktop.application.getDisplay(id))?.placement,
      id,
    );
    assert.ok(placement && Math.abs(placement.rotation[0] - Math.SQRT1_2) < 1e-8);
    assert.equal(await canvas.evaluate((node) => node.isConnected), true);
    const afterRotation = await page.getByLabel("三维场景视图", { exact: true }).screenshot();
    assert.equal(
      beforeRotation.equals(afterRotation),
      false,
      "New rotation must reach the actual canvas",
    );
    await page.screenshot({ path: resolve("out/cad-oriented.png") });
    assert.equal(result.manifest.schemaVersion, 2);
    assert.ok(result.manifest.features?.objects.some((item) => item.count > 0));
    const requests = planner.requests.length;
    await application.close();
    application = await launch();
    page = await application.firstWindow();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.locator(ready).waitFor();
    await page.locator(".object-tree-name").first().click();
    assert.equal(
      await page.getByRole("slider", { name: "对象透明度", exact: true }).inputValue(),
      "0",
    );
    assert.equal(await page.locator(ready).getAttribute("data-import-id"), result.importId);
    assert.equal(
      await page.locator(ready).getAttribute("data-placement-revision"),
      String(placement.revision),
    );
    assert.equal(
      planner.requests.length,
      requests,
      "Restoring partial display must not rerun the model",
    );
    assert.deepEqual(planner.failures, []);
    assert.deepEqual(errors, []);
  } finally {
    await application.close();
    await planner.close();
    await rm(profile, { recursive: true, force: true });
  }
});
