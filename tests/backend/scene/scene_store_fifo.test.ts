import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs, { constants, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openProjectStore } from "../../../src/backend/projects/store.ts";
import { commitSceneImport } from "../../../src/backend/scene/scene_store.ts";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

test("场景暂存和最终资源被替换成 FIFO 时不会阻塞", {
  skip: process.platform !== "linux",
}, async (t) => {
  for (const location of ["source", "staging", "resources"] as const) {
    await t.test(location, async () => {
      const root = mkdtempSync(join(tmpdir(), "dai-scene-fifo-"));
      const dataRoot = join(root, "data");
      const dataDir = join(dataRoot, "scene");
      const staging = join(dataDir, "staging");
      const resources = join(dataDir, "resources");
      const source = join(root, "source.step");
      mkdirSync(staging, { recursive: true });
      mkdirSync(resources);
      if (location !== "source") writeFileSync(source, "step");
      const stageFile = join(staging, "model.glb");
      const fifo =
        location === "source"
          ? source
          : location === "staging"
            ? stageFile
            : join(resources, `${hash("good")}.glb`);
      if (location !== "staging") writeFileSync(stageFile, "good");
      assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
      const store = openProjectStore(dataRoot);
      const project = store.createProject({ name: "场景", mode: "scene", path: root });
      const originalOpen = fs.promises.open;
      let checked = false;
      try {
        fs.promises.open = (async (path, flags, mode) => {
          const filename =
            location === "source"
              ? "source.step"
              : location === "staging"
                ? "model.glb"
                : `${hash("good")}.glb`;
          if (String(path).endsWith(`/${filename}`)) {
            checked = true;
            assert.equal(typeof flags, "number");
            assert.ok(
              (flags as number) & constants.O_NONBLOCK,
              "缺少 O_NONBLOCK 会导致 FIFO 永久阻塞",
            );
          }
          return originalOpen(path, flags, mode);
        }) as typeof originalOpen;
        syncBuiltinESMExports();
        await assert.rejects(
          commitSceneImport({
            store,
            dataDir,
            projectId: project.id,
            expectedRevision: 0,
            approvedStepPath: source,
            result: {
              source: { path: source, sha256: hash("step") },
              resource: {
                path: stageFile,
                format: "glb",
                byteLength: 4,
                sha256: hash("good"),
              },
              objects: [],
              warnings: [],
              complete: true,
            },
          }),
          /STEP 文件不可用|场景产物校验失败|场景资源校验失败/,
        );
        assert.equal(checked, true);
        assert.equal(store.getScene(project.id), null);
      } finally {
        fs.promises.open = originalOpen;
        syncBuiltinESMExports();
        store.close();
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});
