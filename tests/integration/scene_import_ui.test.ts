import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { _electron as electron } from "playwright";

const python = process.env.DAI_SCENE_TEST_PYTHON;

test("real external STEP displays and project scene restores after restart", {
  timeout: 120_000,
  skip: python ? false : "请设置 DAI_SCENE_TEST_PYTHON 指向已安装场景依赖的 Python。",
}, async () => {
  if (!python) throw new Error("Missing scene test Python");
  const root = await mkdtemp(join(tmpdir(), "dai-real-scene-ui-"));
  const profile = join(root, "profile");
  const project = join(root, "project");
  const source = join(root, "external.step");
  const movedSource = join(root, "moved.step");
  const wrongSource = join(root, "wrong.step");
  await mkdir(project, { recursive: true });
  await mkdir(join(profile, "data", "python"), { recursive: true });
  await symlink(
    dirname(dirname(python)),
    join(profile, "data", "python", "scene"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await promisify(execFile)(
    python,
    [
      "-c",
      'import sys;sys.path.insert(0,"tests/python");from assembly_fixture import write_assembly;write_assembly(sys.argv[1],True,True)',
      source,
    ],
    { cwd: process.cwd() },
  );
  const hash = async () =>
    createHash("sha256")
      .update(await readFile(source))
      .digest("hex");
  const originalHash = await hash();
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
    page.setDefaultTimeout(30000);
    await application.evaluate(
      ({ dialog }, paths) => {
        const selected = [paths.project, paths.source];
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [selected.shift() ?? ""],
        });
      },
      { project, source },
    );
    await page.getByRole("button", { name: "新建项目", exact: true }).first().click();
    const create = page.getByRole("dialog", { name: "新建项目" });
    await create.getByLabel("项目名称").fill("真实场景");
    await create.getByLabel("项目模式").click();
    await page.getByRole("menuitemradio", { name: "场景搭建" }).click();
    await create.getByRole("button", { name: "选择文件夹", exact: true }).click();
    await create.getByRole("button", { name: "创建项目", exact: true }).click();
    const scene = page.getByRole("region", { name: "场景工作区" });
    await scene.getByRole("button", { name: "添加 STEP", exact: true }).click();
    await page.locator('[data-scene-loaded="true"]').waitFor({ timeout: 60000 });
    const workspace = await page.evaluate(() => window.desktop.application.getWorkspace());
    const projectInfo = workspace.projects.find((item) => item.name === "真实场景");
    assert.ok(projectInfo);
    const saved = await page.evaluate(
      (id) => window.desktop.application.getProjectScene(id),
      projectInfo.id,
    );
    assert.equal(saved.models.length, 1);
    assert.equal(saved.models[0]?.sourcePath, source);
    assert.ok(saved.models[0]?.objects.length);
    const resource = saved.models[0]?.resource;
    assert.ok(resource);
    const fetched = await page.evaluate(async (url) => {
      const head = await fetch(url, { method: "HEAD" });
      const body = await fetch(url);
      return {
        headStatus: head.status,
        headLength: head.headers.get("content-length"),
        bodyStatus: body.status,
        bodyLength: (await body.arrayBuffer()).byteLength,
      };
    }, resource.url);
    assert.equal(fetched.headStatus, 200);
    assert.equal(fetched.headLength, String(resource.byteLength));
    assert.equal(fetched.bodyStatus, 200);
    assert.equal(fetched.bodyLength, resource.byteLength);
    assert.equal(await hash(), originalHash);
    await assert.rejects(readFile(join(project, ".dai")));
    if (process.env.DAI_SCENE_TEST_SCREENSHOT)
      await page.screenshot({ path: process.env.DAI_SCENE_TEST_SCREENSHOT });
    await page.getByRole("button", { name: "SubInstance", exact: true }).click();
    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByRole("button", { name: "删除所选对象" }).click();
    await page.waitForFunction(
      async (id) =>
        (await window.desktop.application.getProjectScene(id)).models[0]?.objects.find(
          (object) => object.name === "SubInstance",
        )?.deleted === true,
      projectInfo.id,
    );
    await page
      .getByRole("button", { name: "SubInstance", exact: true })
      .waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "SubInstance2", exact: true }).waitFor();
    const afterDeletion = await page.evaluate(
      (id) => window.desktop.application.getProjectScene(id),
      projectInfo.id,
    );
    await application.close();
    await rename(source, movedSource);
    await writeFile(wrongSource, "different STEP contents");

    application = await launch();
    await application.evaluate(
      ({ dialog }, paths) => {
        const selected = [paths.wrongSource, paths.movedSource];
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [selected.shift() ?? ""],
        });
      },
      { wrongSource, movedSource },
    );
    page = await application.firstWindow();
    page.setDefaultTimeout(30000);
    await page.getByRole("button", { name: "真实场景", exact: true }).click();
    await page.locator('[data-scene-loaded="true"]').waitFor({ timeout: 60000 });
    const restored = await page.evaluate(
      (id) => window.desktop.application.getProjectScene(id),
      projectInfo.id,
    );
    assert.equal(restored.revision, afterDeletion.revision);
    assert.equal(restored.models[0]?.resource.sha256, saved.models[0]?.resource.sha256);
    assert.equal(
      restored.models[0]?.objects.find((object) => object.name === "SubInstance")?.deleted,
      true,
    );
    await page.getByRole("button", { name: "SubInstance2", exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "SubInstance", exact: true }).count(), 0);
    const relocate = page.getByRole("button", { name: "重新定位源 STEP" });
    await relocate.click();
    await page.getByRole("alert").waitFor();
    const afterWrongSource = await page.evaluate(
      (id) => window.desktop.application.getProjectScene(id),
      projectInfo.id,
    );
    assert.equal(afterWrongSource.revision, restored.revision);
    await relocate.click();
    await relocate.waitFor({ state: "hidden" });
    const relocated = await page.evaluate(
      (id) => window.desktop.application.getProjectScene(id),
      projectInfo.id,
    );
    assert.equal(relocated.models[0]?.sourcePath, movedSource);
    assert.equal(relocated.models[0]?.id, restored.models[0]?.id);
    assert.equal(
      relocated.models[0]?.objects.find((object) => object.name === "SubInstance")?.deleted,
      true,
    );
    assert.equal(
      createHash("sha256")
        .update(await readFile(movedSource))
        .digest("hex"),
      originalHash,
    );
  } finally {
    if (application.process().exitCode === null) await application.close();
    await rm(root, { recursive: true, force: true });
  }
});
