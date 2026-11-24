import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createCodingFileService } from "../../../src/backend/module/coding/file_service.ts";
import { resolveFileReferences } from "../../../src/backend/module/coding/references.ts";
import { openProjectStore } from "../../../src/backend/projects/store.ts";

test("搜索跳过链接与构建目录；引用只发送指定行的真实快照", async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-file-refs-"));
  const work = join(root, "work");
  await mkdir(join(work, "src"), { recursive: true });
  await mkdir(join(work, "node_modules"));
  await writeFile(join(work, "node_modules", "main.ts"), "ignored");
  await writeFile(join(work, "src", "my main.ts"), "before\nselected\nafter\n");
  await writeFile(join(root, "secret.ts"), "outside");
  await symlink(join(root, "secret.ts"), join(work, "secret.ts"));
  const store = openProjectStore(join(root, "data"));
  try {
    const project = store.createProject({ name: "代码", mode: "coding", path: work });
    const files = createCodingFileService(store);
    assert.deepEqual(await files.search(project.id, "MAIN"), {
      paths: ["src/my main.ts"],
      truncated: false,
    });
    assert.deepEqual((await files.search(project.id, "secret")).paths, []);
    const message = '分析 @"src/my main.ts":2';
    const resolved = await resolveFileReferences(files, project.id, message);
    const snapshot = JSON.parse(resolved.split("\n").at(-1) ?? "");
    assert.equal(snapshot.content, "2: selected");
    assert.equal(snapshot.path, "src/my main.ts");
    assert.match(snapshot.sha256, /^[a-f0-9]{64}$/);
    await writeFile(join(work, "src", "my main.ts"), "before\nchanged\nafter\n");
    const updated = await resolveFileReferences(files, project.id, message);
    assert.ok(updated.includes("2: changed"));
    assert.ok(!updated.includes(snapshot.sha256));
    await assert.rejects(resolveFileReferences(files, project.id, '@"secret.ts"'), /./);
    await assert.rejects(resolveFileReferences(files, project.id, '@"src/my main.ts":4-8'), /超出/);
    await writeFile(join(work, "large.ts"), "line\n".repeat(201));
    const whole = await resolveFileReferences(files, project.id, '@"large.ts"');
    assert.match(whole, /201: line/);
    await writeFile(join(work, "binary.ts"), Buffer.from([0, 1]));
    await assert.rejects(resolveFileReferences(files, project.id, '@"binary.ts"'), /二进制/);
    await writeFile(join(work, "long.ts"), "x".repeat(32_001));
    await assert.rejects(resolveFileReferences(files, project.id, '@"long.ts"'), /引用过大/);
    await assert.rejects(
      resolveFileReferences(
        files,
        project.id,
        Array.from({ length: 6 }, (_, index) => `@"file${index}.ts"`).join(" "),
      ),
      /最多引用 5/,
    );
    assert.equal(await resolveFileReferences(files, project.id, "普通问题"), "普通问题");
    await Promise.all(
      Array.from({ length: 105 }, (_, index) => writeFile(join(work, `match-${index}.ts`), "x")),
    );
    const limited = await files.search(project.id, "match-");
    assert.equal(limited.paths.length, 100);
    assert.equal(limited.truncated, true);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
