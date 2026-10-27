import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Mesh } from "three";
import type { CadFaceMap, CadHandle, CadManifest } from "../../resources/mcp/cad/contract.ts";
import {
  type CadInput,
  type CadToolName,
  validateCadOutput,
} from "../../resources/mcp/cad/contract.ts";
import {
  prepareDisplayArtifact,
  readPreparedDisplay,
} from "../../src/backend/artifacts/prepare.ts";
import { CurrentDisplayDoc, ImportedModelDoc } from "../../src/backend/artifacts/store.ts";
import { validateGeometry, validateManifest } from "../../src/backend/artifacts/validation.ts";
import { fileHash } from "../../src/backend/projects/source.ts";
import { openRuntime } from "../../src/backend/runtime.ts";
import { visibleGeometryBounds } from "../../src/renderer/scene/bounds.ts";
import { loadDisplay } from "../../src/renderer/scene/model.ts";
import type { ApplicationEvent } from "../../src/shared/application.ts";
import { planCadImport } from "../support/cadPlan.ts";
import { openCadServer } from "../support/cadServer.ts";
import { servePlanner, turnResults } from "../support/planner.ts";

const executable = process.env.DAI_CAD_TEST_WORKER;
const fixture = process.env.DAI_CAD_TEST_FIXTURE;

