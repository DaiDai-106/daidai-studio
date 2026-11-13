import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import fs, {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openProjectStore } from "../../../src/backend/projects/store.ts";
import { commitSceneImport } from "../../../src/backend/scene/scene_store.ts";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

test("固定目录及文件句柄保护场景接管，取消与重启不覆盖旧场景", {
  skip: process.platform !== "linux",
}, async (t) => {
  for (const kind of ["resources", "staging", "source", "temporary", "final", "cancel"] as const) {
    await t.test(kind, async () => {
      const root = mkdtempSync(join(tmpdir(), "dai-scene-takeover-"));
      const dataRoot = join(root, "data");
      const dataDir = join(dataRoot, "scene");
      const staging = join(dataDir, "staging");
      const resources = join(dataDir, "resources");
      const outside = join(root, "outside");
      const source = join(root, "source.step");
      mkdirSync(staging, { recursive: true });
      mkdirSync(resources);
      mkdirSync(outside);
      writeFileSync(source, "step");
      writeFileSync(join(staging, "model.glb"), "good");
      writeFileSync(join(outside, "model.glb"), "unrelated");
      const oldResource = join(resources, `${hash("old")}.glb`);
      writeFileSync(oldResource, "old");
      let store = openProjectStore(dataRoot);
      const project = store.createProject({ name: "场景", mode: "scene", path: root });
      const previous = store.saveScene(project.id, 0, { models: [{ sentinel: "old" }] });
      const result = {
        source: { path: source, sha256: hash("step") },
        resource: {
          path: join(staging, "model.glb"),
          format: "glb" as const,
          byteLength: 4,
          sha256: hash("good"),
        },
        objects: [],
        warnings: [],
        complete: true,
      };
      const controller = new AbortController();
      const originalLink = fs.promises.link;
      let intercepted = false;
      try {
        fs.promises.link = async (from, to) => {
          intercepted = true;
          if (kind === "resources") {
            renameSync(resources, `${resources}-held`);
            symlinkSync(outside, resources, "dir");
          } else if (kind === "source") {
            unlinkSync(join(staging, "model.glb"));
            writeFileSync(join(staging, "model.glb"), "evil");
          } else if (kind === "temporary") {
            unlinkSync(from);
            symlinkSync(join(outside, "model.glb"), from);
          } else if (kind === "cancel") {
            controller.abort();
          }
          await originalLink(from, to);
          if (kind === "staging") {
            renameSync(staging, `${staging}-held`);
            symlinkSync(outside, staging, "dir");
          } else if (kind === "final") {
            unlinkSync(to);
            symlinkSync(join(outside, "model.glb"), to);
          }
        };
        syncBuiltinESMExports();
        const request = {
          store,
          dataDir,
          projectId: project.id,
          expectedRevision: 1,
          approvedStepPath: source,
          result,
          ...(kind === "cancel" ? { signal: controller.signal } : {}),
        };
        if (kind === "source") {
          const saved = await commitSceneImport(request);
          assert.equal(saved.revision, 2);
          assert.equal(readFileSync(join(resources, `${hash("good")}.glb`), "utf8"), "good");
        } else {
          await assert.rejects(commitSceneImport(request));
          assert.deepEqual(store.getScene(project.id), previous);
        }
        assert.equal(intercepted, true);
        assert.equal(readFileSync(join(outside, "model.glb"), "utf8"), "unrelated");
        assert.equal(existsSync(join(outside, `${hash("good")}.glb`)), false);
        const oldPath =
          kind === "resources" ? join(`${resources}-held`, `${hash("old")}.glb`) : oldResource;
        assert.equal(readFileSync(oldPath, "utf8"), "old");
        fs.promises.link = originalLink;
        syncBuiltinESMExports();
        store.close();
        store = openProjectStore(dataRoot);
        assert.equal(store.getScene(project.id)?.revision, kind === "source" ? 2 : 1);
        if (kind === "cancel") {
          const recovered = await commitSceneImport({
            store,
            dataDir,
            projectId: project.id,
            expectedRevision: 1,
            approvedStepPath: source,
            result,
          });
          assert.equal(recovered.revision, 2);
          assert.equal(readFileSync(join(resources, `${hash("good")}.glb`), "utf8"), "good");
          assert.equal(readFileSync(oldResource, "utf8"), "old");
        }
      } finally {
        fs.promises.link = originalLink;
        syncBuiltinESMExports();
        store.close();
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

test("资源接管不跟随被替换的数据根祖先", { skip: process.platform !== "linux" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "dai-scene-root-takeover-"));
  const parent = join(root, "parent");
  const dataRoot = join(parent, "data");
  const outside = join(root, "outside");
  const source = join(root, "source.step");
  mkdirSync(dataRoot, { recursive: true });
  mkdirSync(join(outside, "data"), { recursive: true });
  writeFileSync(source, "step");
  const store = openProjectStore(dataRoot);
  const project = store.createProject({ name: "场景", mode: "scene", path: root });
  const scene = join(dataRoot, "projects", project.id, "scene");
  const stage = join(scene, "staging");
  const outsideStage = join(outside, "data", "projects", project.id, "scene", "staging");
  mkdirSync(stage, { recursive: true });
  mkdirSync(outsideStage, { recursive: true });
  writeFileSync(join(stage, "model.glb"), "good");
  writeFileSync(join(outsideStage, "model.glb"), "evil");
  const original = fs.promises.realpath;
  let swapped = false;
  try {
    fs.promises.realpath = (async (path) => {
      const result = await original(path);
      if (!swapped && String(path) === dataRoot) {
        swapped = true;
        renameSync(parent, `${parent}-held`);
        symlinkSync(outside, parent, "dir");
      }
      return result;
    }) as typeof original;
    syncBuiltinESMExports();
    await assert.rejects(
      commitSceneImport({
        store,
        dataRoot,
        dataDir: scene,
        projectId: project.id,
        expectedRevision: 0,
        approvedStepPath: source,
        result: {
          source: { path: source, sha256: hash("step") },
          resource: {
            path: join(stage, "model.glb"),
            format: "glb",
            byteLength: 4,
            sha256: hash("good"),
          },
          objects: [],
          warnings: [],
          complete: true,
        },
      }),
    );
    assert.equal(swapped, true);
    assert.equal(
      existsSync(join(outside, "data", "projects", project.id, "scene", "resources")),
      false,
    );
    assert.equal(readFileSync(join(outsideStage, "model.glb"), "utf8"), "evil");
    assert.equal(store.getScene(project.id), null);
  } finally {
    fs.promises.realpath = original;
    syncBuiltinESMExports();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
