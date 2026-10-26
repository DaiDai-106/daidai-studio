import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { McpClient } from "@earendil-works/pi-mcp";
import { Box3, Mesh, MeshStandardMaterial } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { Value } from "typebox/value";
import {
  CadDisplaySchema,
  CadFaceMapSchema,
  type CadHandle,
  CadImportSchema,
  type CadInput,
  CadJobSchema,
  CadManifestSchema,
  CadObjectPageSchema,
  CadObjectSchema,
  type CadResource,
  type CadToolName,
  DisplayArtifactSchema,
  validateCadOutput,
} from "../../resources/mcp/cad/contract.ts";
import { openMcpConnection } from "../../src/backend/mcp/connection.ts";
import { openCadServer } from "../support/cadServer.ts";

const executable = process.env.DAI_CAD_TEST_WORKER;
const fixture = process.env.DAI_CAD_TEST_FIXTURE;
const available = !!executable && !!fixture;
const run = promisify(execFile);
async function call<K extends CadToolName>(client: McpClient, name: K, input: CadInput<K>) {
  const result = await client.callTool(name, { ...input });
  assert.equal(result.isError, false, JSON.stringify(result));
  const envelope = result.structuredContent;
  validateCadOutput(name, envelope);
  assert.ok(envelope.ok);
  return envelope.data;
}
async function errorCode<K extends CadToolName>(client: McpClient, name: K, input: CadInput<K>) {
  const result = await client.callTool(name, { ...input });
  assert.equal(result.isError, true);
  const envelope = result.structuredContent;
  validateCadOutput(name, envelope);
  assert.equal(envelope.ok, false);
  if (envelope.ok) assert.fail();
  return envelope.error.code;
}
async function finish(client: McpClient, job: CadHandle) {
  for (let i = 0; i < 1000; ++i) {
    const state = await call(client, "cad_get_job", { job });
    assert.ok(Value.Check(CadJobSchema, state));
    if (state.status === "succeeded" || state.status === "failed" || state.status === "cancelled")
      return state;
    await setTimeout(10);
  }
  throw new Error("CAD fixture task timed out.");
}
async function accepted(client: McpClient, input: CadInput<"cad_import_step">) {
  const value = await call(client, "cad_import_step", input);
  assert.ok(value && typeof value === "object" && "job" in value);
  const state = await finish(client, value.job as CadHandle);
  assert.equal(state.status, "succeeded", JSON.stringify(state));
  if (state.status !== "succeeded") assert.fail();
  assert.ok(Value.Check(CadImportSchema, state.result));
  return state.result;
}
async function readResource(_root: string, resource: CadResource) {
  const bytes = await readFile(fileURLToPath(resource.uri));
  assert.equal(bytes.byteLength, resource.byteLength);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), resource.sha256);
  return bytes;
}

