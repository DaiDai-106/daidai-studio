import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, copyFile, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { _electron as electron } from "playwright";
import packageInfo from "../../package.json" with { type: "json" };

const executable = process.argv[2];
if (!executable) throw new Error("请提供已打包应用的可执行文件路径。");
const install = process.argv[3] === "--install";
if (install && process.platform !== "win32") throw new Error("--install 需要 Windows 安装包。");
const root = await mkdtemp(join(tmpdir(), "dai-package-smoke-"));
const installDir = join(root, packageInfo.productName);
const program = install ? join(installDir, `${packageInfo.productName}.exe`) : resolve(executable);
const profile = join(root, "profile");
const temp = join(root, "解析临时目录");
const environment = { ...process.env, TMPDIR: temp, TMP: temp, TEMP: temp };
delete environment.ELECTRON_RUN_AS_NODE;
delete environment.LD_LIBRARY_PATH;
delete environment.DYLD_LIBRARY_PATH;
delete environment.DYLD_FALLBACK_LIBRARY_PATH;
const launch = () =>
  electron.launch({
    executablePath: program,
    args: [`--user-data-dir=${profile}`],
    env: environment,
    chromiumSandbox: true,
  });
let application;
try {
  if (install) {
    // NSIS expects /D last, with the directory unquoted even if it contains spaces.
    await promisify(execFile)(resolve(executable), ["/S", `/D=${installDir}`], {
      windowsVerbatimArguments: true,
      timeout: 120_000,
    });
    const worker = join(installDir, "resources", "modules", "scene", "runtime");
    for (const file of [
      "cad-import.exe",
      "TKDESTEP.dll",
      "msvcp140.dll",
      "vcruntime140.dll",
      "vcruntime140_1.dll",
    ]) {
      await access(join(worker, file));
    }
  }
  await mkdir(temp);
  application = await launch();
  const page = await application.firstWindow();
  page.setDefaultTimeout(30_000);
  await page.getByRole("button", { name: "打开设置", exact: true }).waitFor();
  const info = await page.evaluate(() => window.desktop.getAppInfo());
  assert.equal(info.name, packageInfo.productName);
  assert.equal(info.version, packageInfo.version);
  const resources = await application.evaluate(() => process.resourcesPath);
  const licenses = join(resources, "modules", "scene", "runtime", "licenses");
  for (const file of [
    "README.md",
    "LICENSE_LGPL_21.txt",
    "OCCT_LGPL_EXCEPTION.txt",
    "LICENSE.MIT",
  ]) {
    await access(join(licenses, file));
  }
  const workspace = await page.evaluate(() => window.desktop.application.getWorkspace());
  assert.equal(workspace.dataRoot, await realpath(join(profile, "data")));
  assert.deepEqual(workspace.projects, []);
  const step = join(root, "装配.step");
  await copyFile(new URL("../fixtures/scene/assembly-mm.step", import.meta.url), step);
  await application.evaluate(
    ({ app, dialog }, paths) => {
      app.setPath("documents", paths.root);
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [paths.step] });
    },
    { root, step },
  );
  const scene = await page.evaluate(async () => {
    const api = window.desktop.application;
    const project = await api.createProject({ name: "STEP 装配", mode: "scene" });
    return project && api.importScene(project.id, 0, "step");
  });
  assert.equal(scene?.document.robot?.links.length, 1);
  assert.equal(scene.document.robot.joints.length, 0);
  assert.ok(
    scene.document.sourceRobot.links.some((link) => link.visuals[0]?.geometry.type === "mesh"),
  );
  assert.equal(scene.document.sourceRobot.joints[1]?.origin.xyz[2], 0.08);
  console.log("打包版启动、数据隔离和 STEP 导入检查通过。");
} finally {
  if (application) await application.close();
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
}
