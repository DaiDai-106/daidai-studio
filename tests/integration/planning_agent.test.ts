import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { splitChatAttachment } from "../../src/shared/chat_attachment.ts";
import { servePlanner, turnResults } from "../support/planner.ts";
import { launchTestApp } from "./support.ts";

const supportsPlanning =
  process.platform === "linux" &&
  existsSync("modules/planning/runtime/planning-worker") &&
  ["zip", "unzip"].every((command) => spawnSync(command, ["-v"], { stdio: "ignore" }).status === 0);

function planningRobot(name: string) {
  const arm = "fanuc_m10id_122";
  const joints = [
    ["0 0 0.3035", "0 0 1"],
    ["0.075 0 0.1465", "0 1 0"],
    ["0 0 0.64", "0 -1 0"],
    ["0.261 0 0.195", "-1 0 0"],
    ["0.439 0 0", "0 -1 0"],
    ["0.075 0 0", "-1 0 0"],
  ];
  const geometry = '<geometry><box size="0.04 0.04 0.04"/></geometry>';
  const chain = joints.map(([origin, axis], index) => {
    const parent = index === 0 ? `${arm}_base_link` : `${arm}_link_${index}`;
    const child = `${arm}_link_${index + 1}`;
    const lower = index === 0 ? 0.2 : -2;
    const upper = index === 1 ? -0.3 : 2;
    return `<link name="${child}">
      <visual>${geometry}</visual><collision>${geometry}</collision>
    </link>
    <joint name="${arm}_joint_${index + 1}" type="revolute">
      <parent link="${parent}"/><child link="${child}"/>
      <origin xyz="${origin}"/><axis xyz="${axis}"/>
      <limit lower="${lower}" upper="${upper}" effort="10" velocity="2"/>
    </joint>`;
  });
  return `<robot name="${name}">
    <link name="base_link"/><link name="${arm}_base_link"/><link name="${arm}_base"/>
    <joint name="mount" type="fixed">
      <parent link="base_link"/><child link="${arm}_base_link"/>
    </joint>
    <joint name="base_offset" type="fixed">
      <parent link="${arm}_base_link"/><child link="${arm}_base"/><origin xyz="0 0 0.45"/>
    </joint>
    ${chain.join("\n")}
    <link name="${arm}_tool0"/>
    <joint name="tool_mount" type="fixed">
      <parent link="${arm}_link_6"/><child link="${arm}_tool0"/>
      <origin rpy="0 -1.5707963267949 -3.141592653589793"/>
    </joint>
    <link name="floor_obstacle">
      <collision><geometry><box size="0.4 0.5 0.6"/></geometry></collision>
    </link>
    <joint name="obstacle_mount" type="fixed">
      <parent link="base_link"/><child link="floor_obstacle"/><origin xyz="1 -0.5 0.3"/>
    </joint>
    <robot_type name="${arm}" value="${arm}"/>
  </robot>`;
}

