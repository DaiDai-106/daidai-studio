import { strict as assert } from "node:assert";
import fs, {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openApplication } from "../../../src/backend/application.ts";
import { ensureSceneDirectory } from "../../../src/backend/projects/scenePaths.ts";

test("创建场景目录时替换父目录不能在数据根外创建目录", {
  skip: process.platform !== "linux",
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "dai-scene-directory-"));
  const data = join(root, "data");
  const projects = join(data, "projects");
  const outside = join(root, "outside");
  const projectId = "12345678-1234-1234-1234-123456789abc";
  mkdirSync(projects, { recursive: true });
  mkdirSync(outside);
  const originalMkdir = fs.promises.mkdir;
  let intercepted = false;
  try {
    fs.promises.mkdir = (async (path, options) => {
      if (!intercepted && String(path).endsWith(`/${projectId}`)) {
        intercepted = true;
        renameSync(projects, `${projects}-held`);
        symlinkSync(outside, projects, "dir");
      }
      return originalMkdir(path, options);
    }) as typeof originalMkdir;
    syncBuiltinESMExports();
    await assert.rejects(ensureSceneDirectory(data, projectId), /目录.*变化|目录.*链接/);
    assert.equal(intercepted, true);
    assert.equal(existsSync(join(outside, projectId)), false);
  } finally {
    fs.promises.mkdir = originalMkdir;
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  }
});

test("独立后端首次创建数据根时父目录替换不会写入外部", {
  skip: process.platform !== "linux",
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "dai-initial-root-"));
  const parent = join(root, "parent");
  const data = join(parent, "data");
  const outside = join(root, "outside");
  mkdirSync(parent);
  mkdirSync(outside);
  const originalMkdir = fs.promises.mkdir;
  let intercepted = false;
  try {
    fs.promises.mkdir = (async (path, options) => {
      if (!intercepted && String(path).endsWith("/data")) {
        intercepted = true;
        renameSync(parent, `${parent}-held`);
        symlinkSync(outside, parent, "dir");
      }
      return originalMkdir(path, options);
    }) as typeof originalMkdir;
    syncBuiltinESMExports();
    await assert.rejects(
      openApplication({
        dataRoot: data,

        publish() {},
      }),
      /根目录.*变化/,
    );
    assert.equal(intercepted, true);
    assert.equal(existsSync(join(outside, "data")), false);
  } finally {
    fs.promises.mkdir = originalMkdir;
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  }
});

test("数据根祖先被替换后不能在外部创建目录", { skip: process.platform !== "linux" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "dai-root-directory-"));
  const parent = join(root, "parent");
  const data = join(parent, "data");
  const outside = join(root, "outside");
  const projectId = "12345678-1234-1234-1234-123456789abc";
  mkdirSync(data, { recursive: true });
  mkdirSync(join(outside, "data"), { recursive: true });
  const original = fs.promises.realpath;
  let intercepted = false;
  try {
    fs.promises.realpath = (async (path) => {
      const result = await original(path);
      if (String(path) === data && !intercepted) {
        intercepted = true;
        renameSync(parent, `${parent}-held`);
        symlinkSync(outside, parent, "dir");
      }
      return result;
    }) as typeof original;
    syncBuiltinESMExports();
    await assert.rejects(ensureSceneDirectory(data, projectId));
    assert.equal(intercepted, true);
    assert.equal(existsSync(join(outside, "data", "projects", projectId)), false);
  } finally {
    fs.promises.realpath = original;
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  }
});

test("已固定的数据根符号链接切换后拒绝新位置", { skip: process.platform !== "linux" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "dai-root-identity-"));
  const first = join(root, "first");
  const second = join(root, "second");
  const alias = join(root, "data");
  const projectId = "12345678-1234-1234-1234-123456789abc";
  mkdirSync(first);
  mkdirSync(second);
  symlinkSync(first, alias, "dir");
  const info = statSync(first, { bigint: true });
  const expectedRoot = { dev: info.dev.toString(), ino: info.ino.toString() };
  try {
    rmSync(alias);
    symlinkSync(second, alias, "dir");
    await assert.rejects(ensureSceneDirectory(alias, projectId, expectedRoot), /身份已变化/);
    assert.equal(existsSync(join(second, "projects")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
