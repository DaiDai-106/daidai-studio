import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPackageService } from "../../../src/backend/extensions/package_service.ts";

test("Pi packages are discovered, scoped by project ID, and never write to the workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-package-test-"));
  const dataRoot = join(root, "data");
  const workspace = join(root, "shared-workspace");
  const source = join(root, "sample-package");
  try {
    await mkdir(join(source, "extensions"), { recursive: true });
    await mkdir(join(source, "skills", "sample"), { recursive: true });
    await mkdir(workspace);
    await writeFile(join(source, "package.json"), JSON.stringify({ name: "sample-pi-package" }));
    await writeFile(join(source, "extensions", "index.ts"), "export default () => {};\n");
    await writeFile(
      join(source, "skills", "sample", "SKILL.md"),
      "---\nname: sample\ndescription: sample\n---\nSample.\n",
    );

    const a = createPackageService({ dataRoot, projectId: "project-a", cwd: workspace });
    const b = createPackageService({ dataRoot, projectId: "project-b", cwd: workspace });
    await a.install(source, "project");
    assert.equal((await a.list()).length, 1);
    assert.deepEqual(await b.list(), []);
    assert.equal((await a.resolve()).extensions.length, 1);
    assert.equal((await a.resolve()).skills.length, 1);
    assert.equal((await b.resolve()).extensions.length, 0);
    await assert.rejects(stat(join(workspace, ".pi")), { code: "ENOENT" });

    await a.setEnabled(source, "project", false);
    assert.equal((await a.list())[0]?.enabled, false);
    assert.equal((await a.resolve()).extensions.length, 0);
    const reopened = createPackageService({ dataRoot, projectId: "project-a", cwd: workspace });
    assert.equal((await reopened.list())[0]?.enabled, false);
    await reopened.setEnabled(source, "project", true);
    assert.equal((await reopened.resolve()).extensions.length, 1);
    await reopened.remove(source, "project");
    assert.deepEqual(await reopened.list(), []);
    assert.equal(
      (await readFile(join(source, "package.json"), "utf8")).includes("sample-pi-package"),
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi package service rejects invalid project IDs and project scope without a project", async () => {
  assert.throws(() => createPackageService({ dataRoot: "/tmp/dai-test", projectId: "../other" }));
  const root = await mkdtemp(join(tmpdir(), "dai-package-test-"));
  try {
    const service = createPackageService({ dataRoot: root });
    await assert.rejects(service.install("/missing", "project"), /项目/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent global package changes from different projects are not lost", async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-package-concurrent-"));
  try {
    const aPath = join(root, "package-a");
    const bPath = join(root, "package-b");
    await mkdir(aPath);
    await mkdir(bPath);
    await writeFile(join(aPath, "package.json"), JSON.stringify({ name: "package-a" }));
    await writeFile(join(bPath, "package.json"), JSON.stringify({ name: "package-b" }));
    const dataRoot = join(root, "data");
    const a = createPackageService({ dataRoot, projectId: "a" });
    const b = createPackageService({ dataRoot, projectId: "b" });
    await Promise.all([a.install(aPath, "user"), b.install(bPath, "user")]);
    assert.deepEqual(new Set((await a.list()).map((item) => item.source)), new Set([aPath, bPath]));
    await Promise.all([a.dispose(), b.dispose()]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
