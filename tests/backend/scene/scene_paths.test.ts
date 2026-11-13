import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openProjectStore } from "../../../src/backend/projects/store.ts";
import { ensureSceneDirectory } from "../../../src/backend/scene/scene_paths.ts";
import { createSceneService } from "../../../src/backend/scene/scene_service.ts";
import { commitSceneImport } from "../../../src/backend/scene/scene_store.ts";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

test("场景 staging/resources 的外部链接和超大声明不能覆盖已保存状态", {
  skip: process.platform === "win32",
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "dai-scene-path-"));
  const dataRoot = join(root, "data");
  const sceneDir = join(dataRoot, "scene");
  const outside = join(root, "outside");
  const source = join(root, "source.step");
  const stage = join(sceneDir, "staging");
  mkdirSync(sceneDir, { recursive: true });
  mkdirSync(outside);
  writeFileSync(source, "step");
  writeFileSync(join(outside, "model.glb"), "GLB");
  const store = openProjectStore(dataRoot);
  try {
    const project = store.createProject({ name: "场景", mode: "scene", path: root });
    const previous = store.saveScene(project.id, 0, { models: [] });
    const result = {
      source: { path: source, sha256: hash("step") },
      resource: {
        path: join(stage, "model.glb"),
        format: "glb",
        byteLength: 3,
        sha256: hash("GLB"),
      },
      objects: [],
      warnings: [],
      complete: true,
    };
    symlinkSync(outside, stage, "dir");
    await assert.rejects(
      commitSceneImport({
        store,
        dataDir: sceneDir,
        projectId: project.id,
        expectedRevision: 1,
        approvedStepPath: source,
        result,
      }),
      /链接|受控|目录/,
    );
    assert.equal(readFileSync(join(outside, "model.glb"), "utf8"), "GLB");
    rmSync(stage);
    mkdirSync(stage);
    writeFileSync(join(stage, "model.glb"), "GLB");
    symlinkSync(outside, join(sceneDir, "resources"), "dir");
    await assert.rejects(
      commitSceneImport({
        store,
        dataDir: sceneDir,
        projectId: project.id,
        expectedRevision: 1,
        approvedStepPath: source,
        result,
      }),
      /链接|受控|目录/,
    );
    assert.equal(existsSync(join(outside, `${hash("GLB")}.glb`)), false);
    await assert.rejects(
      commitSceneImport({
        store,
        dataDir: sceneDir,
        projectId: project.id,
        expectedRevision: 1,
        approvedStepPath: source,
        result: { ...result, resource: { ...result.resource, byteLength: 512 * 1024 * 1024 + 1 } },
      }),
      /无效|大小|限制/,
    );
    assert.deepEqual(store.getScene(project.id), previous);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("场景资源被替换成外部链接时不能通过资源协议读取", {
  skip: process.platform === "win32",
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "dai-scene-resource-"));
  const dataRoot = join(root, "data");
  const store = openProjectStore(dataRoot);
  const scenes = createSceneService({ dataRoot, store });
  try {
    const project = store.createProject({ name: "场景", mode: "scene", path: root });
    const directory = await ensureSceneDirectory(dataRoot, project.id);
    const resources = join(directory, "resources");
    mkdirSync(resources);
    const outside = join(root, "private.txt");
    writeFileSync(outside, "private");
    const sha = hash("GLB");
    const file = join(resources, `${sha}.glb`);
    symlinkSync(outside, file);
    store.saveScene(project.id, 0, {
      models: [
        {
          source: { path: outside, sha256: sha },
          resource: { path: file, format: "glb", byteLength: 3, sha256: sha },
          objects: [],
          warnings: [],
          complete: true,
        },
      ],
    });
    const url = new URL(scenes.get(project.id).models[0]?.resource.url ?? "");
    assert.throws(() => scenes.resolveResource(url.hostname, url.pathname.slice(1)), /链接|目录/);
    assert.equal(readFileSync(outside, "utf8"), "private");
  } finally {
    await scenes.dispose();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("项目场景目录父级指向外部时，启动 worker 前即拒绝", {
  skip: process.platform === "win32",
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "dai-scene-path-"));
  const dataRoot = join(root, "data");
  const outside = join(root, "outside");
  mkdirSync(outside);
  const store = openProjectStore(dataRoot);
  const scenes = createSceneService({ dataRoot, store, pythonExecutable: "missing-python" });
  try {
    const project = store.createProject({ name: "场景", mode: "scene", path: root });
    symlinkSync(outside, join(dataRoot, "projects"), "dir");
    await assert.rejects(
      scenes.import({
        projectId: project.id,
        path: join(root, "source.step"),
        operation: "replace",
        revision: 0,
      }),
      /链接|目录/,
    );
    assert.equal(existsSync(join(outside, project.id)), false);
  } finally {
    await scenes.dispose();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
