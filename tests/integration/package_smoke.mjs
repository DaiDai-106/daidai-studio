import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "playwright";
import packageInfo from "../../package.json" with { type: "json" };

const executable = process.argv[2];
if (!executable) throw new Error("请提供已打包应用的可执行文件路径。");
const program = resolve(executable);
const root = await mkdtemp(join(tmpdir(), "dai-package-smoke-"));
const profile = join(root, "profile");
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
const launch = () =>
  electron.launch({
    executablePath: program,
    args: [`--user-data-dir=${profile}`],
    env: environment,
    chromiumSandbox: true,
  });
let application;
try {
  application = await launch();
  const page = await application.firstWindow();
  page.setDefaultTimeout(30_000);
  await page.getByRole("button", { name: "打开设置", exact: true }).waitFor();
  const info = await page.evaluate(() => window.desktop.getAppInfo());
  assert.equal(info.name, packageInfo.productName);
  assert.equal(info.version, packageInfo.version);
  const workspace = await page.evaluate(() => window.desktop.application.getWorkspace());
  assert.equal(workspace.dataRoot, await realpath(join(profile, "data")));
  assert.deepEqual(workspace.projects, []);
  console.log("打包版启动和数据隔离检查通过。");
} finally {
  if (application) await application.close();
  await rm(root, { recursive: true, force: true });
}
