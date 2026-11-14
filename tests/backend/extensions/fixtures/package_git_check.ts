import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { createCatalogService } from "../../../../src/backend/extensions/catalog_service.ts";
import { createPackageService } from "../../../../src/backend/extensions/package_service.ts";
import { waitForCatalogTask } from "../../../support/catalog_task.ts";
import { createThemePackage } from "../../../support/desktop_theme.ts";

const root = process.argv[2];
if (!root) throw new Error("missing fixture root");
const git = promisify(execFile);
const checkout = join(root, "source-working");
const bare = join(root, "git", "example", "fixture.git");
const dataRoot = join(root, "data");
const source = "git:https://example.invalid/example/fixture.git";
await mkdir(checkout, { recursive: true });
await mkdir(join(root, "git", "example"), { recursive: true });
await git("git", ["init", "--bare", bare]);
await git("git", ["-C", bare, "symbolic-ref", "HEAD", "refs/heads/main"]);
await git("git", ["-C", checkout, "init", "-b", "main"]);
await mkdir(join(checkout, "extensions"));
await writeFile(
  join(checkout, "extensions", "index.ts"),
  "// version-1\nexport default () => {};\n",
);
async function commit(version: number) {
  await writeFile(
    join(checkout, "extensions", "index.ts"),
    `// version-${version}\nexport default () => {};\n`,
  );
  await git("git", ["-C", checkout, "add", "extensions/index.ts"]);
  await git("git", [
    "-C",
    checkout,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    `fixture-${version}`,
  ]);
  await git("git", ["-C", checkout, "push", bare, "main"]);
}
await commit(1);
const a = createPackageService({ dataRoot, moduleId: "coding" });
const b = createPackageService({ dataRoot, moduleId: "scene" });
async function extensionText(service: typeof a) {
  const extension = (await service.resolve()).extensions[0];
  assert.ok(extension);
  return readFile(extension.path, "utf8");
}
await a.install(source, "module");
assert.equal((await a.inspect()).length, 1);
assert.deepEqual(await b.inspect(), []);
const initial = await a.resolve();
assert.equal(initial.extensions.length, 1);
assert.match(await extensionText(a), /version-1/);
await commit(2);
await a.update(source);
assert.match(await extensionText(a), /version-2/);
await a.install(source, "global");
assert.equal((await b.inspect()).length, 1);
assert.equal((await b.inspect())[0]?.scope, "global");
await commit(3);
await b.update(source);
assert.match(await extensionText(b), /version-3/);
assert.match(await extensionText(a), /version-2/);
const beforeFailedUpdate = await b.inspect();
await rename(bare, `${bare}.unavailable`);
try {
  await assert.rejects(b.update(source));
  assert.deepEqual(await b.inspect(), beforeFailedUpdate);
  assert.match(await extensionText(b), /version-3/);
} finally {
  await rename(`${bare}.unavailable`, bare);
}
const before = await a.inspect();
await assert.rejects(a.install("git:https://example.invalid/example/missing.git", "module"));
// Pi 将 git:file:// 判为本地路径，当前版本不接受它作为 Git clone 源。
await assert.rejects(a.install(`git:${pathToFileURL(bare).href}`, "module"), /Path does not exist/);
assert.deepEqual(await a.inspect(), before);

// 远端纯 Desktop 包按下载后的显式选择宿主，下载后验证实际清单。
await createThemePackage(checkout);
await git("git", ["-C", checkout, "add", "."]);
await commit(4);
let agentLocks = 0;
const desktopData = join(root, "desktop-data");
const missingAgent = join(root, "missing-agent");
await mkdir(missingAgent);
await createPackageService({ dataRoot: desktopData }).install(missingAgent, "global");
await rename(missingAgent, `${missingAgent}.moved`);
const catalog = createCatalogService({
  dataRoot: desktopData,
  publish() {},
  async changed() {
    agentLocks++;
    throw new Error("Agent busy");
  },
});
try {
  const install = catalog.start({ source, host: "desktop", scope: "global", action: "install" });
  assert.equal((await waitForCatalogTask(catalog.taskList, install.id)).state, "completed");
  await commit(5);
  const update = catalog.start({ source, host: "desktop", scope: "global", action: "update" });
  assert.equal((await waitForCatalogTask(catalog.taskList, update.id)).state, "completed");
  assert.equal(agentLocks, 0);
  const manifestPath = join(checkout, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.pi = { extensions: ["extensions/index.ts"] };
  await writeFile(manifestPath, JSON.stringify(manifest));
  await git("git", ["-C", checkout, "add", "package.json"]);
  await commit(6);
  const mixed = catalog.start({ source, host: "desktop", scope: "global", action: "update" });
  const blocked = await waitForCatalogTask(catalog.taskList, mixed.id);
  assert.equal(blocked.state, "failed");
  assert.match(blocked.message, /混合/);
  assert.equal(agentLocks, 0);
  assert.deepEqual(await createPackageService({ dataRoot: desktopData }).resolve(), {
    extensions: [],
    skills: [],
    prompts: [],
    themes: [],
  });
} finally {
  await catalog.close();
}
await writeFile(join(root, "git-case-passed"), "verified");
