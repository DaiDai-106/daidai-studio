import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { _electron as electron } from "playwright";

const executable = process.argv[2];
if (!executable) throw new Error("请提供已打包 Dai 可执行文件的路径。");
const program = resolve(executable);
const root = await mkdtemp(join(tmpdir(), "dai-package-smoke-"));
const profile = join(root, "profile");
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
const python = process.env.DAI_SCENE_TEST_PYTHON;
const launch = () =>
  electron.launch({
    executablePath: program,
    args: [`--user-data-dir=${profile}`],
    env: environment,
    chromiumSandbox: true,
  });
let application;
try {
  // 打包资源必须是可供 Python 直接访问的真实文件，而非 asar 内路径。
  for (const name of [
    "worker.py",
    "geometry.py",
    "gltf.py",
    "distance.py",
    "install.py",
    "requirements.txt",
  ])
    await access(join(dirname(program), "resources", "scene", "python", name));
  await access(join(dirname(program), "resources", "scene", "skills", "scene", "SKILL.md"));
  if (python) {
    await mkdir(join(profile, "data", "python"), { recursive: true });
    await symlink(
      dirname(dirname(python)),
      join(profile, "data", "python", "scene"),
      process.platform === "win32" ? "junction" : "dir",
    );
  }
  application = await launch();
  let page = await application.firstWindow();
  page.setDefaultTimeout(30_000);
  await page.getByRole("button", { name: "打开设置", exact: true }).waitFor();
  const workspace = await page.evaluate(() => window.desktop.application.getWorkspace());
  assert.equal(workspace.dataRoot, join(profile, "data"));
  assert.deepEqual(workspace.projects, []);
  if (python) {
    const project = join(root, "project");
    const source = join(root, "outside.step");
    await mkdir(project);
    await promisify(execFile)(python, [
      "-c",
      "import sys;sys.path.insert(0,sys.argv[1]);from assembly_fixture import write_assembly;write_assembly(sys.argv[2],True,True)",
      fileURLToPath(new URL("../python", import.meta.url)),
      source,
    ]);
    const hash = async () =>
      createHash("sha256")
        .update(await readFile(source))
        .digest("hex");
    const original = await hash();
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
    const form = page.getByRole("dialog", { name: "新建项目" });
    await form.getByLabel("项目名称").fill("打包场景测试");
    await form.getByLabel("项目模式").click();
    await page.getByRole("menuitemradio", { name: "场景搭建" }).click();
    await form.getByRole("button", { name: "选择文件夹", exact: true }).click();
    await form.getByRole("button", { name: "创建项目", exact: true }).click();
    await page
      .getByRole("region", { name: "场景工作区" })
      .getByRole("button", { name: "添加 STEP", exact: true })
      .click();
    await page.locator('[data-scene-loaded="true"]').waitFor({ timeout: 60_000 });
    assert.equal(await hash(), original);
    await application.close();
    application = await launch();
    page = await application.firstWindow();
    await page.getByRole("button", { name: "打包场景测试", exact: true }).click();
    await page.locator('[data-scene-loaded="true"]').waitFor({ timeout: 60_000 });
    assert.equal(await hash(), original);
    console.log("打包版真实 STEP 导入和重启恢复通过。");
  }
  console.log("打包版启动、数据隔离和场景资源检查通过。");
} finally {
  if (application) await application.close();
  await rm(root, { recursive: true, force: true });
}
