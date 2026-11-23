import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { testRobot } from "../support/scene_fixture.ts";
import { launchTestApp } from "./support.ts";

test("画布每次初始化只同步一次，侧栏调宽不更新材质，透明度仍可修改", {
  timeout: 30_000,
}, async (context) => {
  const { application, page, profile } = await launchTestApp(context);
  await page.setViewportSize({ width: 1920, height: 1080 });
  const directory = join(profile, "project");
  const file = join(profile, "robot.urdf");
  await mkdir(directory);
  await writeFile(file, testRobot);
  await application.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, directory);
  await page.evaluate(() =>
    window.desktop.application.createProject({ name: "Render test", mode: "scene" }),
  );
  await page.getByRole("button", { name: "打开项目 Render test", exact: true }).click();
  const scene = page.getByRole("region", { name: "场景工作区" });
  await application.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, file);
  const settle = () =>
    page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.startPreciseCoverage", { callCount: true, detailed: true });
  try {
    await scene.getByRole("button", { name: "导入 URDF", exact: true }).click();
    await scene.getByLabel("机器人 3D 画布", { exact: true }).waitFor();
    await settle();
    const initial = (await cdp.send("Profiler.takePreciseCoverage")).result.flatMap(
      (script) => script.functions,
    );
    const calls = (name: string) =>
      initial
        .filter((fn) => fn.functionName === name)
        .reduce((count, fn) => count + (fn.ranges[0]?.count ?? 0), 0);
    const created = calls("createSceneViewport");
    assert.ok(created > 0, "应能观测视口创建，包含 StrictMode 的生命周期重放");
    assert.equal(calls("setOpacity"), created, "每个视口只执行一次初始材质同步");
    await scene.getByRole("button", { name: "base", exact: true }).click();
    await settle();
    const materialUpdates = async () => {
      const { result } = await cdp.send("Profiler.takePreciseCoverage");
      const setters = result.flatMap((script) =>
        script.functions.filter((fn) => fn.functionName === "setOpacity"),
      );
      return setters.reduce((count, fn) => count + (fn.ranges[0]?.count ?? 0), 0);
    };
    const opacity = scene.getByRole("slider", { name: "所选对象透明度" });
    await opacity.focus();
    await opacity.press("ArrowRight");
    await page.waitForFunction(
      () =>
        document.querySelector<HTMLInputElement>('[aria-label="所选对象透明度"]')?.value === "1",
    );
    await settle();
    assert.ok((await materialUpdates()) > 0, "应能观测真实模型材质更新函数");
    const splitter = scene.getByRole("separator", { name: "调整属性与画布宽度" });
    const width = await splitter.getAttribute("aria-valuenow");
    await splitter.press("ArrowLeft");
    await page.waitForFunction(
      (before) =>
        document
          .querySelector('[aria-label="调整属性与画布宽度"]')
          ?.getAttribute("aria-valuenow") !== before,
      width,
    );
    await settle();
    assert.equal(await materialUpdates(), 0);
    await opacity.focus();
    await opacity.press("ArrowRight");
    await page.waitForFunction(
      () =>
        document.querySelector<HTMLInputElement>('[aria-label="所选对象透明度"]')?.value === "2",
    );
    await settle();
    assert.ok((await materialUpdates()) > 0);
  } finally {
    await cdp.send("Profiler.stopPreciseCoverage");
    await cdp.detach();
  }
});
