import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createPackageService } from "../../../../src/backend/extensions/packageService.ts";

const root = process.argv[2];
const registry = process.argv[3];
if (!root || !registry) throw new Error("missing fixture options");
const workspace = join(root, "user-workspace");
await mkdir(workspace);
const dataRoot = join(root, "data");
const source = "npm:dai-offline-fixture";
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
  assert.match(await extensionText(a), /version-1/);
  await b.install(source, "user");
  assert.equal((await b.list())[0]?.scope, "user");
  assert.match(await extensionText(b), /version-1/);
  const response = await fetch(`${registry}/switch-2`);
  assert.equal(response.status, 204);
  await b.update(source);
  assert.match(await extensionText(b), /version-2/, "global npm update must fetch the new version");
  assert.match(
    await extensionText(a),
    /version-1/,
    "updating global scope must not modify project copy",
  );
  await a.update(source);
  assert.match(
    await extensionText(a),
    /version-2/,
    "project npm package must update when selected",
  );
  const beforeFailedUpdate = await b.list();
  assert.equal((await fetch(`${registry}/make-unavailable`)).status, 204);
  await assert.rejects(b.update(source));
  assert.deepEqual(await b.list(), beforeFailedUpdate);
  assert.match(await extensionText(b), /version-2/);
  const before = await a.list();
  await assert.rejects(a.install("npm:dai-fixture-missing", "project"));
  assert.deepEqual(await a.list(), before);
  await assert.rejects(stat(join(workspace, ".pi")), { code: "ENOENT" });
  await writeFile(join(root, "npm-case-passed"), "verified");
} finally {
  await Promise.all([a.dispose(), b.dispose()]);
}
