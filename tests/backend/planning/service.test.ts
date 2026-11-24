import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createPlanningService } from "../../../src/backend/module/planning/service.ts";
import type { PlanningScene, PlanningSource } from "../../../src/contracts/planning.ts";

const worker = String.raw`
const { existsSync, readSync, writeFileSync, writeSync } = require("node:fs");
const { basename } = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");

function* requests() {
  const byte = Buffer.alloc(1);
  let bytes = [];
  while (readSync(0, byte) !== 0) {
    if (byte[0] === 10) {
      yield JSON.parse(Buffer.from(bytes).toString());
      bytes = [];
    } else {
      bytes.push(byte[0]);
    }
  }
}

async function main() {
  let current;
  let source;
  for (const request of requests()) {
    let reply;
    if (request.method === "loadScene") {
      source = request.path;
      writeFileSync(request.path + ".started", String(process.pid));
      while (!existsSync(request.path + ".ready")) await delay(5);
      if (basename(request.path) === "invalid-package") {
        reply = { ok: false, error: "invalid package" };
      } else {
        current = {
          schemaVersion: 1,
          robot: {
            name: basename(request.path),
            rootLinkId: "base",
            links: [{ id: "base", name: "base", visuals: [] }],
            joints: [],
          },
          frame: "load-" + request.kind,
          robots: [], positioners: [], groups: [], collisionGeometry: [],
          objects: [], attachedObjects: [], assets: [],
        };
        if (basename(source) === "non-stl.urdf") {
          const id = "1".repeat(64) + ".stl";
          current.assets.push({ id, path: source + ".obj" });
          current.robot.links[0].visuals.push({
            origin: { xyz: [0, 0, 0], rpy: [0, 0, 0] },
            geometry: { type: "mesh", asset: id, scale: [1, 1, 1] },
          });
        }
        reply = { ok: true, scene: current };
      }
    } else {
      writeFileSync(source + ".exporting", "");
      while (existsSync(source + ".pause-export")) await delay(5);
      reply = { ok: true, scene: { ...current, frame: "export" } };
    }
    writeSync(3, JSON.stringify({ ...reply, id: request.id }) + "\n");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
`;

async function setup(context: TestContext, publish: (scene: PlanningScene) => void) {
  const dir = await mkdtemp(join(tmpdir(), "dai-planning-test-"));
  const service = createPlanningService(dir, (_project, scene) => publish(scene));
  context.after(async () => {
    service.close();
    await rm(dir, { recursive: true, force: true });
  });
  await writeFile(join(dir, "planning-worker"), `#!${process.execPath}\n${worker}`, {
    mode: 0o700,
  });
  return { dir, service };
}

async function waitForWorkerFile(path: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || attempt === 100) throw error;
      await delay(10);
    }
  }
}