test("real CAD MCP imports, queries, exports, cancels and releases isolated documents", {
  skip: !available && "Run npm run test:cad after installing native dependencies.",
  timeout: 60_000,
}, async () => {
  assert.ok(executable && fixture);
  const root = await mkdtemp(join(tmpdir(), "dai-cad-mcp-"));
  const project = join(root, "项目 with spaces");
  const staging = join(root, "staging");
  await mkdir(project);
  const path = join(project, "装配.STEP");
  await run(fixture, ["--write-fixture", path]);
  const sourceHash = createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
  const input = { path, options: {} };
  const options = { executable, projectRoot: project, stagingRoot: staging };
  const connection = await openCadServer(options);
  try {
    const { client } = connection;
    const tools = await client.listTools();
    assert.equal(tools.length, 12);
    assert.ok(tools.every((tool) => tool.inputSchema && tool.outputSchema));
    await assert.rejects(
      client.callTool("cad_import_step", { ...input, unwanted: true }),
      /Invalid arguments/,
    );
    const capabilities = await Promise.all(
      Array.from({ length: 8 }, () => call(client, "cad_get_capabilities", {})),
    );
    assert.equal(
      new Set(capabilities.map((value) => value.serverInstanceId)).size,
      1,
      "Concurrent initialization owns one native worker",
    );
    assert.ok(capabilities.every((value) => value.contractVersion === 2));
    const imported = await accepted(client, input);
    assert.equal(imported.objectCount, 4);
    assert.equal(imported.source.sourceHash, sourceHash);
    const workerStaging = staging;
    assert.equal(await errorCode(client, "cad_import_step", input), "BUSY");
    const page = await call(client, "cad_get_structure", {
      document: imported.document,
      mode: "all",
    });
    assert.ok(Value.Check(CadObjectPageSchema, page));
    const objects = page.items;
    assert.ok(objects.every((object) => Value.Check(CadObjectSchema, object)));
    const first = objects.find((object) => object.name === "first box");
    const second = objects.find((object) => object.name === "second box");
    assert.ok(first && second);
    assert.notEqual(first.objectId, second.objectId);
    assert.equal(first.geometryId, second.geometryId);
    const offsetX = second.localTransform.translation[0];
    assert.ok(offsetX !== undefined);
    assert.ok(Math.abs(offsetX - 1.1) < 1e-8);
    const propertyIds = [
      first.objectId,
      ...Array.from({ length: 49 }, (_, index) => `missing-object-${index}`),
    ];
    const properties = await call(client, "cad_get_properties", {
      document: imported.document,
      objectIds: propertyIds,
      fields: ["bounds"],
    });
    assert.equal(properties.items.length, 50);
    assert.equal(properties.items[0]?.bounds?.status, "exact");
    assert.equal(properties.items[49]?.bounds?.status, "unavailable");
    const duplicates = await client.callTool("cad_get_properties", {
      document: imported.document,
      objectIds: [first.objectId, first.objectId],
      fields: ["bounds"],
    });
    assert.equal(duplicates.isError, true);
    const duplicateResult = duplicates.structuredContent;
    validateCadOutput("cad_get_properties", duplicateResult);
    if (duplicateResult.ok) assert.fail("Duplicate object IDs must be rejected by C++");
    assert.equal(duplicateResult.error.code, "INVALID_ARGUMENT");
    const repeatedFields = await call(client, "cad_get_properties", {
      document: imported.document,
      objectIds: [first.objectId],
      fields: ["bounds", "bounds"],
    });
    assert.equal(repeatedFields.items.length, 1);
    assert.equal(repeatedFields.items[0]?.bounds?.status, "exact");
    await assert.rejects(
      client.callTool("cad_get_properties", {
        document: imported.document,
        objectIds: [...propertyIds, "one-over-limit"],
        fields: ["bounds"],
      }),
      /Invalid arguments/,
    );
    const requested = await call(client, "cad_build_display", {
      document: imported.document,
      quality: "preview",
    });
    assert.ok(requested && typeof requested === "object" && "job" in requested);
    const displayState = await finish(client, requested.job as CadHandle);
    assert.equal(displayState.status, "succeeded", JSON.stringify(displayState));
    if (displayState.status !== "succeeded") assert.fail();
    assert.ok(Value.Check(CadDisplaySchema, displayState.result));
    assert.equal(displayState.result.summary.complete, true);
    const manifest: unknown = JSON.parse(
      (await readResource(workerStaging, displayState.result.manifest)).toString(),
    );
    assert.ok(Value.Check(CadManifestSchema, manifest));
    const glbDescriptor = manifest.resources.find(
      (resource) => resource.mediaType === "model/gltf-binary",
    );
    const mapDescriptor = manifest.resources.find(
      (resource) => resource.mediaType === "application/json",
    );
    assert.ok(glbDescriptor && mapDescriptor);
    const bytes = await readResource(workerStaging, glbDescriptor);
    const gltf = await new GLTFLoader().parseAsync(Uint8Array.from(bytes).buffer, "");
    gltf.scene.rotation.x = Math.PI / 2;
    gltf.scene.updateMatrixWorld(true);
    const secondNode = gltf.scene.getObjectByName("second_box");
    const namedSecond = secondNode ?? gltf.scene.getObjectByName("second box");
    assert.ok(namedSecond);
    namedSecond.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        assert.ok(material instanceof MeshStandardMaterial);
        assert.ok(
          material.color.b > material.color.r,
          "Instance color must override the shared geometry's face colors.",
        );
      }
    });
    const bounds = new Box3().setFromObject(namedSecond);
    assert.ok(Math.abs(bounds.min.x - 1.1) < 1e-6 && Math.abs(bounds.max.x - 1.9) < 1e-6);
    const faceMap: unknown = JSON.parse(
      (await readResource(workerStaging, mapDescriptor)).toString(),
    );
    assert.ok(Value.Check(CadFaceMapSchema, faceMap));
    assert.ok(faceMap.ranges.length > 6);
    gltf.scene.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      const association = gltf.parser.associations.get(object);
      assert.ok(association?.meshes !== undefined && association.primitives !== undefined);
      const ranges = faceMap.ranges
        .filter(
          (range) =>
            range.meshIndex === association.meshes &&
            range.primitiveIndex === association.primitives,
        )
        .sort((a, b) => a.firstTriangle - b.firstTriangle);
      let covered = 0;
      for (const range of ranges) {
        assert.equal(range.firstTriangle, covered, "CAD face map has a gap or overlap.");
        covered += range.triangleCount;
      }
      assert.equal(covered, (object.geometry.getIndex()?.count ?? 0) / 3);
    });
    const range = faceMap.ranges.find((range) => range.geometryId === first.geometryId);
    assert.ok(range);
    const features = await call(client, "cad_list_geometry_features", {
      document: imported.document,
      objectId: first.objectId,
      topologyRef: range.topologyRef,
      types: ["plane_center"],
    });
    assert.ok(
      features &&
        typeof features === "object" &&
        "items" in features &&
        Array.isArray(features.items),
    );
    assert.equal(features.items.length, 1);
    const distance = await call(client, "cad_measure_distance", {
      document: imported.document,
      first: { objectId: first.objectId, placement: first.localTransform },
      second: { objectId: second.objectId, placement: second.localTransform },
      limit: 1,
    });
    assert.ok(Math.abs(distance.distance - 0.3) < 1e-8);
    const rootObject = objects.find((object) => !object.parentObjectId);
    assert.ok(rootObject);
    const decomposed = await call(client, "cad_decompose_object", {
      document: imported.document,
      objectId: rootObject.objectId,
    });
    assert.equal(decomposed.parentObjectId, rootObject.objectId);
    assert.ok(decomposed.childCount > 0);
    const waited = await client.callTool("cad_wait_job", { job: requested.job });
    const queried = await client.callTool("cad_get_job", { job: requested.job });
    assert.deepEqual(waited._meta, queried._meta);
    const artifact = waited._meta?.["dai/display"];
    assert.ok(Value.Check(DisplayArtifactSchema, artifact));
    assert.equal(artifact.kind, "cad-display");
    assert.ok(
      (await client.listResources()).some((resource) => resource.uri === artifact.manifest.uri),
    );
    const cancellation = await call(client, "cad_cancel_job", { job: requested.job as CadHandle });
    assert.deepEqual(cancellation, {
      job: requested.job,
      cancelRequested: false,
      status: "succeeded",
    });
    await call(client, "cad_release_document", { document: imported.document });
    assert.equal(
      await errorCode(client, "cad_get_structure", { document: imported.document, mode: "all" }),
      "NOT_FOUND",
    );
    await access(fileURLToPath(displayState.result.manifest.uri));
    const retainedJob = await client.callTool("cad_get_job", { job: requested.job });
    assert.deepEqual(retainedJob._meta, waited._meta);
    await assert.rejects(client.listResourcesPage("invalid"), /cursor/);
    const retained = await client.readResource(displayState.result.manifest.uri);
    assert.ok(retained.contents.length);
    await assert.rejects(
      client.readResource(new URL("unregistered.json", displayState.result.manifest.uri).href),
    );
    const outside = join(root, "outside.step");
    await writeFile(outside, await readFile(path));
    const traversalJob = await call(client, "cad_import_step", {
      ...input,
      path: outside,
    });
    assert.ok(traversalJob && typeof traversalJob === "object" && "job" in traversalJob);
    const traversal = await finish(client, traversalJob.job as CadHandle);
    assert.equal(traversal.status, "failed");
    if (traversal.status === "failed") assert.equal(traversal.error.code, "PATH_OUTSIDE_PROJECT");
    if (process.platform !== "win32") {
      await symlink(outside, join(project, "linked.step"));
      const linkJob = await call(client, "cad_import_step", {
        ...input,
        path: join(project, "linked.step"),
      });
      assert.ok(linkJob && typeof linkJob === "object" && "job" in linkJob);
      const link = await finish(client, linkJob.job as CadHandle);
      assert.equal(link.status, "failed");
      if (link.status === "failed") assert.equal(link.error.code, "PATH_OUTSIDE_PROJECT");
    }
    const cancelledJob = await call(client, "cad_import_step", {
      ...input,
    });
    assert.ok(cancelledJob && typeof cancelledJob === "object" && "job" in cancelledJob);
    const cancelRequest = await call(client, "cad_cancel_job", {
      job: cancelledJob.job as CadHandle,
    });
    assert.ok(
      cancelRequest && typeof cancelRequest === "object" && "cancelRequested" in cancelRequest,
    );
    const cancelled = await finish(client, cancelledJob.job as CadHandle);
    if (cancelRequest.cancelRequested) assert.equal(cancelled.status, "cancelled");
    else assert.equal(cancelled.status, "succeeded");
    const restarted = await openCadServer(options);
    try {
      await call(restarted.client, "cad_get_capabilities", {});
      assert.equal(
        await errorCode(restarted.client, "cad_get_job", { job: cancelledJob.job as CadHandle }),
        "STALE_HANDLE",
      );
    } finally {
      await restarted.close();
    }
  } finally {
    await connection.close();
    assert.deepEqual(await readdir(staging), []);
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi stdio client connects to the official CAD server and cleans up on input EOF", {
  skip: !available,
  timeout: 15_000,
}, async () => {
  assert.ok(executable);
  const root = await mkdtemp(join(tmpdir(), "dai-cad-stdio-"));
  const config = join(root, "mcp.json");
  await writeFile(
    config,
    JSON.stringify({
      executable,
      projectRoot: root,
      stagingRoot: join(root, "staging"),
    }),
  );
  const connection = await openMcpConnection({
    kind: "stdio",
    options: {
      command: process.execPath,
      args: ["--experimental-strip-types", resolve("resources/mcp/cad/server.ts"), config],
      stderr: "pipe",
      closeTimeoutMs: 6_000,
    },
  });
  const { client } = connection;
  try {
    assert.equal((await client.listTools()).length, 12);
    await call(client, "cad_get_capabilities", {});
  } finally {
    await connection.close();
    assert.deepEqual(await readdir(join(root, "staging")), []);
    await rm(root, { recursive: true, force: true });
  }
});

