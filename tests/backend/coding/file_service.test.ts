import { strict as assert } from "node:assert";
import { chmod, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createCodingFileService } from "../../../src/backend/module/coding/file_service.ts";
import { openProjectStore } from "../../../src/backend/projects/store.ts";

test("Coding 文件服务限制项目路径并安全读取文本", async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-coding-"));
  const work = join(root, "work");
  await mkdir(work);
  await mkdir(join(work, "src"));
  await writeFile(join(work, "src", "main.ts"), "const a = 1;\n");
  await writeFile(join(work, "binary"), Buffer.from([0, 1]));
  await writeFile(join(root, "secret"), "secret");
  await symlink(root, join(work, "external"), "junction");
  const store = openProjectStore(join(root, "data"));
  try {
    const project = store.createProject({ name: "代码", mode: "coding", path: work });
    const files = createCodingFileService(store);
    const list = await files.list(project.id, "", 0);
    assert.deepEqual(
      list.entries.map((entry) => entry.name),
      ["src", "binary"],
    );
    assert.equal(list.nextOffset, null);
    const file = await files.read(project.id, "src/main.ts");
    assert.equal(file.content, "const a = 1;\n");
    assert.match(file.version, /^[0-9a-f]{64}$/);
    await assert.rejects(files.read(project.id, "../secret"), /路径无效/);
    await assert.rejects(files.read(project.id, "external/secret"));
    await assert.rejects(files.read(project.id, "binary"), /二进制/);
    await assert.rejects(files.read(project.id, "components/missing.ts"), (error: Error) => {
      assert.match(error.message, /不存在.*components\/missing.ts/);
      assert.ok(!error.message.includes("/proc/self/fd"));
      return true;
    });
    await assert.rejects(files.list(project.id, "components", 0), /不存在.*components/);
    assert.deepEqual((await files.search(project.id, "")).paths, ["binary", "src/main.ts"]);
    if (process.getuid && process.getuid() !== 0) {
      await mkdir(join(work, "private"));
      await writeFile(join(work, "private", "main.ts"), "hidden");
      await chmod(join(work, "private"), 0);
      try {
        assert.deepEqual((await files.search(project.id, "main")).paths, ["src/main.ts"]);
      } finally {
        await chmod(join(work, "private"), 0o700);
      }
    }
    await writeFile(join(work, "oversized.ts"), "x".repeat(2 * 1024 * 1024 + 1));
    await assert.rejects(files.read(project.id, "oversized.ts"), /超过 2 MiB/);
    if (process.platform === "win32") {
      for (const path of ["..\\secret", "src/main.ts:stream", "src/.. /secret", "NUL.txt"]) {
        await assert.rejects(files.read(project.id, path), /路径无效/);
      }
    }
    await rename(work, join(root, "previous"));
    await symlink(root, work, "junction");
    await assert.rejects(files.read(project.id, "secret"), /符号链接/);
    await assert.rejects(files.list(project.id, "", 0), /符号链接/);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("目录分页在内容变化时拒绝继续使用旧快照", async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-coding-page-"));
  const work = join(root, "work");
  await mkdir(work);
  await Promise.all(
    Array.from({ length: 205 }, (_, index) => writeFile(join(work, `file-${index}`), "x")),
  );
  const store = openProjectStore(join(root, "data"));
  try {
    const project = store.createProject({ name: "代码", mode: "coding", path: work });
    const files = createCodingFileService(store);
    const first = await files.list(project.id, "", 0);
    assert.equal(first.entries.length, 200);
    assert.equal(first.nextOffset, 200);
    const second = await files.list(project.id, "", 200, first.snapshot);
    assert.equal(second.entries.length, 5);
    await writeFile(join(work, "new-file"), "x");
    await assert.rejects(files.list(project.id, "", 200, first.snapshot), /目录已变化/);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
