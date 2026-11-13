import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { _electron as electron } from "playwright";

test("Electron 启动后数据根链接被切换，后端导入拒绝且不向新目录写入", {
  skip: process.platform !== "linux" ? "需要 Linux 目录句柄" : false,
  timeout: 60_000,
}, async () => {
  const base = await mkdtemp(join(tmpdir(), "dai-desktop-root-swap-"));
  const profile = join(base, "profile");
  const root = join(base, "actual");
  const outside = join(base, "outside");
  const projectDir = join(base, "project");
  const alias = join(profile, "data");
  const source = join(base, "sample.step");
  await Promise.all([mkdir(profile), mkdir(root), mkdir(outside), mkdir(projectDir)]);
  await symlink(root, alias, "dir");
  await writeFile(source, "sample STEP");
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[0] !== "ELECTRON_RUN_AS_NODE" && entry[1] !== undefined,
    ),
  );
  const app = await electron.launch({
    args: [process.cwd(), `--user-data-dir=${profile}`],
    env,
    chromiumSandbox: true,
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(
      ({ dialog }, paths) => {
        const selected = [paths.projectDir, paths.source];
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [selected.shift() ?? ""],
        });
      },
      { projectDir, source },
    );
    const project = await page.evaluate(async () => {
      const selection = await window.desktop.application.chooseProjectDirectory();
      if (!selection) throw new Error("测试未选择项目目录。");
      return window.desktop.application.createProject({
        name: "scene",
        mode: "scene",
        directoryToken: selection.token,
      });
    });
    assert.ok(project);
    const scene = await page.evaluate(
      (id) => window.desktop.application.getProjectScene(id),
      project.id,
    );
    await unlink(alias);
    await symlink(outside, alias, "dir");
    const failure = await page.evaluate(
      async ({ projectId, revision }) => {
        try {
          await window.desktop.application.importStep({
            projectId,
            revision,
            operation: "replace",
          });
          return "";
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      },
      { projectId: project.id, revision: scene.revision },
    );
    assert.match(failure, /身份|根目录/);
    assert.deepEqual(await readdir(outside), []);
    assert.equal(
      (await page.evaluate((id) => window.desktop.application.getProjectScene(id), project.id))
        .revision,
      0,
    );
  } finally {
    await app.close();
    await rm(base, { recursive: true, force: true });
  }
});
