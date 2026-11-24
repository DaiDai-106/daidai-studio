import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { parseUrdf, writeUrdf } from "../../src/backend/module/scene/urdf.ts";
import { REQUEST_CHANNEL } from "../../src/contracts/desktop.ts";
import { testRobot } from "../support/scene_fixture.ts";
import { stepWorkerAvailable, writeStepFixture } from "../support/step_fixture.ts";
import { holdApplicationResponses, launchTestApp } from "./support.ts";

test("场景项目在工作区导入、改关节、撤销和导出 URDF", { timeout: 45_000 }, async (context) => {
  const { application, page, profile } = await launchTestApp(context);
  const documents = join(profile, "documents");
  const urdf = join(profile, "robot.urdf");
  const step = join(profile, "original.step");
  const replacement = join(profile, "replacement.step");
  const warning = "零件「arm」已跳过 3 个无法网格化的曲面。";
  await mkdir(documents);
  await mkdir(join(profile, "meshes"));
  const triangle = Buffer.alloc(134);
  triangle.writeUInt32LE(1, 80);
  triangle.writeFloatLE(1, 108);
  triangle.writeFloatLE(1, 124);
  await writeFile(join(profile, "meshes", "triangle.stl"), triangle);
  const { robot } = parseUrdf(
    testRobot
      .replace(
        "</link>",
        '<visual><geometry><mesh filename="triangle.stl"/></geometry></visual></link>',
      )
      .replace(
        "</robot>",
        '<link name="spindle"/><joint name="spin" type="continuous"><parent link="base"/><child link="spindle"/></joint></robot>',
      ),
  );
  await writeFile(
    urdf,
    writeUrdf(robot, [warning, "STEP 装配按固定关节导入。"]).replace(
      "</link>",
      '<collision><geometry><box size="1 1 1"/></geometry></collision></link>',
    ),
  );
  if (stepWorkerAvailable) {
    await writeStepFixture(step);
    await writeStepFixture(replacement, "inch");
  }
  const meshResponse = await application.evaluateHandle(
    ({ app, dialog, ipcMain }, paths) => {
      app.setPath("documents", paths.documents);
      const choices = [paths.urdf, paths.documents, paths.step, paths.replacement];
      dialog.showOpenDialog = async () => {
        const path = choices.shift();
        return { canceled: !path, filePaths: path ? [path] : [] };
      };
      const handlers = (
        ipcMain as unknown as {
          _invokeHandlers: Map<string, Parameters<typeof ipcMain.handle>[1]>;
        }
      )._invokeHandlers;
      const request = handlers.get(paths.channel);
      if (!request) throw new Error("缺少应用 IPC 入口。");
      ipcMain.removeHandler(paths.channel);
      const gate = Promise.withResolvers<void>();
      ipcMain.handle(paths.channel, async (event, method, args) => {
        if (method === "scene.asset") {
          await gate.promise;
          throw new Error("模拟网格读取失败");
        }
        return request(event, method, args);
      });
      return gate.resolve;
    },
    { documents, urdf, step, replacement, channel: REQUEST_CHANNEL },
  );

  await page.getByRole("button", { name: "新建项目", exact: true }).first().click();
  const form = page.getByRole("dialog", { name: "新建项目" });
  await form.getByLabel("项目名称").fill("工作台");
  await form.getByLabel("项目类型").selectOption("scene");
  assert.equal(await form.getByRole("button", { name: "选择文件夹" }).count(), 0);
  await form.getByRole("button", { name: "创建项目" }).click();
  await form.waitFor({ state: "hidden" });

  const scene = page.getByRole("region", { name: "场景工作区" });
  const importNotice = scene.getByText(/已跳过.+曲面|STEP 装配按固定关节导入/);
  const mobileTab = page.getByRole("tab", { name: "场景", exact: true });
  if (await mobileTab.isVisible()) await mobileTab.click();
  await scene.getByRole("button", { name: "导入 URDF" }).click();
  const tree = scene.getByRole("navigation", { name: "机器人结构树" });
  const swivel = tree.getByRole("button", { name: "swivel", exact: true });
  await scene.getByText("无（根节点，以世界坐标为基准）").waitFor();
  const importWarnings = scene.getByLabel("导入警告", { exact: true });
  await importWarnings.locator("summary").click();
  await importWarnings.getByText("未保留 <link> 中的其他 URDF 元素。", { exact: true }).waitFor();
  await swivel.click();
  await scene.getByText("父级连杆").waitFor();
  assert.equal(
    await scene.locator(".scene-transform").first().getByText("base", { exact: true }).count(),
    1,
  );
  assert.equal(await importNotice.count(), 2);
  const side = scene.locator(".scene-outliner");
  await side.getByRole("region", { name: "坐标变换" }).waitFor();
  assert.ok(await tree.isVisible());
  assert.ok(await side.getByRole("region", { name: "场景属性" }).isVisible());
  const treeBounds = await tree.boundingBox();
  const propertyBounds = await side.locator(".scene-properties").boundingBox();
  assert.ok(treeBounds && propertyBounds && propertyBounds.y >= treeBounds.y + treeBounds.height);
  await side.getByLabel("关节名称", { exact: true }).waitFor();
  const canvas = scene.locator("canvas");
  const fallback = scene.getByText("当前环境无法启动 3D 显示。", { exact: false });
  await canvas.or(fallback).waitFor({ state: "visible" });
  context.diagnostic(
    (await canvas.isVisible()) ? "WebGL canvas displayed" : "WebGL fallback displayed",
  );
  if (await canvas.isVisible()) {
    const view = await canvas.boundingBox();
    assert.ok(view);
    const origin = scene.locator(".scene-axis-origin");
    const getOriginX = () => origin.evaluate((element) => element.getBoundingClientRect().left);
    const start = await getOriginX();
    await page.mouse.move(view.x + view.width / 2, view.y + view.height / 2);
    await page.mouse.down({ button: "right" });
    await page.mouse.move(view.x + view.width / 2 + 50, view.y + view.height / 2);
    await page.mouse.up({ button: "right" });
    await page.waitForFunction(
      (left) =>
        Math.abs(
          (document.querySelector(".scene-axis-origin")?.getBoundingClientRect().left ?? left) -
            left,
        ) > 20,
      start,
    );
    const afterPan = await getOriginX();
    await meshResponse.evaluate((release) => release());
    await scene.getByText("有 STL 网格无法显示。", { exact: true }).waitFor();
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    assert.ok(Math.abs((await getOriginX()) - afterPan) < 2, "网格加载完成后保留手动平移");
    assert.ok(await scene.getByRole("button", { name: "适应模型", exact: true }).isVisible());
    assert.equal(await scene.getByText("XY 网格", { exact: true }).count(), 0);
    await scene.getByRole("button", { name: "定位原点", exact: true }).click();
    await page.waitForFunction(() => {
      const view = document.querySelector(".scene-canvas")?.getBoundingClientRect();
      const origin = document.querySelector(".scene-axis-origin")?.getBoundingClientRect();
      return (
        view &&
        origin &&
        origin.width > 0 &&
        Math.abs(origin.left + origin.width / 2 - view.left - view.width / 2) < 2 &&
        Math.abs(origin.top - view.top - view.height / 2) < 14
      );
    });
    assert.deepEqual(await scene.locator(".scene-axis-label").allTextContents(), ["X", "Y", "Z"]);
  } else await meshResponse.evaluate((release) => release());
  await meshResponse.dispose();
  const position = scene.getByLabel("位置 (rad)", { exact: true });
  await position.fill("1");
  await scene.getByRole("button", { name: "应用位置" }).click();
  const project = await page.evaluate(async () =>
    (await window.desktop.application.getWorkspace()).projects.find(
      (item) => item.mode === "scene",
    ),
  );
  assert.ok(project);
  const readScene = () =>
    page.evaluate((id) => window.desktop.application.getScene(id), project.id);
  const waitForPosition = (position: number) =>
    page.waitForFunction(
      async ({ id, position }) =>
        (await window.desktop.application.getScene(id)).document.robot?.joints[0]?.position ===
        position,
      { id: project.id, position },
    );
  await waitForPosition(1);
  await scene.getByRole("button", { name: "撤销", exact: true }).click();
  await waitForPosition(0);

  const slider = scene.getByRole("slider", { name: "预览位置" });
  const bounds = await slider.boundingBox();
  assert.ok(bounds);
  const y = bounds.y + bounds.height / 2;
  await page.mouse.move(bounds.x + bounds.width / 2, y);
  await page.mouse.down();
  try {
    await page.mouse.move(bounds.x + bounds.width * 0.8, y);
    const preview = await readScene();
    assert.equal(preview.document.robot?.joints[0]?.position, 0);
  } finally {
    await page.mouse.up();
  }
  await page.waitForFunction(async (id) => {
    const snapshot = await window.desktop.application.getScene(id);
    return (snapshot.document.robot?.joints[0]?.position ?? 0) > 0.5;
  }, project.id);

  const name = scene.getByLabel("关节名称", { exact: true });
  await name.fill("尚未保存的名称");
  const originDraft = scene
    .getByRole("form", { name: "关节配置" })
    .getByLabel("原点位置 (m) X", { exact: true });
  await originDraft.fill("0.125");
  // Simulate the same committed document update that a Pi tool emits during a drag.
  await page.mouse.move(bounds.x + bounds.width * 0.8, y);
  await page.mouse.down();
  let externalRevision = 0;
  try {
    await page.mouse.move(bounds.x + bounds.width * 0.7, y);
    externalRevision = await page.evaluate(async (projectId) => {
      const api = window.desktop.application;
      const { document } = await api.getScene(projectId);
      return (
        await api.applyScene({
          projectId,
          expectedRevision: document.revision,
          operation: { op: "setJointPosition", jointId: "joint-0", position: -1 },
        })
      ).document.revision;
    }, project.id);
    await page.waitForFunction(
      () => document.querySelector<HTMLInputElement>(".scene-range input")?.valueAsNumber === -1,
    );
    await page.mouse.move(bounds.x + bounds.width * 0.9, y);
  } finally {
    await page.mouse.up();
  }
  const snapshot = await readScene();
  assert.equal(snapshot.document.revision, externalRevision);
  assert.equal(snapshot.document.robot?.joints[0]?.position, -1);
  assert.equal(await name.inputValue(), "尚未保存的名称");
  assert.equal(await originDraft.inputValue(), "0.125");

  await slider.focus();
  for (let step = 1; step <= 2; step++) {
    await slider.press("ArrowRight");
    await page.waitForFunction(
      async ({ projectId, revision }) =>
        (await window.desktop.application.getScene(projectId)).document.revision === revision,
      { projectId: project.id, revision: externalRevision + step },
    );
    await page.waitForFunction(
      () => document.querySelector(".scene-range input")?.getAttribute("aria-disabled") === "false",
    );
    assert.ok(await slider.evaluate((element) => element === document.activeElement));
  }

  await tree.getByRole("button", { name: "spin", exact: true }).click();
  const jointForm = side.getByRole("form", { name: "关节配置" });
  const saveJoint = jointForm.getByRole("button", { name: "保存关节配置", exact: true });
  const effort = jointForm.getByLabel("最大力/力矩");
  const velocity = jointForm.getByLabel("最大速度");
  assert.equal(await effort.inputValue(), "");
  assert.equal(await velocity.inputValue(), "");
  const beforeSave = await readScene();
  const hold = await holdApplicationResponses(application);
  const saved = await hold("scene.apply");
  try {
    await saveJoint.click();
    await saved.entered();
    assert.deepEqual(await readScene(), beforeSave);
  } finally {
    await saved.release();
  }
  await jointForm.locator('button[type="submit"]:enabled').waitFor();
  await swivel.click();

  await scene.getByRole("button", { name: "导出 URDF" }).click();
  const status = scene.getByText(/^已导出至 /);
  await status.waitFor();
  const result = (await status.textContent())?.replace(/^已导出至 /, "");
  assert.ok(result);
  const exported = parseUrdf(await readFile(result, "utf8"));
  assert.equal(exported.robot.joints[0]?.name, "swivel");
  const spin = exported.robot.joints.find(({ name }) => name === "spin");
  assert.equal(spin?.type, "continuous");
  assert.equal(spin.limit, undefined);
  assert.equal(exported.warnings[0], warning);

  const before = await readScene();
  await side.getByRole("button", { name: "原始模型", exact: true }).click();
  await side.getByText("当前场景缺少原始模型快照。").waitFor();
  if (!stepWorkerAvailable) return;
  await side.getByRole("button", { name: "补充原始 STEP", exact: true }).click();
  const sourceTree = side.getByRole("navigation", { name: "原始模型结构树" });
  await sourceTree.getByRole("button", { name: "Root", exact: true }).waitFor();
  assert.equal(await importNotice.count(), 0);
  assert.equal(await scene.getByLabel("导入警告", { exact: true }).count(), 0);
  assert.ok(await sourceTree.isVisible());
  assert.equal(await side.getByRole("region", { name: "场景属性" }).count(), 0);
  await side.getByText("原始 CAD 坐标（搭建参照）", { exact: true }).click();
  await side.getByRole("region", { name: "坐标变换" }).waitFor();
  await side.getByText("属性 · URDF 配置").waitFor();
  const after = await readScene();
  assert.equal(after.document.sourceRobot?.name, "original");
  assert.deepEqual(after.document.sourceWarnings, []);
  assert.deepEqual(after.document.robot, before.document.robot);
  assert.deepEqual(after.document.warnings, before.document.warnings);

  const subassembly = sourceTree.getByRole("button", { name: "SubInstance", exact: true });
  await subassembly.click();
  assert.equal(await subassembly.getAttribute("aria-current"), "true");
  const checked = sourceTree.getByRole("checkbox", { name: "选择零件 Root", exact: true });
  await checked.check();
  await side.getByRole("button", { name: "清空多选", exact: true }).waitFor();
  await scene.getByRole("button", { name: "撤销", exact: true }).click();
  await side.getByText("当前场景缺少原始模型快照。").waitFor();
  await side.getByRole("button", { name: "补充原始 STEP", exact: true }).click();
  await checked.waitFor();
  assert.equal(await checked.isChecked(), false);
  assert.equal(await subassembly.getAttribute("aria-current"), null);
  assert.equal((await readScene()).document.sourceRobot?.name, "replacement");
  await side.getByRole("button", { name: "构建场景", exact: true }).click();
  assert.equal(await swivel.getAttribute("aria-current"), "true");
});