test("重新打开项目等待 URDF 和 Package 加载，随后导出实际保留的场景", {
  skip: process.platform !== "linux",
  timeout: 10_000,
}, async (context) => {
  const updates: string[] = [];
  const { dir, service } = await setup(context, (scene) => updates.push(scene.revision));

  async function createPackage(path: string) {
    await mkdir(path);
    await writeFile(join(path, "robot.urdf"), "");
  }

  async function loadAndReopen(kind: PlanningSource, name: string) {
    const path = join(dir, name);
    if (kind === "package") await createPackage(path);
    else await writeFile(path, "");
    const load = service.load("project", kind, path);
    void load.catch(() => {});
    const scene = service.get("project");
    void scene.catch(() => {});
    const pending = Symbol();
    assert.equal(await Promise.race([scene, delay(30, pending)]), pending);
    await writeFile(`${path}.ready`, "");
    return { load, scene };
  }

  const urdf = await loadAndReopen("urdf", "robot.urdf");
  const loadedUrdf = await urdf.load;
  assert.equal(loadedUrdf.frame, "load-urdf");
  assert.deepEqual(await urdf.scene, { ...loadedUrdf, frame: "export" });

  const packageDirectory = await loadAndReopen("package", "robot-package");
  const loadedPackage = await packageDirectory.load;
  assert.equal(loadedPackage.frame, "load-package");
  assert.notEqual(loadedPackage.revision, loadedUrdf.revision);
  assert.deepEqual(await packageDirectory.scene, { ...loadedPackage, frame: "export" });

  const ambiguousPackage = join(dir, "ambiguous-package");
  await createPackage(ambiguousPackage);
  await writeFile(join(ambiguousPackage, "alternate.URDF"), "");
  await assert.rejects(
    service.load("project", "package", ambiguousPackage),
    /多个 URDF.*alternate\.URDF.*robot\.urdf/,
  );
  await assert.rejects(access(`${ambiguousPackage}.started`), { code: "ENOENT" });
  assert.deepEqual(await service.get("project"), { ...loadedPackage, frame: "export" });

  const emptyPackage = join(dir, "empty-package");
  await mkdir(join(emptyPackage, "nested.urdf"), { recursive: true });
  await writeFile(join(emptyPackage, "nested.urdf", "robot.urdf"), "");
  await assert.rejects(service.load("project", "package", emptyPackage), /顶层没有 URDF 文件/);

  const invalid = await loadAndReopen("package", "invalid-package");
  await assert.rejects(invalid.load, /invalid package/);
  assert.deepEqual(await invalid.scene, { ...loadedPackage, frame: "export" });

  const cancelledPackage = join(dir, "cancelled-package");
  await createPackage(cancelledPackage);
  const controller = new AbortController();
  const cancelled = service.load("project", "package", cancelledPackage, controller.signal);
  const rejected = assert.rejects(cancelled, { name: "AbortError" });
  await waitForWorkerFile(`${cancelledPackage}.started`);
  controller.abort();
  await rejected;
  assert.deepEqual(await service.get("project"), { ...loadedPackage, frame: "export" });

  const nonStl = join(dir, "non-stl.urdf");
  await writeFile(nonStl, "");
  await writeFile(`${nonStl}.ready`, "");
  await assert.rejects(service.load("project", "urdf", nonStl), /只支持 STL.*\.obj/);
  assert.deepEqual(await service.get("project"), { ...loadedPackage, frame: "export" });
  assert.deepEqual(updates, [loadedUrdf.revision, loadedPackage.revision]);
});

test("取消单次等待保留共享导出，进程退出后发布最后一份快照", {
  skip: process.platform !== "linux",
  timeout: 10_000,
}, async (context) => {
  const staleScene = Promise.withResolvers<PlanningScene>();
  const { dir, service } = await setup(context, (scene) => {
    if (scene.status === "stale") staleScene.resolve(scene);
  });
  const path = join(dir, "robot.urdf");
  await writeFile(path, "");
  const load = service.load("project", "urdf", path);
  void load.catch(() => {});

  const loadWait = new AbortController();
  const cancelledLoadWait = assert.rejects(service.get("project", loadWait.signal), {
    name: "AbortError",
  });
  loadWait.abort();
  await cancelledLoadWait;
  await writeFile(`${path}.ready`, "");
  const loaded = await load;
  assert.equal(loaded.status, "loaded");

  await writeFile(`${path}.pause-export`, "");
  const exportWait = new AbortController();
  const cancelledExportWait = assert.rejects(service.get("project", exportWait.signal), {
    name: "AbortError",
  });
  const sharedExport = service.get("project");
  void sharedExport.catch(() => {});
  await waitForWorkerFile(`${path}.exporting`);
  exportWait.abort();
  await cancelledExportWait;
  await rm(`${path}.pause-export`);
  const exported = await sharedExport;
  assert.deepEqual(exported, { ...loaded, frame: "export" });

  const pid = Number(await readFile(`${path}.started`, "utf8"));
  assert.ok(Number.isInteger(pid) && pid > 0);
  process.kill(pid);
  const cached = { ...exported, status: "stale" };
  assert.deepEqual(await staleScene.promise, cached);
  assert.deepEqual(await service.get("project"), cached);
  const reloaded = await service.load("project", "urdf", path);
  assert.equal(reloaded.status, "loaded");
  assert.notEqual(reloaded.revision, loaded.revision);
});
