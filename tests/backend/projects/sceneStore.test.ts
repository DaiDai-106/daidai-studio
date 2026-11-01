import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { commitSceneImport } from "../../../src/backend/projects/sceneStore.ts";
import { openProjectStore } from "../../../src/backend/projects/store.ts";

const hash = (content: string) => createHash("sha256").update(content).digest("hex");

test("接管校验后的场景产物，源 STEP 留在原位置，拒绝越权和旧版本", async () => {
  const root = mkdtempSync(join(tmpdir(), "dai-scene-"));
  const dataDir = join(root, "data", "scene");
  const staging = join(dataDir, "staging");
  mkdirSync(staging, { recursive: true });
  const step = join(root, "model.step");
  const target = join(root, "target.step");
  const file = join(staging, "result.glb");
  writeFileSync(target, "step-source");
  if (process.platform === "linux") symlinkSync(target, step);
  else writeFileSync(step, "step-source");
  writeFileSync(file, "scene-resource");
  const store = openProjectStore(join(root, "data"));
  try {
    const project = store.createProject({ name: "场景", mode: "scene", path: root });
    const result = {
      source: { path: step, sha256: hash("step-source") },
      resource: {
        path: file,
        format: "glb" as const,
        byteLength: 14,
        sha256: hash("scene-resource"),
      },
      objects: [{ id: "model", name: "模型", parentId: null }],
      warnings: [],
      complete: true,
    };
    const saved = await commitSceneImport({
      store,
      dataDir,
      projectId: project.id,
      expectedRevision: 0,
      approvedStepPath: step,
      result,
    });
    assert.equal(saved.revision, 1);
    assert.equal(readFileSync(step, "utf8"), "step-source");
    assert.equal(
      readFileSync(join(dataDir, "resources", `${result.resource.sha256}.glb`), "utf8"),
      "scene-resource",
    );
    assert.deepEqual(store.getScene(project.id), saved);
    writeFileSync(file, "scene-resource");
    await assert.rejects(
      commitSceneImport({
        store,
        dataDir,
        projectId: project.id,
        expectedRevision: 0,
        approvedStepPath: step,
        result,
      }),
      /其他会话更新/,
    );
    writeFileSync(file, "bad");
    await assert.rejects(
      commitSceneImport({
        store,
        dataDir,
        projectId: project.id,
        expectedRevision: 1,
        approvedStepPath: step,
        result,
      }),
      /校验失败/,
    );
    assert.deepEqual(store.getScene(project.id), saved);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
