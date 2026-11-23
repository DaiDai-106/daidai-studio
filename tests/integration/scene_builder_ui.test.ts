import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { stepWorkerAvailable, writeStepFixture } from "../support/step_fixture.ts";
import { launchTestApp } from "./support.ts";

test("原始模型多选搭建 Link/Joint，两个视图编辑同一配置，解除绑定可撤销", {
  timeout: 45_000,
  skip: !stepWorkerAvailable && "先运行 npm run build:scene",
}, async (context) => {
  const { application, page, profile } = await launchTestApp(context);
  await page.setViewportSize({ width: 1920, height: 1080 });
  const directory = join(profile, "project");
  const step = join(profile, "assembly.step");
  await mkdir(directory);
  await writeStepFixture(step);
  await application.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, directory);
  await page.evaluate(() =>
    window.desktop.application.createProject({ name: "URDF 搭建测试", mode: "scene" }),
  );
  await page.getByRole("button", { name: "打开项目 URDF 搭建测试", exact: true }).click();
  const scene = page.getByRole("region", { name: "场景工作区" });
  const mobileTab = page.getByRole("tab", { name: "场景", exact: true });
  if (await mobileTab.isVisible()) await mobileTab.click();
  await application.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, step);
  await scene.getByRole("button", { name: "导入 STEP", exact: true }).click();
  await scene.getByRole("button", { name: "原始模型", exact: true }).click();
  const tree = scene.getByRole("navigation", { name: "原始模型结构树" });
  await tree.getByRole("checkbox", { name: "选择零件 Root", exact: true }).check();
  await scene.getByText("已选择 4 个几何零件", { exact: true }).waitFor();
  const creation = scene.getByRole("form", { name: "从零件创建连杆" });
  const side = scene.locator(".scene-outliner");
  const properties = scene.locator(".scene-properties");
  const sideBounds = await side.boundingBox();
  const propertyBounds = await properties.boundingBox();
  const treeBounds = await tree.boundingBox();
  const nameBounds = await creation.getByLabel("新连杆名称", { exact: true }).boundingBox();
  const jointNameBounds = await creation.getByLabel("新关节名称", { exact: true }).boundingBox();
  const createBounds = await creation.getByRole("button", { name: "创建连杆并分配" }).boundingBox();
  assert.ok(sideBounds && sideBounds.width > 290);
  assert.ok(propertyBounds && treeBounds && propertyBounds.height > treeBounds.height);
  assert.ok(nameBounds && jointNameBounds && Math.abs(nameBounds.y - jointNameBounds.y) < 1);
  assert.ok(nameBounds.height <= 34);
  assert.ok(
    createBounds &&
      createBounds.y + createBounds.height <= propertyBounds.y + propertyBounds.height,
  );
  const splitter = scene.getByRole("separator", { name: "调整属性与画布宽度" });
  await splitter.focus();
  await splitter.press("ArrowRight");
  const widerBounds = await side.boundingBox();
  assert.ok(widerBounds && widerBounds.width > sideBounds.width);
  const stage = scene.locator(".scene-stage");
  const stageBounds = await stage.boundingBox();
  assert.ok(stageBounds);
  await splitter.dragTo(stage, {
    sourcePosition: { x: 2, y: 20 },
    targetPosition: { x: stageBounds.width * 0.38, y: 20 },
  });
  await page.waitForFunction(
    (width) =>
      (document.querySelector(".scene-outliner")?.getBoundingClientRect().width ?? Infinity) <
      width,
    sideBounds.width,
    { timeout: 5000 },
  );
  const draggedBounds = await side.boundingBox();
  assert.ok(draggedBounds && draggedBounds.width < sideBounds.width);
  await page.setViewportSize({ width: 800, height: 850 });
  if (await mobileTab.isVisible()) await mobileTab.click();
  assert.ok(await splitter.isVisible());
  const narrowName = await creation.getByLabel("新连杆名称", { exact: true }).boundingBox();
  const narrowJoint = await creation.getByLabel("新关节名称", { exact: true }).boundingBox();
  assert.ok(narrowName && narrowJoint && narrowJoint.y > narrowName.y + narrowName.height);
  assert.ok(await creation.evaluate((form) => form.scrollWidth <= form.clientWidth));
  await page.setViewportSize({ width: 3000, height: 1080 });
  await splitter.focus();
  for (let index = 0; index < 30; index++) await splitter.press("ArrowRight");
  const maximumSide = await side.boundingBox();
  const maximumValue = Number(await splitter.getAttribute("aria-valuenow"));
  assert.ok(maximumSide && Math.abs(maximumSide.width - 480) < 1);
  await splitter.press("ArrowLeft");
  const shrinkingSide = await side.boundingBox();
  assert.ok(shrinkingSide && shrinkingSide.width < maximumSide.width - 1);
  assert.ok(Number(await splitter.getAttribute("aria-valuenow")) > maximumValue);
  for (let index = 0; index < 30; index++) await splitter.press("ArrowLeft");
  const minimumSide = await side.boundingBox();
  assert.ok(minimumSide && Math.abs(minimumSide.width - 210) < 1);
  await splitter.press("ArrowRight");
  const growingSide = await side.boundingBox();
  assert.ok(growingSide && growingSide.width > minimumSide.width + 1);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await creation.getByLabel("新连杆名称", { exact: true }).fill("arm");
  await creation.getByLabel("新关节名称", { exact: true }).fill("hinge");
  await creation.getByLabel("新关节类型", { exact: true }).selectOption("revolute");
  await creation.getByRole("button", { name: "创建连杆并分配", exact: true }).click();
  await scene.getByText("所属 Link：arm", { exact: true }).waitFor();
  assert.equal(
    await scene.getByLabel("分配到连杆", { exact: true }).locator("option:checked").textContent(),
    "arm",
  );
  const jointForm = scene.getByRole("form", { name: "关节配置" });
  await jointForm.getByLabel("原点位置 (m) X", { exact: true }).fill("0.25");
  await jointForm.getByLabel("关节轴 X", { exact: true }).fill("1");
  await jointForm.getByLabel("关节轴 Z", { exact: true }).fill("0");
  await jointForm.getByRole("button", { name: "保存关节配置", exact: true }).click();
  await scene.getByRole("button", { name: "构建场景", exact: true }).click();
  const builtTree = scene.getByRole("navigation", { name: "机器人结构树" });
  await builtTree.getByRole("button", { name: "base_link", exact: true }).click();
  const emptyLink = scene.locator(".scene-link-controls > details");
  await emptyLink.locator("summary").click();
  await emptyLink.getByLabel("新连杆名称", { exact: true }).fill("spare");
  await emptyLink.getByLabel("新关节名称", { exact: true }).fill("spare_joint");
  await emptyLink.getByLabel("新关节类型", { exact: true }).selectOption("fixed");
  await emptyLink.getByRole("button", { name: "添加", exact: true }).click();
  await builtTree.getByRole("button", { name: "spare", exact: true }).waitFor();
  await scene.getByRole("button", { name: "撤销", exact: true }).click();
  await builtTree.getByRole("button", { name: "spare", exact: true }).waitFor({ state: "hidden" });
  await builtTree.getByRole("button", { name: "arm", exact: true }).click();
  assert.equal(await jointForm.getByLabel("原点位置 (m) X", { exact: true }).inputValue(), "0.25");
  await jointForm.getByLabel("原点位置 (m) Y", { exact: true }).fill("0.5");
  await jointForm.getByRole("button", { name: "保存关节配置", exact: true }).click();
  const transparency = scene.getByRole("slider", { name: "所选对象透明度" });
  await transparency.fill("35");
  await transparency.dispatchEvent("pointerup");
  // Wait until the setting has been saved before switching view or reading it back.
  await scene.getByRole("button", { name: "撤销", exact: true }).waitFor({ state: "visible" });
  const project = await page.evaluate(async () => {
    const project = (await window.desktop.application.getWorkspace()).projects.find(
      (project) => project.mode === "scene",
    );
    if (!project) throw new Error("缺少项目");
    return project;
  });
  const readScene = () =>
    page.evaluate((id) => window.desktop.application.getScene(id), project.id);
  await page.waitForFunction(
    async (id) =>
      (await window.desktop.application.getScene(id)).document.transparencies?.filter(
        (setting) => setting.entity === "source" && setting.value === 35,
      ).length === 4,
    project.id,
  );
  const beforeCancellation = (await readScene()).document.revision;
  await transparency.fill("60");
  await transparency.dispatchEvent("pointercancel");
  await transparency.blur();
  assert.equal(await transparency.inputValue(), "35");
  assert.equal((await readScene()).document.revision, beforeCancellation);
  await transparency.evaluate((input) => {
    input.addEventListener(
      "pointerdown",
      (event) => {
        if (event instanceof PointerEvent)
          input.setAttribute("data-test-pointer", String(event.pointerId));
      },
      { once: true },
    );
  });
  const opacityBounds = await transparency.boundingBox();
  assert.ok(opacityBounds);
  await page.mouse.move(
    opacityBounds.x + opacityBounds.width * 0.6,
    opacityBounds.y + opacityBounds.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    opacityBounds.x + opacityBounds.width * 0.65,
    opacityBounds.y + opacityBounds.height / 2,
  );
  const pointerId = Number(await transparency.getAttribute("data-test-pointer"));
  // 原生 range 的滑块在 shadow DOM 内持有捕获，注入丢失事件验证取消分支。
  await transparency.dispatchEvent("lostpointercapture", { pointerId });
  await page.mouse.move(
    opacityBounds.x + opacityBounds.width * 0.7,
    opacityBounds.y + opacityBounds.height / 2,
  );
  await page.mouse.up();
  await transparency.blur();
  assert.equal(await transparency.inputValue(), "35");
  assert.equal((await readScene()).document.revision, beforeCancellation);
  // A new keyboard interaction must still commit after a cancelled drag.
  await transparency.press("ArrowRight");
  await page.waitForFunction(
    async (id) =>
      (await window.desktop.application.getScene(id)).document.transparencies?.every(
        (setting) => setting.value === 36,
      ),
    project.id,
  );
  await transparency.press("ArrowLeft");
  await page.waitForFunction(
    async (id) =>
      (await window.desktop.application.getScene(id)).document.transparencies?.every(
        (setting) => setting.value === 35,
      ),
    project.id,
  );
  await scene.getByRole("button", { name: "原始模型", exact: true }).click();
  await tree.getByRole("button", { name: "Root", exact: true }).click();
  assert.equal(await transparency.inputValue(), "35");
  assert.equal(await jointForm.getByLabel("原点位置 (m) Y", { exact: true }).inputValue(), "0.5");
  const configured = await readScene();
  assert.equal(configured.document.robot?.links.length, 2);
  assert.equal(configured.document.robot?.links[1]?.sourceParts?.length, 4);
  assert.deepEqual(configured.document.robot?.joints[0]?.axis, [1, 0, 0]);
  const original = configured.document.sourceRobot;
  await scene.getByRole("button", { name: "解除所选零件绑定", exact: true }).click();
  await scene.getByRole("button", { name: "确认重新分配或解除", exact: true }).click();
  await scene.getByText("所属 Link：arm", { exact: true }).waitFor({ state: "hidden" });
  assert.equal((await readScene()).document.robot?.links[1]?.sourceParts?.length, 0);
  await scene.getByRole("button", { name: "撤销", exact: true }).click();
  await scene.getByText("所属 Link：arm", { exact: true }).waitFor();
  assert.deepEqual((await readScene()).document.sourceRobot, original);
  // Reload the actual renderer; persisted settings/bindings must not be component-local state.
  await page.reload();
  await page.getByRole("button", { name: "打开项目 URDF 搭建测试", exact: true }).click();
  if (await mobileTab.isVisible()) await mobileTab.click();
  await scene.getByRole("slider", { name: "所选对象透明度" }).waitFor();
  await scene.getByRole("button", { name: "原始模型", exact: true }).click();
  await tree.getByRole("button", { name: "Root", exact: true }).click();
  assert.equal(await transparency.inputValue(), "35");
  assert.equal((await readScene()).document.robot?.links[1]?.sourceParts?.length, 4);
});