test("stdio CAD close joins startup and failed native initialization", {
  skip: !available,
  timeout: 15_000,
}, async () => {
  assert.ok(executable);
  const root = await mkdtemp(join(tmpdir(), "dai-cad-close-"));
  const staging = join(root, "staging");
  try {
    const connection = await openCadServer({ executable, projectRoot: root, stagingRoot: staging });
    const pending = assert.rejects(
      connection.client.callTool("cad_get_capabilities", {}),
      /closed/i,
    );
    await Promise.all([connection.close(), connection.close()]);
    await pending;
    assert.deepEqual(await readdir(staging), []);
    const failed = await openCadServer({
      executable,
      projectRoot: join(root, "missing"),
      stagingRoot: staging,
    });
    await assert.rejects(failed.client.callTool("cad_get_capabilities", {}), /could not complete/i);
    await Promise.all([failed.close(), failed.close()]);
    assert.deepEqual(await readdir(staging), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stdio cancellation after native acceptance invalidates the unreceived job and joins its worker", {
  skip: !available,
  timeout: 15_000,
}, async () => {
  assert.ok(executable && fixture);
  const root = await mkdtemp(join(tmpdir(), "dai-cad-accept-"));
  const path = join(root, "assembly.step"),
    staging = join(root, "staging"),
    marker = join(root, "accepted");
  await run(fixture, ["--write-fixture", path]);
  const config = join(root, "config.json");
  await writeFile(config, JSON.stringify({ executable, projectRoot: root, stagingRoot: staging }));
  const connection = await openMcpConnection({
    kind: "stdio",
    options: {
      command: process.execPath,
      args: [
        "--experimental-strip-types",
        resolve("tests/fixtures/cad-acceptance.ts"),
        config,
        marker,
      ],
      closeTimeoutMs: 7000,
    },
  });
  try {
    const before = await call(connection.client, "cad_get_capabilities", {});
    const controller = new AbortController();
    const rejected = assert.rejects(
      connection.client.callTool("cad_import_step", { path }, { signal: controller.signal }),
      /abort/i,
    );
    for (let i = 0; i < 500; i++) {
      if (await readFile(marker, "utf8").catch(() => "")) break;
      await setTimeout(10);
    }
    assert.equal(await readFile(marker, "utf8"), "accepted");
    controller.abort();
    await rejected;
    const after = await call(connection.client, "cad_get_capabilities", {});
    assert.notEqual(after.serverInstanceId, before.serverInstanceId);
    await connection.close();
    assert.deepEqual(await readdir(staging), []);
  } finally {
    await connection.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("retained display outputs share one native byte budget and survive a rejected new display", {
  skip: !available,
  timeout: 15_000,
}, async () => {
  assert.ok(executable && fixture);
  const root = await mkdtemp(join(tmpdir(), "dai-cad-budget-"));
  const path = join(root, "assembly.step");
  await run(fixture, ["--write-fixture", path]);
  let budget = 0;
  const initial = await openCadServer({
    executable,
    projectRoot: root,
    stagingRoot: join(root, "initial"),
  });
  try {
    const imported = await accepted(initial.client, { path });
    const display = await call(initial.client, "cad_build_display", {
      document: imported.document,
      quality: "preview",
    });
    const state = await finish(initial.client, display.job);
    assert.equal(state.status, "succeeded");
    assert.ok(state.status === "succeeded" && state.kind === "display");
    const manifest = JSON.parse(await readFile(fileURLToPath(state.result.manifest.uri), "utf8"));
    assert.ok(Value.Check(CadManifestSchema, manifest));
    budget =
      manifest.resources.reduce(
        (sum, resource) => sum + resource.byteLength,
        state.result.manifest.byteLength,
      ) + 1024;
  } finally {
    await initial.close();
  }
  const limited = await openCadServer({
    executable,
    projectRoot: root,
    stagingRoot: join(root, "limited"),
    limits: { maxTotalResourceBytes: budget },
  });
  try {
    const imported = await accepted(limited.client, { path });
    const first = await call(limited.client, "cad_build_display", {
      document: imported.document,
      quality: "preview",
    });
    const good = await finish(limited.client, first.job);
    assert.ok(good.status === "succeeded" && good.kind === "display", JSON.stringify(good));
    const next = await call(limited.client, "cad_build_display", {
      document: imported.document,
      quality: "preview",
    });
    const failed = await finish(limited.client, next.job);
    assert.equal(failed.status, "failed");
    assert.ok(failed.status === "failed");
    assert.equal(failed.error.code, "LIMIT_EXCEEDED");
    const result = await limited.client.callTool("cad_get_job", { job: next.job });
    assert.equal(result._meta, undefined);
    await call(limited.client, "cad_release_document", { document: imported.document });
    assert.ok((await limited.client.readResource(good.result.manifest.uri)).contents.length);
  } finally {
    await limited.close();
    await rm(root, { recursive: true, force: true });
  }
});
