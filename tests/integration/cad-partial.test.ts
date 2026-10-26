import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { _electron as electron } from "playwright";
import type { CadFaceMap, CadManifest } from "../../resources/mcp/cad/contract.ts";
import { planCadImport } from "../support/cadPlan.ts";
import { servePlanner } from "../support/planner.ts";
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
  const planner = await servePlanner(
    (request) => planCadImport(request) ?? { text: "显示资源已生成，诊断仍然保留。" },
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
        models: [{ id: "test", name: "test", context: 128000, output: 2048, reasoning: "标准" }],
      });
      const state = await api.getWorkspace();
      const id = state.conversations[0]?.id;
      if (!id) throw new Error("Missing conversation");
      await api.updateConversation({ id, modelId: "partial-test:test" });
      return id;
    }, planner.endpoint);
    await page.getByRole("button", { name: "通用对话", exact: true }).click();
    await page.getByRole("menuitem", { name: /^场景搭建/ }).click();
    await page.getByRole("button", { name: "当前 STEP", exact: true }).click();
    await page.getByRole("button", { name, exact: false }).click();
    await page.getByRole("textbox", { name: "消息内容", exact: true }).fill("解析选中的 STEP");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    const ready = '.scene-stage[data-display-status="ready"][data-scene-loaded="true"]';
    await page.locator(ready).waitFor({ timeout: 130_000 });
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
