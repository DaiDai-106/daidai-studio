import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { _electron as electron } from "playwright";
import { sceneContext } from "../support/cadPlan.ts";
import { servePlanner, turnResults } from "../support/planner.ts";
import { openTestProject } from "./support.ts";

test("entering scene mode opens an assistant question without a fabricated user message", {
  timeout: 30_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-scene-onboarding-ui-"));
  const planner = await servePlanner((request) => {
    const user =
      request.messages.filter((message) => message.role === "user").at(-1)?.content ?? "";
    const results = turnResults(request);
    if (user.includes("应用事件：用户已进入场景搭建")) {
      if (!results.has("list")) return { id: "list", name: "scene_list_profiles", args: {} };
      return { text: "请问是什么场景？希望先做什么？" };
    }
    if (user === "解析项目") {
      if (!results.has("list")) return { id: "list", name: "scene_list_steps", args: {} };
      if (!results.has("step"))
        return { id: "step", name: "scene_select_step", args: { relativePath: "fixture.step" } };
      assert.match(sceneContext(request).selectedSourcePath ?? "", /fixture\.step$/);
      return { text: "已选中项目文件。" };
    }
    assert.equal(user, "型钢场景，先分析");
    if (!results.has("select"))
      return {
        id: "select",
        name: "scene_select_profile",
        args: { profileId: "steel-structure", scope: "project" },
      };
    assert.equal(sceneContext(request).sceneProfileId, "steel-structure");
    return { text: "已选择型钢场景。" };
  });
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
    await page.evaluate(async (endpoint) => {
      const api = window.desktop.application;
      await api.saveProvider({
        id: "scene-ui",
        name: "Scene UI",
        providerType: "local",
        authMethod: "none",
        endpoint,
        enabled: true,
        persistCredentials: false,
        models: [{ id: "test", name: "Test", context: 128000, output: 1000, reasoning: "标准" }],
      });
      await api.updateSettings({ defaultModel: "scene-ui:test" });
    }, planner.endpoint);
    const project = await openTestProject(app, page, root);
    await writeFile(join(project, "fixture.step"), "fixture");
    await page.getByRole("button", { name: "通用对话", exact: true }).click();
    await page.getByRole("menuitem", { name: /^场景搭建/ }).click();
    await page.getByText("请问是什么场景？希望先做什么？", { exact: true }).waitFor();
    assert.equal(await page.locator(".message.user").count(), 0);
    assert.equal(await page.getByText(/应用事件：/).count(), 0);
    await page.getByRole("textbox", { name: "消息内容", exact: true }).fill("型钢场景，先分析");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await page.getByText("已选择型钢场景。", { exact: true }).waitFor();
    assert.equal(await page.locator(".message.user").count(), 1);
    await page.getByRole("textbox", { name: "消息内容", exact: true }).fill("解析项目");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await page.getByText("已选中项目文件。", { exact: true }).waitFor();
    assert.match(
      (await page.getByRole("button", { name: "当前 STEP", exact: true }).textContent()) ?? "",
      /fixture\.step/,
    );
    assert.deepEqual(planner.failures, []);
  } finally {
    await app.close();
    await planner.close();
    await rm(root, { recursive: true, force: true });
  }
});
