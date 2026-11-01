import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { _electron as electron } from "playwright";
import { openProjectStore } from "../../src/backend/projects/store.ts";

test("scene project loads on selection and keeps conversations independent after restart", {
  timeout: 60_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "dai-project-ui-"));
  const profile = join(directory, "profile");
  const project = join(directory, "project");
  await mkdir(project);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[0] !== "ELECTRON_RUN_AS_NODE" && entry[1] !== undefined,
    ),
  );
  const launch = () =>
    electron.launch({
      args: [process.cwd(), `--user-data-dir=${profile}`],
      env,
      chromiumSandbox: true,
    });
  let application = await launch();
  try {
    let page = await application.firstWindow();
    page.setDefaultTimeout(10000);
    await application.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, project);
    await page.getByRole("button", { name: "新建项目", exact: true }).first().click();
    const dialog = page.getByRole("dialog", { name: "新建项目" });
    await dialog.getByLabel("项目名称").fill("场景测试");
    await dialog.getByLabel("项目模式").click();
    await page.getByRole("menuitemradio", { name: "场景搭建" }).click();
    await dialog.getByRole("button", { name: "选择文件夹", exact: true }).click();
    await dialog.getByRole("button", { name: "创建项目", exact: true }).click();
    await page.getByRole("region", { name: "场景工作区" }).waitFor();
    const pythonSetup = page.getByRole("region", { name: "场景 Python 环境" });
    await pythonSetup.getByRole("button", { name: "安装场景环境" }).waitFor();
    assert.match((await pythonSetup.textContent()) ?? "", /网络.*下载/);
    const workspace = await page.evaluate(() => window.desktop.application.getWorkspace());
    const created = workspace.projects.find((item) => item.name === "场景测试");
    assert.ok(created);
    assert.equal(created.mode, "scene");
    assert.equal(created.path, project);
    assert.equal(workspace.conversations.filter((item) => item.projectId === created.id).length, 0);
    await page.getByRole("button", { name: "新建对话", exact: true }).last().click();
    const input = page.getByRole("textbox", { name: "消息内容" });
    await input.waitFor();
    await input.fill("第一个对话的草稿");
    await page.getByRole("button", { name: "新建对话", exact: true }).first().click();
    await page.waitForFunction(
      async (projectId) =>
        (await window.desktop.application.getWorkspace()).conversations.filter(
          (item) => item.projectId === projectId,
        ).length === 2,
      created.id,
    );
    await page.waitForFunction(
      () =>
        document.querySelector<HTMLTextAreaElement>('textarea[aria-label="消息内容"]')?.value ===
        "",
    );
    assert.equal(await input.inputValue(), "");
    await application.close();

    // 写入最小合法 GLB 场景，验证已有场景时的选择与取消，不依赖 CAD 环境。
    const json = Buffer.from(
      JSON.stringify({
        asset: { version: "2.0" },
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [{ name: "Test" }],
      }),
    );
    const length = Math.ceil(json.length / 4) * 4;
    const glb = Buffer.alloc(20 + length, 0x20);
    glb.write("glTF", 0);
    glb.writeUInt32LE(2, 4);
    glb.writeUInt32LE(glb.length, 8);
    glb.writeUInt32LE(length, 12);
    glb.write("JSON", 16);
    json.copy(glb, 20);
    const hash = createHash("sha256").update(glb).digest("hex");
    const resourceDir = join(profile, "data", "projects", created.id, "scene", "resources");
    await mkdir(resourceDir, { recursive: true });
    const resource = join(resourceDir, `${hash}.glb`);
    const sourcePath = join(directory, "original.step");
    const modelId = createHash("sha256")
      .update(JSON.stringify([sourcePath, hash, 0]))
      .digest("hex");
    await writeFile(resource, glb);
    const store = openProjectStore(join(profile, "data"));
    try {
      store.saveScene(created.id, 0, {
        models: [
          {
            source: { path: sourcePath, sha256: "0".repeat(64) },
            resource: { path: resource, format: "glb", byteLength: glb.length, sha256: hash },
            objects: ["Base", "Arm", "Stale", "Removed"].map((name) => ({
              id: name,
              name,
              parentId: null,
            })),
            warnings: [],
            complete: true,
          },
        ],
        joints: [
          {
            id: "candidate",
            parent: { modelId, objectId: "Base" },
            child: { modelId, objectId: "Arm" },
            type: "fixed",
            evidenceRevision: 1,
            status: "draft",
            validity: "current",
            limits: "unknown",
          },
          {
            id: "stale",
            parent: { modelId, objectId: "Base" },
            child: { modelId, objectId: "Stale" },
            type: "fixed",
            evidenceRevision: 1,
            status: "draft",
            validity: "stale",
            limits: "unknown",
          },
          {
            id: "invalid",
            parent: { modelId, objectId: "Base" },
            child: { modelId, objectId: "Removed" },
            type: "fixed",
            evidenceRevision: 1,
            status: "draft",
            validity: "invalidated",
            limits: "unknown",
          },
        ],
      });
    } finally {
      store.close();
    }
    // 使用阻塞的本地 worker 验证取消，不依赖网络或大型 STEP。
    const marker = join(directory, "worker-started");
    const step = join(directory, "pending.step");
    await writeFile(step, "STEP placeholder");
    if (process.platform !== "win32") {
      const python = join(profile, "data", "python", "scene", "bin", "python");
      await mkdir(join(profile, "data", "python", "scene", "bin"), { recursive: true });
      await writeFile(
        python,
        `#!/usr/bin/env node\nif (process.argv[2] === '-c') process.exit(0);\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started');\nprocess.stdin.resume();\nsetInterval(() => {}, 1000);\n`,
        { mode: 0o755 },
      );
    }

    application = await launch();
    page = await application.firstWindow();
    page.setDefaultTimeout(10000);
    const projectButton = page.getByRole("button", { name: "场景测试", exact: true });
    await projectButton.waitFor();
    assert.equal(await page.getByRole("region", { name: "场景工作区" }).count(), 0);
    await projectButton.click();
    await page.getByRole("region", { name: "场景工作区" }).waitFor();
    const restored = await page.evaluate(() => window.desktop.application.getWorkspace());
    const conversations = restored.conversations.filter((item) => item.projectId === created.id);
    assert.equal(conversations.length, 2);
    const draftIndex = conversations.findIndex((item) => item.draft === "第一个对话的草稿");
    assert.ok(draftIndex >= 0);
    await page.locator(".conversation-title").nth(draftIndex).click();
    await page.getByRole("textbox", { name: "消息内容" }).waitFor();
    assert.equal(
      await page.getByRole("textbox", { name: "消息内容" }).inputValue(),
      "第一个对话的草稿",
    );
    const before = await page.evaluate(
      (projectId) => window.desktop.application.getProjectScene(projectId),
      created.id,
    );
    assert.equal(before.models.length, 1);
    await page.getByRole("button", { name: "添加 STEP 文件" }).click();
    const choice = page.getByRole("dialog", { name: "导入 STEP" });
    await choice.getByRole("button", { name: "添加到场景" }).waitFor();
    await choice.getByRole("button", { name: "取消" }).click();
    const after = await page.evaluate(
      (projectId) => window.desktop.application.getProjectScene(projectId),
      created.id,
    );
    assert.deepEqual(after, before);
    if (process.platform !== "win32") {
      await application.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
      }, step);
      page.once("dialog", (dialog) => void dialog.accept());
      await page
        .getByRole("region", { name: "场景工作区" })
        .getByRole("button", { name: "替换场景" })
        .click();
      const cancel = page.getByRole("button", { name: "取消导入" });
      await cancel.waitFor();
      let started = false;
      for (let attempt = 0; attempt < 100 && !started; attempt++) {
        try {
          await access(marker);
          started = true;
        } catch {
          await delay(50);
        }
      }
      assert.equal(started, true, "The worker must be running before cancellation.");
      await cancel.click();
      await cancel.waitFor({ state: "hidden" });
      const afterCancel = await page.evaluate(
        (id) => window.desktop.application.getProjectScene(id),
        created.id,
      );
      assert.deepEqual(afterCancel, before);
    }
    const joints = page.getByRole("region", { name: "关节候选" });
    await joints
      .getByText(/限位未知/)
      .first()
      .waitFor();
    const candidate = joints.locator(".scene-joint").filter({ hasText: "Base → Arm" });
    assert.equal(
      await joints
        .locator(".scene-joint")
        .filter({ hasText: "Base → Stale" })
        .getByRole("button", { name: "确认候选" })
        .isDisabled(),
      true,
    );
    assert.equal(
      await joints
        .locator(".scene-joint")
        .filter({ hasText: "Base → Removed" })
        .getByRole("button", { name: "确认候选" })
        .isDisabled(),
      true,
    );
    page.once("dialog", (dialog) => void dialog.dismiss());
    await candidate.getByRole("button", { name: "确认候选" }).click();
    assert.equal(
      (await page.evaluate((id) => window.desktop.application.getProjectScene(id), created.id))
        .joints[0]?.status,
      "draft",
    );
    page.once("dialog", (dialog) => void dialog.accept());
    await candidate.getByRole("button", { name: "确认候选" }).click();
    await candidate.getByText(/用户已确认/).waitFor();
    const confirmed = await page.evaluate(
      (id) => window.desktop.application.getProjectScene(id),
      created.id,
    );
    assert.equal(confirmed.joints[0]?.status, "confirmed");
    const stale = joints.locator(".scene-joint").filter({ hasText: "Base → Stale" });
    page.once("dialog", (dialog) => void dialog.accept());
    await stale.getByRole("button", { name: "放弃草稿" }).click();
    await stale.waitFor({ state: "hidden" });
    page.once("dialog", (dialog) => void dialog.dismiss());
    await candidate.getByRole("button", { name: "移除已确认关节" }).click();
    const afterDiscard = await page.evaluate(
      (id) => window.desktop.application.getProjectScene(id),
      created.id,
    );
    assert.equal(
      afterDiscard.joints.some((item) => item.id === "stale"),
      false,
    );
    assert.equal(afterDiscard.joints.find((item) => item.id === "candidate")?.status, "confirmed");
    await page.getByRole("button", { name: "场景测试 项目操作" }).click();
    await page.getByRole("menuitem", { name: /移除项目/ }).click();
    await projectButton.waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "已隐藏项目" }).click();
    const hidden = page.getByRole("dialog", { name: "已隐藏项目" });
    await hidden.getByText("场景测试", { exact: true }).waitFor();
    await hidden.getByRole("button", { name: "恢复", exact: true }).click();
    await projectButton.waitFor();
    await hidden.getByRole("button", { name: "关闭弹窗" }).click();
    await projectButton.click();
    const restoredScene = await page.evaluate(
      (projectId) => window.desktop.application.getProjectScene(projectId),
      created.id,
    );
    assert.deepEqual(restoredScene, afterDiscard);
    if (process.platform !== "win32") {
      await application.close();
      const python = join(profile, "data", "python", "scene", "bin", "python");
      await writeFile(python, "#!/usr/bin/env node\nprocess.exit(1);\n", { mode: 0o755 });
      application = await launch();
      page = await application.firstWindow();
      page.setDefaultTimeout(10000);
      await page.getByRole("button", { name: "场景测试", exact: true }).click();
      const invalid = page.getByRole("region", { name: "场景 Python 环境" });
      await invalid.getByText(/已有环境无法使用且不会被覆盖/).waitFor();
      assert.equal(await invalid.getByRole("button", { name: "重试安装" }).count(), 0);
      await invalid.getByRole("button", { name: "重新检查" }).waitFor();
    }
  } finally {
    if (application.process().exitCode === null) await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});
