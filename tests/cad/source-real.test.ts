import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Mesh, Vector3 } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { Value } from "typebox/value";
import {
  CadDisplaySchema,
  CadFaceMapSchema,
  type CadHandle,
  CadImportSchema,
  type CadInput,
  CadManifestSchema,
  type CadToolName,
  validateCadOutput,
} from "../../resources/mcp/cad/contract.ts";
import { openCadServer } from "../support/cadServer.ts";

const executable = process.env.DAI_CAD_TEST_WORKER,
  source = process.env.DAI_CAD_REAL_STEP;
test("real STEP recovery preserves source identity, face coverage and auditable native diagnostics through MCP", {
  skip: !executable || !source,
  timeout: 150_000,
}, async () => {
  assert.ok(executable && source);
  const root = await mkdtemp(join(tmpdir(), "dai-recovery-real-"));
  const project = join(root, "project"),
    staging = join(root, "staging");
  await mkdir(project);
  const path = join(project, "source.STEP");
  await copyFile(source, path);
  const digest = async () =>
    createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  const hash = await digest();
  const connection = await openCadServer({
    executable,
    projectRoot: project,
    stagingRoot: staging,
  });
  try {
    async function call<K extends CadToolName>(name: K, input: CadInput<K>) {
      const result = await connection.client.callTool(name, { ...input });
      assert.equal(result.isError, false, JSON.stringify(result));
      const envelope = result.structuredContent;
      validateCadOutput(name, envelope);
      assert.ok(envelope.ok);
      return envelope.data;
    }
    async function finish(job: CadHandle) {
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        const state = await call("cad_get_job", { job });
        if (state.status === "succeeded") return state.result;
        assert.ok(state.status === "queued" || state.status === "running", JSON.stringify(state));
        await setTimeout(100);
      }
      throw new Error("Real CAD recovery timed out.");
    }
    const accepted = await call("cad_import_step", {
      path,
      options: {},
    });
    const imported = await finish(accepted.job);
    assert.ok(Value.Check(CadImportSchema, imported));
    const requested = await call("cad_build_display", {
      document: imported.document,
      quality: "preview",
    });
    const display = await finish(requested.job);
    assert.ok(Value.Check(CadDisplaySchema, display));
    const manifest: unknown = JSON.parse(
      await readFile(fileURLToPath(display.manifest.uri), "utf8"),
    );
    assert.ok(Value.Check(CadManifestSchema, manifest));
    const descriptor = manifest.resources.find(
      (resource) => resource.mediaType === "application/json",
    );
    assert.ok(descriptor);
    const mappingBytes = await readFile(fileURLToPath(descriptor.uri));
    assert.equal(createHash("sha256").update(mappingBytes).digest("hex"), descriptor.sha256);
    const mapping: unknown = JSON.parse(mappingBytes.toString());
    assert.ok(Value.Check(CadFaceMapSchema, mapping));
    assert.equal(mapping.sourceHash, hash);
    assert.equal(mapping.importFingerprint, imported.source.importFingerprint);
    if (hash === "a61a79d8ec01692539c51792aa2a7d2a8dd5fe642084b1632f97788a6f5eedae") {
      assert.equal(
        manifest.complete,
        false,
        "Existing native wire errors must not be hidden by recovered faces",
      );
      assert.equal(mapping.recoveries?.length, 7);
      assert.equal(manifest.omittedFaceCount, 4);
      assert.equal(display.summary.omittedFaceCount, 4);
      assert.equal(display.summary.triangleCount, 460687);
      const omitted = mapping.omittedFaces;
      assert.ok(omitted);
      assert.deepEqual(
        omitted.map((face) => face.topologyRef.id).sort(),
        [1676, 1677, 1718, 1719].map((id) => `0:1:1:12/face/${id}`).sort(),
      );
      for (const face of omitted)
        assert.equal(
          mapping.ranges.some(
            (range) =>
              range.geometryId === face.geometryId && range.topologyRef.id === face.topologyRef.id,
          ),
          false,
          "Excluded faces must not remain drawable or selectable",
        );
      assert.deepEqual(
        mapping.recoveries.map((item) => item.topologyRef.id).sort(),
        [
          "0:1:1:12/face/1696",
          "0:1:1:12/face/1739",
          "0:1:1:13/face/349",
          "0:1:1:160/face/42",
          "0:1:1:160/face/471",
          "0:1:1:161/face/648",
          "0:1:1:161/face/649",
        ].sort(),
      );
      for (const recovered of mapping.recoveries) {
        assert.ok(Math.abs(recovered.meshAreaM2 / recovered.sourceAreaM2 - 1) <= 0.01);
        assert.equal(recovered.toleranceIncreaseM, 0);
        assert.ok(
          mapping.ranges.some(
            (range) =>
              range.geometryId === recovered.geometryId &&
              range.topologyRef.id === recovered.topologyRef.id &&
              range.triangleCount > 0,
          ),
        );
      }
      assert.equal(
        manifest.diagnostics.filter((item) => item.status === "missing_face_mesh").length,
        0,
      );
      assert.equal(
        manifest.diagnostics.filter((item) => item.status.startsWith("face_mesher_status_")).length,
        4,
      );
      assert.ok(manifest.warnings.some((warning) => warning.includes("7")));
      const glb = manifest.resources.find((resource) => resource.mediaType === "model/gltf-binary");
      assert.ok(glb);
      const bytes = await readFile(fileURLToPath(glb.uri));
      const model = await new GLTFLoader().parseAsync(Uint8Array.from(bytes).buffer, "");
      try {
        for (const recovered of mapping.recoveries) {
          const range = mapping.ranges.find(
            (range) =>
              range.geometryId === recovered.geometryId &&
              range.topologyRef.id === recovered.topologyRef.id,
          );
          assert.ok(range);
          let checked = false;
          model.scene.traverse((node) => {
            if (!(node instanceof Mesh) || checked) return;
            const association = model.parser.associations.get(node);
            if (
              association?.meshes !== range.meshIndex ||
              association.primitives !== range.primitiveIndex
            )
              return;
            const positions = node.geometry.getAttribute("position"),
              indices = node.geometry.getIndex();
            assert.ok(indices);
            let area = 0;
            const a = new Vector3(),
              b = new Vector3(),
              c = new Vector3();
            for (
              let index = range.firstTriangle;
              index < range.firstTriangle + range.triangleCount;
              ++index
            ) {
              a.fromBufferAttribute(positions, indices.getX(index * 3));
              b.fromBufferAttribute(positions, indices.getX(index * 3 + 1));
              c.fromBufferAttribute(positions, indices.getX(index * 3 + 2));
              const triangle = b.sub(a).cross(c.sub(a)).length() / 2;
              assert.ok(triangle > 0, "A native recovery collapsed during GLB float32 conversion");
              area += triangle;
            }
            assert.ok(Math.abs(area / recovered.sourceAreaM2 - 1) < 0.01);
            assert.ok(Math.abs(area / recovered.meshAreaM2 - 1) < 1e-6);
            checked = true;
          });
          assert.ok(checked, "Recovered CAD topology lost its displayed mesh association");
        }
      } finally {
        model.scene.traverse((node) => {
          if (!(node instanceof Mesh)) return;
          node.geometry.dispose();
          for (const material of Array.isArray(node.material) ? node.material : [node.material])
            material.dispose();
        });
      }
    }
    assert.equal(await digest(), hash, "Meshing must not change source STEP bytes");
    await call("cad_release_document", { document: imported.document });
  } finally {
    await connection.close();
    await rm(root, { recursive: true, force: true });
  }
});