test("real Harness display results persist once, load CAD geometry, and recover without model or CAD replay", {
  skip: !executable || !fixture,
  timeout: 30000,
}, async () => {
  assert.ok(executable && fixture);
  const root = await mkdtemp(join(tmpdir(), "dai-display-"));
  const projectPath = join(root, "project");
  await mkdir(projectPath);
  await promisify(execFile)(fixture, ["--write-fixture", join(projectPath, "assembly.step")]);
  await mkdir(join(projectPath, ".daidai"));
  await writeFile(join(projectPath, ".daidai", "existing.txt"), "old project data");
  const planner = await servePlanner((request) => {
    const existing = turnResults(request);
    if (
      existing.has("cad-import-wait") &&
      existing.read<{ data: { status: string } }>("cad-import-wait").data.status === "failed"
    )
      return { text: "导入失败，保留上次显示。" };
    const next = planCadImport(request);
    if (next) return next;
    const results = turnResults(request);
    if (!results.has("display-repeat"))
      return {
        id: "display-repeat",
        name: "cad_get_job",
        args: { job: results.read<{ data: { job: CadHandle } }>("cad-display").data.job },
      };
    if (!results.has("release"))
      return {
        id: "release",
        name: "cad_release_document",
        args: {
          document: results.read<{ data: { result: { document: CadHandle } } }>("cad-import-wait")
            .data.result.document,
        },
      };
    return { text: "真实显示资源已生成。" };
  });
  const events: ApplicationEvent[] = [];
  const open = () =>
    openRuntime(
      root,
      { available: false, read: async () => "{}", write: async () => {} },
      (event) => events.push(event),
      { nativeDirectory: dirname(executable), skillsRoot: resolve("resources/skills") },
    );
  let app = await open();
  try {
    await app.request("provider.save", {
      config: {
        id: "local",
        name: "test",
        providerType: "local",
        authMethod: "none",
        enabled: true,
        persistCredentials: false,
        endpoint: planner.endpoint,
        models: [{ id: "test", name: "test", context: 128000, output: 2048, reasoning: "标准" }],
      },
    });
    const project = await app.request("project.open", { path: projectPath });
    const conversation = await app.request("conversation.create", { projectId: project.id });
    const id = conversation.id;
    await app.request("conversation.update", { id, mode: "scene" });
    await app.request("conversation.selectStep", { id, relativePath: "assembly.step" });
    assert.equal(await app.request("display.get", { id }), null);
    await app.request("conversation.send", { id, requestId: "display", text: "导入当前 STEP" });
    for (
      let attempt = 0;
      (await app.request("workspace.get", {})).busyConversationId && attempt < 500;
      attempt++
    )
      await setTimeout(20);
    assert.equal((await app.request("workspace.get", {})).busyConversationId, null);
    const model = await app.request("display.get", { id });
    assert.ok(model, JSON.stringify((await app.request("conversation.watch", { id })).messages));
    assert.equal(model.sourceStatus, "current");
    assert.equal(events.filter((event) => event.type === "display.changed").length, 1);
    assert.equal((await readdir(join(root, "projects", project.id, "artifacts"))).length, 1);
    assert.deepEqual(await readdir(join(projectPath, ".daidai")), ["existing.txt"]);
    assert.equal(
      await readFile(join(projectPath, ".daidai", "existing.txt"), "utf8"),
      "old project data",
    );
    assert.deepEqual(await readdir(join(root, "tmp")), []);
    assert.ok(Number(model.producerTaskId) > 0 && Number(model.producerEntryId) > 0);

    // Node substitutes only the browser's dai-resource transport, using the real backend authorization.
    const fetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      const file = await app.resolveResource(url.hostname, url.pathname.slice(1));
      return new Response(await readFile(file.path), {
        headers: { "Content-Type": file.mediaType },
      });
    };
    try {
      const loaded = await loadDisplay(model, new AbortController().signal);
      try {
        const bounds = visibleGeometryBounds(loaded.root);
        assert.ok(Math.abs(bounds.max.x - 1.9) < 1e-5);
        assert.ok(Math.abs(bounds.max.z - 0.5) < 1e-5, "GLB Y-up is restored to CAD Z-up");
        const identities = new Set<string>();
        loaded.root.traverse((object) => {
          if (!(object instanceof Mesh)) return;
          identities.add(object.userData.sceneObjectId);
        });
        assert.equal(
          identities.size,
          3,
          "Repeated geometry instances remain separately selectable",
        );
      } finally {
        loaded.dispose();
      }
    } finally {
      globalThis.fetch = fetch;
    }
    await assert.rejects(app.resolveResource(model.importId, "../app.sqlite"));
    const second = await app.request("conversation.create", { projectId: project.id });
    assert.equal((await app.request("display.get", { id: second.id }))?.importId, model.importId);
    const requests = planner.requests.length;
    await app.close();

    // Reproduce the exact persistence gap: successful tool entries/files exist, their indexes do not.
    const storage = await openNodeSqliteStorage(join(root, "app.sqlite"));
    const harness = await Harness.open(
      storage,
      { models: createModels(), registry: createRegistry() },
      context,
    );
    await harness.commit(async (tx) => {
      await tx.retireDoc(CurrentDisplayDoc, model.sourceId);
      await tx.retireDoc(ImportedModelDoc, model.importId);
    }, context);
    await harness.close(context);
    app = await open();
    assert.equal((await app.request("display.get", { id }))?.importId, model.importId);
    assert.equal(planner.requests.length, requests, "Recovery must not replay a model request");
    assert.deepEqual(await readdir(join(root, "tmp")), []);
    await writeFile(join(projectPath, "assembly.step"), "changed after import");
    assert.equal((await app.request("display.get", { id }))?.sourceStatus, "changed");
    const notifications = events.filter((event) => event.type === "display.changed").length;
    await app.request("conversation.send", {
      id,
      requestId: "failed-import",
      text: "再次导入当前 STEP",
    });
    for (
      let attempt = 0;
      (await app.request("workspace.get", {})).busyConversationId && attempt < 500;
      attempt++
    )
      await setTimeout(20);
    assert.equal((await app.request("display.get", { id }))?.importId, model.importId);
    assert.equal(events.filter((event) => event.type === "display.changed").length, notifications);
    await unlink(join(projectPath, "assembly.step"));
    assert.equal((await app.request("display.get", { id }))?.sourceStatus, "missing");
    const resource = await app.resolveResource(model.importId, model.manifest.id);
    assert.ok(
      (await readFile(resource.path)).length > 0,
      "Saved display does not depend on the original STEP",
    );
  } finally {
    await app.close();
    await planner.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("prepared CAD files alone never publish a display; invalid or cancelled artifacts are refused", {
  skip: !executable || !fixture,
  timeout: 20000,
}, async () => {
  assert.ok(executable && fixture);
  const root = await mkdtemp(join(tmpdir(), "dai-display-prepare-"));
  const path = join(root, "assembly.step");
  await promisify(execFile)(fixture, ["--write-fixture", path]);
  const connection = await openCadServer({
    executable,
    projectRoot: root,
    stagingRoot: join(root, "plugin"),
  });
  let app = await openRuntime(
    join(root, "data"),
    { available: false, read: async () => "{}", write: async () => {} },
    () => {},
  );
  async function call<K extends CadToolName>(name: K, input: CadInput<K>) {
    const value = await connection.client.callTool(name, { ...input });
    const envelope = value.structuredContent;
    validateCadOutput(name, envelope);
    assert.ok(envelope.ok);
    return { data: envelope.data, metadata: value._meta };
  }
  try {
    const project = await app.request("project.open", { path: root });
    const conversation = await app.request("conversation.create", { projectId: project.id });
    const selected = await app.request("conversation.selectStep", {
      id: conversation.id,
      relativePath: "assembly.step",
    });
    assert.ok(selected.source);
    const run = {
      conversationId: conversation.id,
      project,
      source: { ...selected.source, path, sha256: (await fileHash(path, 1024 * 1024)).sha256 },
      skill: null,
      sourceId: selected.source.id,
      selectedSourcePath: path,
    };
    const imported = await call("cad_import_step", { path });
    const state = await call("cad_wait_job", { job: imported.data.job });
    assert.ok(state.data.status === "succeeded" && state.data.kind === "import");
    const display = await call("cad_build_display", {
      document: state.data.result.document,
      quality: "preview",
    });
    const complete = await call("cad_wait_job", { job: display.data.job });
    const artifact = complete.metadata?.["dai/display"];
    const signal = new AbortController().signal;
    await assert.rejects(
      prepareDisplayArtifact(
        artifact,
        { ...connection, root: join(root, "data") },
        run,
        signal,
        root,
      ),
      /授权目录/,
    );
    await assert.rejects(
      prepareDisplayArtifact(
        artifact,
        connection,
        { ...run, source: { ...run.source, sha256: "0".repeat(64) } },
        signal,
        root,
      ),
      /版本不匹配/,
    );
    const valid = artifact as { manifest: { sha256: string } };
    await assert.rejects(
      prepareDisplayArtifact(
        { ...valid, manifest: { ...valid.manifest, sha256: "0".repeat(64) } },
        connection,
        run,
        signal,
        root,
      ),
      /清单校验/,
    );
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      prepareDisplayArtifact(artifact, connection, run, controller.signal, root),
      {
        name: "AbortError",
      },
    );
    const ref = await prepareDisplayArtifact(artifact, connection, run, signal, root);
    const saved = await readPreparedDisplay(root, ref.importId);
    const bundle = join(root, "artifacts", ref.importId);
    const manifest = JSON.parse(
      await readFile(join(bundle, "manifest.json"), "utf8"),
    ) as CadManifest;
    const glb = saved.files.find((file) => file.mediaType === "model/gltf-binary");
    const map = saved.files.find(
      (file) => file.file.startsWith("resources/") && file.mediaType === "application/json",
    );
    assert.ok(glb && map);
    const mapping = JSON.parse(await readFile(join(bundle, map.file), "utf8")) as CadFaceMap;
    const firstFace = mapping.ranges[0];
    assert.ok(firstFace);
    const partial: CadManifest = {
      ...manifest,
      complete: false,
      omittedFaceCount: 1,
      objects: manifest.objects.map((object) =>
        object.geometryId === firstFace.geometryId && object.display
          ? { ...object, display: { ...object.display, omittedFaceCount: 1 } }
          : object,
      ),
    };
    validateManifest(partial, run.source);
    const altered = join(root, "altered-faces.json");
    await writeFile(
      altered,
      JSON.stringify({
        ...mapping,
        omittedFaces: [{ geometryId: firstFace.geometryId, topologyRef: firstFace.topologyRef }],
      }),
    );
    await assert.rejects(
      validateGeometry(join(bundle, glb.file), glb.byteLength, partial, altered),
      /仍包含在显示网格/,
    );
    await writeFile(altered, JSON.stringify({ ...mapping, omittedFaces: [] }));
    await assert.rejects(
      validateGeometry(join(bundle, glb.file), glb.byteLength, partial, altered),
      /排除面清单/,
    );
    assert.throws(
      () => validateManifest({ ...partial, complete: true }, run.source),
      /完整性不一致/,
    );
    assert.throws(
      () => validateManifest({ ...partial, omittedFaceCount: undefined }, run.source),
      /面排除记录/,
    );
    const legacy = {
      ...manifest,
      omittedFaceCount: undefined,
      objects: manifest.objects.map(({ display: _display, ...object }) => object),
    };
    validateManifest(legacy, run.source);
    await connection.close();
    assert.ok((await readPreparedDisplay(root, ref.importId)).files.length > 0);
    assert.equal(await app.request("display.get", { id: conversation.id }), null);
    await assert.rejects(app.resolveResource(ref.importId, "0".repeat(64)));
    await app.close();
    app = await openRuntime(
      join(root, "data"),
      { available: false, read: async () => "{}", write: async () => {} },
      () => {},
    );
    assert.equal(
      await app.request("display.get", { id: conversation.id }),
      null,
      "Recovery needs a committed successful tool result, not just files",
    );
  } finally {
    await app.close();
    await connection.close();
    await rm(root, { recursive: true, force: true });
  }
});
