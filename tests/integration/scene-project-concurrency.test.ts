import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { _electron as electron, type Page } from "playwright";
import { openProjectStore } from "../../src/backend/projects/store.ts";

const env = Object.fromEntries(
  Object.entries(process.env).filter(
    (entry): entry is [string, string] =>
      entry[0] !== "ELECTRON_RUN_AS_NODE" && entry[1] !== undefined,
  ),
);
const launch = (profile: string) =>
  electron.launch({
    args: [process.cwd(), `--user-data-dir=${profile}`],
    env,
    chromiumSandbox: true,
  });

async function createSceneProject(page: Page, name: string) {
  await page.getByRole("button", { name: "新建项目", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "新建项目" });
  await dialog.getByLabel("项目名称").fill(name);
  await dialog.getByLabel("项目模式").click();
  await page.getByRole("menuitemradio", { name: "场景搭建" }).click();
  await dialog.getByRole("button", { name: "选择文件夹", exact: true }).click();
  await dialog.getByRole("button", { name: "创建项目", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
}

async function waitForFile(path: string) {
  for (let attempt = 0; attempt < 150; attempt++) {
    try {
      await access(path);
      return;
    } catch {
      await delay(50);
    }
  }
  throw new Error(`Worker did not start: ${path}`);
}

test("imports and cancellation are isolated across scene projects", {
  timeout: 60_000,
  skip:
    process.platform === "win32" ? "Blocking-worker fixture requires a POSIX executable." : false,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-concurrent-scene-ui-"));
  const profile = join(root, "profile");
  const a = join(root, "a");
  const b = join(root, "b");
  const step = join(root, "external.step");
  const marker = join(root, "worker");
  const python = join(profile, "data", "python", "scene", "bin", "python");
  await Promise.all([
    mkdir(a),
    mkdir(b),
    mkdir(join(profile, "data", "python", "scene", "bin"), { recursive: true }),
    writeFile(step, "STEP placeholder"),
  ]);
  await writeFile(
    python,
    `#!/usr/bin/env node\nif (process.argv[2] === '-c') process.exit(0);\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)} + '-' + process.argv[process.argv.indexOf('--project-id') + 1], 'started');\nprocess.stdin.resume();\nsetInterval(() => {}, 1000);\n`,
    { mode: 0o755 },
  );
  const app = await launch(profile);
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(10000);
    await app.evaluate(
      ({ dialog }, paths) => {
        const selections = [...paths];
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [selections.shift() ?? ""],
        });
      },
      [a, step, b, step],
    );
    await createSceneProject(page, "项目 A");
    const first = (
      await page.evaluate(() => window.desktop.application.getWorkspace())
    ).projects.find((item) => item.name === "项目 A");
    assert.ok(first);
    await page
      .getByRole("region", { name: "场景工作区" })
      .getByRole("button", { name: "添加 STEP" })
      .click();
    await waitForFile(`${marker}-${first.id}`);
    await createSceneProject(page, "项目 B");
    const second = (
      await page.evaluate(() => window.desktop.application.getWorkspace())
    ).projects.find((item) => item.name === "项目 B");
    assert.ok(second);
    const addB = page
      .getByRole("region", { name: "场景工作区" })
      .getByRole("button", { name: "添加 STEP" });
    await addB.waitFor();
    assert.equal(await addB.isEnabled(), true, "A's import must not disable B's scene actions");
    await addB.click();
    await waitForFile(`${marker}-${second.id}`);
    await page.getByRole("button", { name: "项目 A", exact: true }).click();
    const cancel = page.getByRole("button", { name: "取消导入" });
    await cancel.click();
    await cancel.waitFor({ state: "hidden" });
    assert.equal(
      (await page.evaluate((id) => window.desktop.application.getProjectScene(id), first.id))
        .revision,
      0,
    );
    await page.getByRole("button", { name: "项目 B", exact: true }).click();
    await cancel.waitFor();
    await cancel.click();
    await cancel.waitFor({ state: "hidden" });
    assert.equal(
      (await page.evaluate((id) => window.desktop.application.getProjectScene(id), second.id))
        .revision,
      0,
    );
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("scene loading error can be retried without switching projects", {
  timeout: 45_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-scene-retry-ui-"));
  const profile = join(root, "profile");
  const projectPath = join(root, "project");
  const data = join(profile, "data");
  await mkdir(projectPath);
  const store = openProjectStore(data);
  const project = store.createProject({ name: "重试项目", mode: "scene", path: projectPath });
  store.close();
  const db = new DatabaseSync(join(data, "projects.sqlite"));
  db.prepare("INSERT INTO scenes (project_id, revision, document) VALUES (?, 1, ?)").run(
    project.id,
    "invalid json",
  );
  const app = await launch(profile);
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(10000);
    await page.getByRole("button", { name: "重试项目", exact: true }).click();
    const scene = page.getByRole("region", { name: "场景工作区" });
    await scene.getByRole("alert").waitFor();
    db.prepare("UPDATE scenes SET document = ? WHERE project_id = ?").run(
      JSON.stringify({ models: [], joints: [] }),
      project.id,
    );
    await scene.getByRole("button", { name: "重试加载场景" }).click();
    await scene.getByText("场景从这里开始").waitFor();
    assert.equal(await scene.getByRole("button", { name: "添加 STEP" }).isEnabled(), true);
  } finally {
    await app.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
