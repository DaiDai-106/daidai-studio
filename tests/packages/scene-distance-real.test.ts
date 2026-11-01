import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { createSceneRuntime, type SceneImportResult } from "../../packages/scene/src/runtime.ts";

const python = process.env.DAI_SCENE_TEST_PYTHON;
test("真实 BRep 距离可取消，取消不修改源文件或现有显示资源", {
  timeout: 60_000,
  skip: python ? false : "需要配置 DAI_SCENE_TEST_PYTHON",
}, async () => {
  assert.ok(python);
  const directory = await mkdtemp(join(tmpdir(), "dai-distance-real-"));
  const source = join(directory, "assembly.step");
  const runtime = createSceneRuntime({
    projectId: "distance",
    cwd: directory,
    dataDir: join(directory, "data"),
    pythonExecutable: python,
    workerPath: resolve("tests/packages/fixtures/distance-worker.py"),
  });
  try {
    await promisify(execFile)(python, [
      "-c",
      "import sys;sys.path.insert(0,sys.argv[1]);from assembly_fixture import write_assembly;write_assembly(sys.argv[2])",
      resolve("tests/python"),
      source,
    ]);
    const sourceBytes = await readFile(source);
    const imported = (await runtime.call("scene_import", { path: source })) as SceneImportResult;
    const object = imported.objects.find((item) => item.geometryBounds);
    assert.ok(object);
    const resourceBefore = await readFile(imported.resource.path);
    const sourceInfo = {
      path: source,
      sha256: createHash("sha256").update(sourceBytes).digest("hex"),
    };
    const reference = {
      source: sourceInfo,
      sourceKey: object.sourceKey,
      worldTransform: { position: [0, 0, 0], rotation: [0, 0, 0, 1] },
    };
    const other = {
      ...reference,
      worldTransform: { position: [0.05, 0, 0], rotation: [0, 0, 0, 1] },
    };
    const result = (await runtime.call("scene_measure_distance", {
      first: reference,
      second: other,
    })) as { shapeDistanceM: number; collision: string };
    assert.ok(Math.abs(result.shapeDistanceM - 0.04) < 1e-7);
    assert.equal(result.collision, "unknown");
    // 大量有效尾随空白使哈希阶段足够长，实际 worker 已预热。
    const padded = join(directory, "large.step");
    const padding = Buffer.alloc(64 * 1024 * 1024, 0x20);
    await writeFile(padded, Buffer.concat([sourceBytes, padding]));
    const paddedHash = createHash("sha256").update(sourceBytes).update(padding).digest("hex");
    const slow = { ...reference, source: { path: padded, sha256: paddedHash } };
    const beforeEntries = await readdir(join(directory, "data", "staging"));
    const abort = new AbortController();
    const cancelled = runtime.call(
      "scene_measure_distance",
      { first: slow, second: other },
      { signal: abort.signal },
    );
    const marker = join(directory, "distance-hash-started");
    const deadline = Date.now() + 10_000;
    let started = false;
    while (Date.now() < deadline) {
      try {
        await access(marker);
        started = true;
        break;
      } catch {
        await new Promise((done) => setTimeout(done, 1));
      }
    }
    assert.equal(started, true, "必须确认真实 worker 已开始读取 STEP 后再取消");
    abort.abort();
    await assert.rejects(cancelled, { name: "AbortError" });
    const after = (await runtime.call("scene_measure_distance", {
      first: reference,
      second: other,
    })) as { shapeDistanceM: number };
    assert.ok(Math.abs(after.shapeDistanceM - 0.04) < 1e-7);
    assert.deepEqual(await readFile(source), sourceBytes);
    assert.deepEqual(await readFile(imported.resource.path), resourceBefore);
    assert.deepEqual(await readdir(join(directory, "data", "staging")), beforeEntries);
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
