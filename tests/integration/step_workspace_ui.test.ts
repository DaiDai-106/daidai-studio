import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { stepAgentReply, stepWorkerAvailable, writeStepFixture } from "../support/step_fixture.ts";
import { launchTestApp } from "./support.ts";

test("场景聊天选择和拖入 STEP，Agent 直接替换装配并导出 URDF", {
  skip: !stepWorkerAvailable && "先运行 npm run build:scene",
  timeout: 45_000,
}, async (context) => {
  const { application, page, profile } = await launchTestApp(context);
  const documents = join(profile, "documents");
  const step = join(profile, "assembly.stp");
  const replacement = join(profile, "replacement.step");
  await mkdir(documents);
  await writeStepFixture(step);
  await writeStepFixture(replacement, "inch");
  let expectedImportRevision = 1;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(stepAgentReply(body, expectedImportRevision));
  });
  context.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await page.evaluate(
    (endpoint) =>
      window.desktop.application.saveProvider({
        id: "local",
        name: "Local",
        providerType: "local",
        authMethod: "none",
        endpoint,
        enabled: true,
        models: [
          { id: "example", name: "Example", context: 4096, output: 1024, reasoning: "标准" },
        ],
      }),
    `http://127.0.0.1:${address.port}/v1`,
  );
  await application.evaluate(
    ({ app, dialog }, paths) => {
      app.setPath("documents", paths.documents);
      const choices = [paths.step, paths.documents];
      dialog.showOpenDialog = async () => {
        const path = choices.shift();
        return { canceled: !path, filePaths: path ? [path] : [] };
      };
    },
    { step, documents },
  );

  await page.evaluate(() =>
    window.desktop.application.createProject({ name: "CAD 装配", mode: "scene" }),
  );
  const projectCard = page.getByRole("button", { name: "打开项目 CAD 装配", exact: true });
  await projectCard.click();

  const scene = page.getByRole("region", { name: "场景工作区" });
  const mobileTab = page.getByRole("tab", { name: "场景", exact: true });
  if (await mobileTab.isVisible()) await mobileTab.click();
  await scene.getByRole("button", { name: "导入 STEP", exact: true }).click();
  await scene.getByRole("button", { name: "原始模型", exact: true }).click();
  const sourceTree = scene.getByRole("navigation", { name: "原始模型结构树" });
  const sourceRoot = sourceTree.getByRole("button", { name: "Root", exact: true });
  await sourceRoot.waitFor();
  await scene.getByText("属性 · URDF 配置").waitFor();
  await scene.getByText("原始 CAD 坐标（搭建参照）", { exact: true }).click();
  await scene.getByText("base_link（原始模型虚拟根）").waitFor();
  assert.equal(
    await sourceTree.getByRole("button", { name: "joint_Root", exact: true }).count(),
    0,
  );
  await sourceTree.getByRole("button", { name: "收起 Root", exact: true }).click();
  assert.equal(
    await sourceTree.getByRole("button", { name: "SubInstance", exact: true }).count(),
    0,
  );
  await sourceTree.getByRole("button", { name: "展开 Root", exact: true }).click();
  await sourceTree.getByRole("button", { name: "SubInstance", exact: true }).click();
  await scene.locator(".scene-transform").first().getByText("Root", { exact: true }).waitFor();
  assert.equal(await scene.locator(".scene-source-property-name").textContent(), "SubInstance");
  assert.equal(await scene.getByLabel("连杆名称", { exact: true }).count(), 0);
  await scene.getByRole("button", { name: "构建场景", exact: true }).click();
  const transparency = scene.getByRole("slider", { name: "所选对象透明度" });
  assert.equal(await transparency.inputValue(), "0");
  assert.ok(await transparency.isDisabled()); // Empty base_link has no geometry to fade.
  await scene.getByRole("button", { name: "原始模型", exact: true }).click();
  assert.equal(await transparency.inputValue(), "0");
  await transparency.fill("45");
  await transparency.dispatchEvent("pointerup");
  await page.waitForFunction(async () => {
    const project = (await window.desktop.application.getWorkspace()).projects.find(
      (project) => project.mode === "scene",
    );
    return (
      project &&
      (await window.desktop.application.getScene(project.id)).document.transparencies?.some(
        (setting) => setting.value === 45,
      )
    );
  });
  await sourceRoot.click();
  await scene.getByText("所选透明度 混合", { exact: true }).waitFor();
  await scene.getByRole("button", { name: "构建场景", exact: true }).click();
  assert.equal(await transparency.inputValue(), "0");
  assert.equal(await scene.getByText(/原始模型参照/).count(), 0);
  const tree = scene.getByRole("navigation", { name: "机器人结构树" });
  assert.equal(await tree.getByText("1 个连杆").count(), 1);
  assert.equal(await tree.getByRole("button", { name: "Root", exact: true }).count(), 0);
  const linkName = scene.getByRole("textbox", { name: "连杆名称", exact: true });
  await linkName.fill("原装配未保存的名称");

  expectedImportRevision = await page.evaluate(async () => {
    const api = window.desktop.application;
    const project = (await api.getWorkspace()).projects.find((project) => project.mode === "scene");
    if (!project) throw new Error("缺少场景项目");
    return (await api.getScene(project.id)).document.revision;
  });
  if (await page.getByRole("tab", { name: "聊天", exact: true }).isVisible())
    await page.getByRole("tab", { name: "聊天", exact: true }).click();
  await page.getByRole("button", { name: "新建对话", exact: true }).last().click();
  await page.getByRole("textbox", { name: "消息内容", exact: true }).waitFor();
  await page.evaluate(() => {
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.id = "drop-source";
    fileInput.hidden = true;
    document.body.append(fileInput);
  });
  const source = page.locator("#drop-source");
  await source.setInputFiles(replacement);
  await source.evaluate((input: HTMLInputElement) => {
    const file = input.files?.[0];
    const target = document.querySelector(".composer");
    if (!file || !target) throw new Error("缺少测试拖拽文件或聊天输入区。");
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }));
    input.remove();
  });
  await page
    .getByRole("button", { name: "移除 STEP 附件 replacement.step", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await page.locator(".message.user .file-attachment").getByText("replacement.step").waitFor();
  if (await mobileTab.isVisible()) await mobileTab.click();
  await scene.getByText("replacement", { exact: true }).waitFor();
  assert.equal(await linkName.inputValue(), "base_link");
  await scene.getByRole("button", { name: "导出 URDF", exact: true }).click();
  const status = scene.getByText(/^已导出至 /);
  await status.waitFor();
  const output = (await status.textContent())?.replace(/^已导出至 /, "");
  assert.ok(output);
  const urdf = await readFile(output, "utf8");
  assert.doesNotMatch(urdf, /<mesh|<joint/);
  assert.match(urdf, /<link name="base_link"/);
  assert.match(urdf, /<robot name="replacement">/);

  await scene.getByRole("button", { name: "构建场景", exact: true }).click();
  await linkName.fill("替换装配未保存的名称");
  await scene.getByRole("button", { name: "撤销", exact: true }).click();
  await scene.getByText("assembly", { exact: true }).waitFor();
  assert.equal(await linkName.inputValue(), "base_link");

  const chatTab = page.getByRole("tab", { name: "聊天", exact: true });
  if (await chatTab.isVisible()) await chatTab.click();
  const draftChooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "添加附件", exact: true }).click();
  await (await draftChooser).setFiles(step);
  const draft = page.getByRole("button", { name: "移除 STEP 附件 assembly.stp", exact: true });
  await draft.waitFor();
  await page.getByRole("button", { name: "返回项目主页", exact: true }).click();
  await projectCard.waitFor();
  await page
    .getByRole("complementary", { name: "项目侧栏" })
    .getByRole("button", { name: "replacement.step", exact: true })
    .click();
  await draft.click();
  await draft.waitFor({ state: "hidden" });
});