test("规划对话按所选权限执行命令、读写文件并加载场景", {
  skip: !supportsPlanning && "需要 Linux 上的 One Punch worker 和 zip/unzip",
  timeout: 45_000,
}, async (context) => {
  const { application, page, profile } = await launchTestApp(context);
  await page.setViewportSize({ width: 1360, height: 860 });
  const packageName = "robot　package";
  const archiveName = "robot $scene's.zip";
  const packageRoot = join(profile, packageName);
  const archive = join(profile, archiveName);
  const robotName = "planning_zip_fixture";
  const urdf = planningRobot(robotName);
  const outsideFile = join(profile, "权限　校验.txt");
  const otherFile = join(profile, "权限 校验.txt");
  await writeFile(outsideFile, "原始内容");
  await writeFile(otherFile, "另一个文件");
  await mkdir(packageRoot);
  await writeFile(join(packageRoot, "robot.urdf"), urdf);
  execFileSync("zip", ["-qr", archive, packageName], { cwd: profile });

  const planner = await servePlanner((request) => {
    const tools = request.tools?.map((tool) => tool.function.name);
    for (const name of [
      "bash",
      "read",
      "write",
      "edit",
      "codemode",
      "planning_load_scene",
      "planning_get_scene",
    ])
      assert.ok(tools?.includes(name), `缺少规划工具 ${name}`);
    const content: unknown = request.messages.findLast(
      (message) => message.role === "user",
    )?.content;
    const userText =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content.map((part: { text?: string }) => part.text).join("")
          : "";
    const results = turnResults(request);
    if (userText === "检查完全访问" || userText === "检查请求批准") {
      const mode = userText === "检查完全访问" ? "full" : "ask";
      const readId = `${mode}-read`;
      if (!results.has(readId)) return { id: readId, name: "read", args: { path: outsideFile } };
      const readResult = request.messages.find((message) => message.tool_call_id === readId);
      assert.match(readResult?.content ?? "", mode === "full" ? /原始内容/ : /不在项目目录/);
      if (!results.has(`${mode}-file`))
        return {
          id: `${mode}-file`,
          name: "write",
          args: { path: outsideFile, content: mode },
        };
      if (!results.has(`${mode}-shell`))
        return {
          id: `${mode}-shell`,
          name: "bash",
          args: { command: `printf ran > ${mode}-shell.txt` },
        };
      if (!results.has(`${mode}-load`))
        return {
          id: `${mode}-load`,
          name: "planning_load_scene",
          args: { kind: "package", path: packageRoot },
        };
      return { text: `${userText}完成` };
    }
    const { text, zipAttachment } = splitChatAttachment(userText);
    assert.equal(text, "");
    assert.equal(zipAttachment?.name, archiveName);
    assert.equal(zipAttachment.path, archive);
    if (!results.has("unzip")) {
      const archivePath = zipAttachment.path.replaceAll("'", "'\\''");
      return {
        id: "unzip",
        name: "bash",
        args: { command: `unzip -q '${archivePath}' -d scenes` },
      };
    }
    if (!results.has("load"))
      return {
        id: "load",
        name: "planning_load_scene",
        args: { kind: "package", path: `scenes/${packageName}` },
      };
    const loaded = results.read<{ status: string; scene: { robot: string } }>("load");
    assert.equal(loaded.status, "loaded");
    assert.equal(loaded.scene.robot, robotName);
    if (!results.has("get")) return { id: "get", name: "planning_get_scene", args: {} };
    const current = results.read<{ status: string; scene: { robot: string } }>("get");
    assert.equal(current.status, "loaded");
    assert.equal(current.scene.robot, robotName);
    if (!results.has("compose"))
      return {
        id: "compose",
        name: "codemode",
        args: { code: "return JSON.parse(await tools.planning_get_scene({})).scene.robot;" },
      };
    const composed = request.messages.find((message) => message.tool_call_id === "compose");
    assert.match(composed?.content ?? "", /planning_zip_fixture/);
    return { text: "规划场景已加载。" };
  });
  context.after(() => planner.close());
  await application.evaluate(({ app }, directory) => app.setPath("documents", directory), profile);
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
          { id: "workflow-test", name: "Fixture", context: 4096, output: 1024, reasoning: "标准" },
        ],
      }),
    planner.endpoint,
  );
  const project = await page.evaluate(() =>
    window.desktop.application.createProject({ name: "ZIP 场景", mode: "planning" }),
  );
  assert.ok(project);
  await page.getByRole("button", { name: "打开项目 ZIP 场景", exact: true }).click();
  await page.locator(".assistant-navigation").getByRole("button", { name: "新建对话" }).click();
  const accessMode = page.getByRole("button", { name: "访问权限" });
  await accessMode.getByText("请求批准", { exact: true }).waitFor();
  await page.evaluate(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.id = "zip-drop-source";
    input.hidden = true;
    document.body.append(input);
  });
  const source = page.locator("#zip-drop-source");
  await source.setInputFiles(archive);
  await source.evaluate((input: HTMLInputElement) => {
    const file = input.files?.[0];
    const composer = document.querySelector(".composer");
    if (!file || !composer) throw new Error("缺少测试文件或聊天输入区。");
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    composer.dispatchEvent(
      new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }),
    );
    input.remove();
  });
  await page.getByRole("button", { name: `移除 ZIP 附件 ${archiveName}` }).waitFor();
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  const approval = page.getByRole("region", { name: "确认执行命令" });
  await approval
    .getByText(/unzip -q/)
    .waitFor({ timeout: 10_000 })
    .catch((error) => {
      throw planner.failures[0] ?? error;
    });
  await assert.rejects(access(join(project.path, "scenes")), { code: "ENOENT" });
  await approval.getByRole("button", { name: "确认执行" }).click();

  await page.locator(".message.user .file-attachment").getByText(archiveName).waitFor();
  await page
    .getByText("规划场景已加载。", { exact: true })
    .waitFor({ timeout: 15_000 })
    .catch((error) => {
      throw planner.failures[0] ?? error;
    });
  const workspace = page.getByRole("region", { name: "规划工作区" });
  await workspace.getByLabel("机器人 3D 画布", { exact: true }).waitFor();
  await workspace.getByRole("button", { name: "定位原点", exact: true }).click();
  await workspace.getByRole("button", { name: "适应模型", exact: true }).click();
  const getScene = () =>
    page.evaluate((id) => window.desktop.application.getPlanningScene(id), project.id);
  const scene = await getScene();
  assert.equal(scene?.robot.name, robotName);
  assert.equal(scene.status, "loaded");
  assert.equal(scene.robot.joints.find((joint) => joint.limit?.lower === 0.2)?.position, 0);
  assert.equal(scene.robot.joints.find((joint) => joint.limit?.upper === -0.3)?.position, 0);
  assert.ok(scene.robot.links.length > 1);
  const obstacle = scene.robot.links.find((link) => link.name === "floor_obstacle");
  assert.ok(obstacle);
  assert.equal(obstacle.visuals.length, 0);
  assert.deepEqual(
    scene.collisionGeometry.find((entry) => entry.linkId === obstacle.id)?.geometry,
    { type: "box", size: [0.4, 0.5, 0.6] },
  );
  const canvas = await workspace.getByLabel("机器人 3D 画布", { exact: true }).elementHandle();
  const sceneView = workspace.getByRole("button", { name: "场景显示" });
  await sceneView.getByText("视觉模型", { exact: true }).waitFor();
  await sceneView.click();
  await page.getByRole("menuitemradio", { name: "碰撞模型", exact: true }).click();
  await sceneView.getByText("碰撞模型", { exact: true }).waitFor();
  assert.equal(await canvas.evaluate((element) => element.isConnected), true);
  await sceneView.click();
  await page.getByRole("menuitemradio", { name: "视觉模型", exact: true }).click();
  await canvas.dispose();
  assert.equal(
    await readFile(join(project.path, "scenes", packageName, "robot.urdf"), "utf8"),
    urdf,
  );
  await assert.rejects(access(join(project.path, "planning-imports")), { code: "ENOENT" });

  async function selectAccessMode(label: string) {
    await accessMode.click();
    await page.getByRole("menuitemradio", { name: label, exact: true }).click();
    await accessMode.getByText(label, { exact: true }).waitFor();
  }
  const sendText = async (text: string) => {
    await page.getByRole("textbox", { name: "消息内容" }).fill(text);
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
  };
  await selectAccessMode("完全访问");
  await sendText("检查完全访问");
  await page.getByText("检查完全访问完成", { exact: true }).waitFor();
  assert.equal(await approval.count(), 0);
  assert.equal(await readFile(join(project.path, "full-shell.txt"), "utf8"), "ran");
  assert.equal(await readFile(outsideFile, "utf8"), "full");
  assert.equal(await readFile(otherFile, "utf8"), "另一个文件");
  const fullScene = await getScene();
  assert.ok(fullScene);
  assert.notEqual(fullScene.revision, scene.revision);

  await selectAccessMode("请求批准");
  await sendText("检查请求批准");
  await approval.getByText(/printf ran > ask-shell\.txt/).waitFor();
  await assert.rejects(access(join(project.path, "ask-shell.txt")), { code: "ENOENT" });
  await approval.getByRole("button", { name: "拒绝", exact: true }).click();
  await page.getByText("检查请求批准完成", { exact: true }).waitFor();
  await assert.rejects(access(join(project.path, "ask-shell.txt")), { code: "ENOENT" });
  assert.equal(await readFile(outsideFile, "utf8"), "full");
  assert.equal((await getScene())?.revision, fullScene.revision);
  assert.deepEqual(planner.failures, []);

  await application.evaluate(
    ({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    },
    join(project.path, "scenes", packageName, "robot.urdf"),
  );
  const reply = await page.evaluate(
    (id) => window.desktop.application.loadPlanningScene(id, "urdf"),
    project.id,
  );
  assert.equal(reply, null);
  await workspace.getByText("robot.urdf", { exact: true }).waitFor();
});
