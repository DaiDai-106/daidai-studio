import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { App } from "electron";
import { configureDataPaths } from "../../src/desktop/main/paths.ts";

test("desktop app data defaults to ~/.dai and test profiles remain isolated", async () => {
  const home = await mkdtemp(join(tmpdir(), "dai-desktop-paths-"));
  try {
    let selectedProfile = "";
    let selectedLogs = "";
    const app = {
      commandLine: { getSwitchValue: () => "" },
      getPath: () => home,
      setPath: (_key: string, value: string) => {
        selectedProfile = value;
      },
      setAppLogsPath: (value: string) => {
        selectedLogs = value;
      },
    } as unknown as App;
    const normal = configureDataPaths(app);
    assert.equal(normal.root, join(home, ".dai"));
    assert.equal(selectedProfile, join(home, ".dai", "desktop"));
    assert.equal(selectedLogs, join(home, ".dai", "logs"));
    assert.ok((await stat(normal.root)).isDirectory());
    const isolated = configureDataPaths({
      ...app,
      commandLine: { getSwitchValue: () => join(home, "test-profile") },
    } as unknown as App);
    assert.equal(isolated.root, join(home, "test-profile", "data"));
    assert.equal(isolated.profile, join(home, "test-profile"));
    normal.close();
    isolated.close();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Linux 启动创建根目录时祖先被替换，不向外部目录创建文件", {
  skip: process.platform !== "linux",
}, async () => {
  const { mkdirSync, renameSync, symlinkSync } = await import("node:fs");
  const { readdir } = await import("node:fs/promises");
  const base = await mkdtemp(join(tmpdir(), "dai-bootstrap-parent-race-"));
  const home = join(base, "home");
  const outside = join(base, "outside");
  mkdirSync(home);
  mkdirSync(outside);
  const app = {
    commandLine: { getSwitchValue: () => "" },
    getPath: () => home,
    setPath() {},
    setAppLogsPath() {},
  } as unknown as App;
  try {
    assert.throws(() =>
      configureDataPaths(app, {
        beforeMkdir(name) {
          if (name !== ".dai") return;
          renameSync(home, `${home}-original`);
          symlinkSync(outside, home, "dir");
        },
      }),
    );
    assert.deepEqual(await readdir(outside), []);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("Linux 创建日志目录时根目录被替换，不向外部目录创建文件", {
  skip: process.platform !== "linux",
}, async () => {
  const { mkdirSync, renameSync, symlinkSync } = await import("node:fs");
  const { readdir } = await import("node:fs/promises");
  const base = await mkdtemp(join(tmpdir(), "dai-bootstrap-root-race-"));
  const home = join(base, "home");
  const root = join(home, ".dai");
  const outside = join(base, "outside");
  mkdirSync(root, { recursive: true });
  mkdirSync(outside);
  const app = {
    commandLine: { getSwitchValue: () => "" },
    getPath: () => home,
    setPath() {},
    setAppLogsPath() {},
  } as unknown as App;
  try {
    assert.throws(
      () =>
        configureDataPaths(app, {
          beforeMkdir(name) {
            if (name !== "logs") return;
            renameSync(root, `${root}-original`);
            symlinkSync(outside, root, "dir");
          },
        }),
      /发生变化/,
    );
    assert.deepEqual(await readdir(outside), []);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("Linux 显式数据根符号链接保持支持，并固定相同根身份", {
  skip: process.platform !== "linux",
}, async () => {
  const { mkdirSync, symlinkSync } = await import("node:fs");
  const base = await mkdtemp(join(tmpdir(), "dai-bootstrap-root-link-"));
  const home = join(base, "home");
  const target = join(base, "configured-root");
  mkdirSync(home);
  mkdirSync(target);
  symlinkSync(target, join(home, ".dai"), "dir");
  const app = {
    commandLine: { getSwitchValue: () => "" },
    getPath: () => home,
    setPath() {},
    setAppLogsPath() {},
  } as unknown as App;
  try {
    const paths = configureDataPaths(app);
    try {
      assert.equal(paths.root, target);
      const info = await stat(target, { bigint: true });
      assert.deepEqual(paths.rootIdentity, {
        dev: info.dev.toString(),
        ino: info.ino.toString(),
      });
    } finally {
      paths.close();
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
