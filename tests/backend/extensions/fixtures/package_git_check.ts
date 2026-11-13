import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { createPackageService } from "../../../../src/backend/extensions/package_service.ts";

const root = process.argv[2];
if (!root) throw new Error("missing fixture root");
const git = promisify(execFile);
const workspace = join(root, "user-workspace");
const checkout = join(root, "source-working");
const bare = join(root, "git", "example", "fixture.git");
const dataRoot = join(root, "data");
const source = "git:https://example.invalid/example/fixture.git";
await mkdir(workspace, { recursive: true });
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
const a = createPackageService({ dataRoot, projectId: "project-a", cwd: workspace });
const b = createPackageService({ dataRoot, projectId: "project-b", cwd: workspace });
async function extensionText(service: typeof a) {
  const extension = (await service.resolve()).extensions[0];
  assert.ok(extension);
  return readFile(extension.path, "utf8");
}
try {
  await a.install(source, "project");
  assert.equal((await a.list()).length, 1);
  assert.deepEqual(await b.list(), []);
  const initial = await a.resolve();
  assert.equal(initial.extensions.length, 1);
  assert.match(await extensionText(a), /version-1/);
  await commit(2);
  await a.update(source);
  assert.match(await extensionText(a), /version-2/);
  await a.install(source, "user");
  assert.equal((await b.list()).length, 1);
  assert.equal((await b.list())[0]?.scope, "user");
  await commit(3);
  await b.update(source);
  assert.match(await extensionText(b), /version-3/);
  assert.match(await extensionText(a), /version-2/);
  const beforeFailedUpdate = await b.list();
  await rename(bare, `${bare}.unavailable`);
  try {
    await assert.rejects(b.update(source));
    assert.deepEqual(await b.list(), beforeFailedUpdate);
    assert.match(await extensionText(b), /version-3/);
  } finally {
    await rename(`${bare}.unavailable`, bare);
  }
  const before = await a.list();
  await assert.rejects(a.install("git:https://example.invalid/example/missing.git", "project"));
  // Pi 将 git:file:// 判为本地路径，当前版本不接受它作为 Git clone 源。
  await assert.rejects(
    a.install(`git:${pathToFileURL(bare).href}`, "project"),
    /Path does not exist/,
  );
  assert.deepEqual(await a.list(), before);
  await assert.rejects(stat(join(workspace, ".pi")), { code: "ENOENT" });
  await writeFile(join(root, "git-case-passed"), "verified");
} finally {
  await Promise.all([a.dispose(), b.dispose()]);
}
