import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, open, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createSceneResourceReader } from "../../src/desktop/main/resourceReader.ts";

const projectId = "12345678-1234-4234-8234-123456789abc";
const contents = Buffer.from("glTF-authorized");
const digest = createHash("sha256").update(contents).digest("hex");
const metadata = { projectId, mediaType: "model/gltf-binary", byteLength: contents.length };

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "dai-resource-fd-"));
  const root = join(base, "data");
  const scene = join(root, "projects", projectId, "scene");
  const resources = join(scene, "resources");
  const outside = join(base, "outside");
  await mkdir(resources, { recursive: true });
  await mkdir(outside);
  await writeFile(join(resources, `${digest}.glb`), contents);
  await writeFile(join(outside, `${digest}.glb`), Buffer.alloc(contents.length, 65));
  return { base, root, scene, resources, outside };
}

const linuxOnly = { skip: process.platform !== "linux" ? "需要 Linux 目录句柄" : false };

test("目录项在打开父目录后被替换时，读取仍固定于原目录", linuxOnly, async () => {
  const paths = await fixture();
  let replaced = false;
  const reader = createSceneResourceReader(paths.root, {
    async afterDirectoryOpen(name) {
      if (name !== "resources" || replaced) return;
      replaced = true;
      await rename(paths.resources, `${paths.resources}-original`);
      await symlink(paths.outside, paths.resources, "dir");
    },
  });
  try {
    assert.deepEqual(await reader.read(metadata, digest), contents);
    await assert.rejects(reader.read(metadata, digest));
  } finally {
    reader.close();
    await rm(paths.base, { recursive: true, force: true });
  }
});

test("资源文件被链接替换后使用原句柄，不重开替换后的路径", linuxOnly, async () => {
  const paths = await fixture();
  let replaced = false;
  const file = join(paths.resources, `${digest}.glb`);
  const reader = createSceneResourceReader(paths.root, {
    async afterFileOpen() {
      if (replaced) return;
      replaced = true;
      await rename(file, `${file}.original`);
      await symlink(join(paths.outside, `${digest}.glb`), file);
    },
  });
  try {
    assert.deepEqual(await reader.read(metadata, digest), contents);
    await assert.rejects(reader.read(metadata, digest));
  } finally {
    reader.close();
    await rm(paths.base, { recursive: true, force: true });
  }
});

test("同一个 inode 在读取前被修改时拒绝发送，校验成功后返回独立缓冲", linuxOnly, async () => {
  const paths = await fixture();
  const file = join(paths.resources, `${digest}.glb`);
  const reader = createSceneResourceReader(paths.root, {
    afterFileOpen: () => writeFile(file, Buffer.alloc(contents.length, 42)),
  });
  try {
    await assert.rejects(reader.read(metadata, digest), /完整性校验/);
    await writeFile(file, contents);
    const safe = createSceneResourceReader(paths.root);
    try {
      const copy = await safe.read(metadata, digest);
      await writeFile(file, Buffer.alloc(contents.length, 0));
      assert.deepEqual(copy, contents);
    } finally {
      safe.close();
    }
  } finally {
    reader.close();
    await rm(paths.base, { recursive: true, force: true });
  }
});

test("固定数据根、防止越界、支持取消及并发限制", linuxOnly, async () => {
  const paths = await fixture();
  const controller = new AbortController();
  let release = () => {};
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = 0;
  const reader = createSceneResourceReader(paths.root, {
    async afterFileOpen() {
      started++;
      await wait;
    },
  });
  try {
    const first = reader.read(metadata, digest, controller.signal);
    const second = reader.read(metadata, digest);
    while (started < 2) await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(reader.read(metadata, digest), /繁忙/);
    controller.abort();
    release();
    await assert.rejects(first, /abort/i);
    assert.deepEqual(await second, contents);
    await assert.rejects(reader.read({ ...metadata, projectId: "../outside" }, digest), /身份/);
    await assert.rejects(
      reader.read({ ...metadata, byteLength: 256 * 1024 * 1024 + 1 }, digest),
      /大小/,
    );
    reader.close();
    await assert.rejects(reader.read(metadata, digest), /关闭/);
  } finally {
    release();
    reader.close();
    await rm(paths.base, { recursive: true, force: true });
  }
});

test("关闭读取器时仍在读取的句柄不会被复用", linuxOnly, async () => {
  const paths = await fixture();
  let release = () => {};
  let opened = () => {};
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    opened = resolve;
  });
  const reader = createSceneResourceReader(paths.root, {
    async beforeDirectoryOpen(name) {
      if (name === "projects") {
        opened();
        await waiting;
      }
    },
  });
  try {
    const reading = reader.read(metadata, digest);
    await ready;
    reader.close();
    await assert.rejects(reader.read(metadata, digest), /关闭/);
    const unrelated = await open(paths.outside, "r");
    try {
      release();
      assert.deepEqual(await reading, contents);
    } finally {
      await unrelated.close();
    }
  } finally {
    release();
    reader.close();
    await rm(paths.base, { recursive: true, force: true });
  }
});

test("初始化后的数据根目录被替换时继续读取原目录", linuxOnly, async () => {
  const paths = await fixture();
  const reader = createSceneResourceReader(paths.root);
  try {
    await rename(paths.root, `${paths.root}-original`);
    await symlink(paths.outside, paths.root, "dir");
    assert.deepEqual(await reader.read(metadata, digest), contents);
  } finally {
    reader.close();
    await rm(paths.base, { recursive: true, force: true });
  }
});

test("受控目录中被替换的外部硬链接必须通过内容校验", linuxOnly, async () => {
  const paths = await fixture();
  const target = join(paths.resources, `${digest}.glb`);
  let replaced = false;
  const reader = createSceneResourceReader(paths.root, {
    async afterDirectoryOpen(name) {
      if (name !== "resources" || replaced) return;
      replaced = true;
      await rename(target, `${target}.original`);
      await link(join(paths.outside, `${digest}.glb`), target);
    },
  });
  try {
    await assert.rejects(reader.read(metadata, digest), /完整性校验/);
  } finally {
    reader.close();
    await rm(paths.base, { recursive: true, force: true });
  }
});
