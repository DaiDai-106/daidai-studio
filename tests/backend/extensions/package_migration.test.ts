import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { openApplication } from "../../../src/backend/application.ts";
import {
  createPackageService,
  relocateModulePackages,
} from "../../../src/backend/extensions/package_service.ts";

test("启动迁移模块 npm/Git 内容，保留本地来源、过滤器和停用状态", async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-module-migration-"));
  const dataRoot = join(root, "data");
  const moduleRoot = join(dataRoot, "agent/packages/modules/coding");
  const previous = join(moduleRoot, "workspace/.pi");
  const target = join(moduleRoot, ".pi");
  const localA = join(root, "local-a");
  const localB = join(root, "local-b");
  const configPath = join(moduleRoot, "settings.json");
  let app: Awaited<ReturnType<typeof openApplication>> | undefined;
  try {
    for (const [name, path] of [
      ["fixture", join(previous, "npm/node_modules/fixture")],
      ["local-a", localA],
      ["local-b", localB],
    ] as const) {
      await mkdir(path, { recursive: true });
      await writeFile(
        join(path, "package.json"),
        JSON.stringify({ name, version: "1.0.0", pi: { extensions: ["index.ts"] } }),
      );
      await writeFile(join(path, "index.ts"), "export default () => {};\n");
    }
    await mkdir(join(previous, "git/example.com/team/repo"), { recursive: true });
    await writeFile(join(previous, "git/example.com/team/repo/marker"), "git content");
    await writeFile(
      configPath,
      JSON.stringify({
        packages: [
          "npm:fixture@1.0.0",
          relative(previous, localA),
          { source: relative(previous, localB), extensions: ["index.ts"] },
        ],
        retained: "custom setting",
      }),
    );
    await writeFile(
      join(dataRoot, "agent/packages/disabled.json"),
      JSON.stringify([JSON.stringify(["module", "coding", localA])]),
    );
    app = await openApplication({ dataRoot, publish() {} });
    assert.equal(
      await readFile(join(target, "git/example.com/team/repo/marker"), "utf8"),
      "git content",
    );
    await assert.rejects(stat(join(moduleRoot, "workspace")), { code: "ENOENT" });
    const config = JSON.parse(await readFile(configPath, "utf8"));
    assert.deepEqual(config.packages, [
      "npm:fixture@1.0.0",
      localA,
      { source: localB, extensions: ["index.ts"] },
    ]);
    assert.equal(config.retained, "custom setting");
    const packages = await app.request("package.list", { moduleId: "coding" });
    assert.equal(packages.length, 3);
    assert.equal(packages.find((item) => item.source === localA)?.enabled, false);
    assert.ok(packages.every((item) => item.scope === "module" && !item.manifestError));
    const resources = await createPackageService({ dataRoot }).resolve();
    assert.equal(resources.extensions.length, 2);
    assert.ok(resources.extensions.some((item) => item.path.startsWith(target)));
    const text = await readFile(configPath, "utf8");
    relocateModulePackages(dataRoot);
    assert.equal(await readFile(configPath, "utf8"), text, "重复启动不改写已经迁移的配置");
  } finally {
    await app?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("新旧模块安装目录冲突或配置损坏时不覆盖内容", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "dai-module-conflict-"));
  const root = join(dataRoot, "agent/packages/modules/coding");
  const previous = join(root, "workspace/.pi");
  const target = join(root, ".pi");
  try {
    await mkdir(previous, { recursive: true });
    await mkdir(target);
    await writeFile(join(previous, "marker"), "old");
    await writeFile(join(target, "marker"), "new");
    await writeFile(join(root, "settings.json"), "{");
    assert.throws(() => relocateModulePackages(dataRoot), /同时存在/);
    assert.equal(await readFile(join(previous, "marker"), "utf8"), "old");
    assert.equal(await readFile(join(target, "marker"), "utf8"), "new");
    await rm(target, { recursive: true });
    assert.throws(() => relocateModulePackages(dataRoot), SyntaxError);
    assert.equal(await readFile(join(previous, "marker"), "utf8"), "old");
    assert.equal(await readFile(join(root, "settings.json"), "utf8"), "{");
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("仅清理空 workspace，其他文件与 Desktop 安装目录保持原样", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "dai-module-container-"));
  const root = join(dataRoot, "agent/packages/modules/coding");
  const other = join(root, "workspace/keep.txt");
  const desktop = join(dataRoot, "desktop/packages/modules/coding/workspace/.pi");
  try {
    await mkdir(join(root, "workspace/.pi"), { recursive: true });
    await writeFile(other, "retained");
    await mkdir(desktop, { recursive: true });
    relocateModulePackages(dataRoot);
    assert.equal(await readFile(other, "utf8"), "retained");
    await rm(other);
    relocateModulePackages(dataRoot);
    await assert.rejects(stat(join(root, "workspace")), { code: "ENOENT" });
    await writeFile(join(desktop, "marker"), "desktop");
    assert.equal(await readFile(join(desktop, "marker"), "utf8"), "desktop");
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});
