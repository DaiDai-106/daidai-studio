import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";
import type { CadHandle, CadOutput, CadProperty } from "../../resources/mcp/cad/contract.ts";
import { openBuiltinMcp } from "../../src/backend/mcp/builtin.ts";
import { openRuntime } from "../../src/backend/runtime.ts";
import type { ApplicationEvent } from "../../src/shared/application.ts";
import { currentDisplayId, planCadImport, sceneContext } from "../support/cadPlan.ts";
import { servePlanner, turnResults } from "../support/planner.ts";

const cad = process.env.DAI_CAD_TEST_WORKER,
  fixture = process.env.DAI_CAD_TEST_FIXTURE,
  alignment = process.env.DAI_ALIGNMENT_TEST_WORKER;

test("saved-scene inspection works without CAD; temporary original-geometry queries preserve the displayed model and pose", {
  skip: !cad || !fixture || !alignment,
  timeout: 30_000,
}, async () => {
  assert.ok(cad && fixture && alignment);
  const root = await mkdtemp(join(tmpdir(), "dai-inspection-")),
    projectPath = join(root, "project");
  await mkdir(projectPath);
  const source = join(projectPath, "assembly.step");
  await promisify(execFile)(fixture, ["--write-fixture", source]);
  const original = await readFile(source);
  let firstDocument: CadHandle | undefined;
  const events: ApplicationEvent[] = [];
  const planner = await servePlanner((request) => {
    const results = turnResults(request),
      state = sceneContext(request);
    const user = request.messages
      .filter((message) => message.role === "user" && typeof message.content === "string")
      .at(-1)?.content;
    if (user?.startsWith("分析选中对象\n\n用户引用的场景对象：")) {
      const reference = JSON.parse(user.split("用户引用的场景对象：", 2)[1] ?? "{}") as {
        importId: string;
        objectId: string;
        revision: number;
        name: string;
      };
      assert.equal(reference.importId, state.currentDisplay?.importId);
      assert.equal(reference.revision, state.currentDisplay?.placement?.revision);
      assert.ok(reference.objectId);
      assert.equal(typeof reference.name, "string");
      return { text: "已收到引用对象" };
    }
    if (user === "导入并旋转") {
      const next = planCadImport(request, "preview", true);
      if (next) return next;
      firstDocument = results.read<{ data: { result: { document: CadHandle } } }>("cad-import-wait")
        .data.result.document;
      if (!results.has("rotate"))
        return {
          id: "rotate",
          name: "alignment_rotate",
          args: {
            importId: currentDisplayId(request),
            expectedRevision: state.currentDisplay?.placement?.revision,
            axis: [1, 0, 0],
            angleDegrees: 90,
            pivot: [0, 0, 0],
            space: "world",
          },
        };
      assert.equal(results.read<{ ok: boolean }>("rotate").ok, true);
      return { text: "Display ready" };
    }
    assert.ok(state.currentDisplay && state.files?.manifest);
    if (user === "视口插件已停用") {
      assert.ok(!(request.tools ?? []).some((tool) => tool.function.name === "viewport_capture"));
      return { text: "视口插件未启用" };
    }
    if (user === "观察视口") {
      if (!request.messages.some((message) => message.tool_call_id === "capture"))
        return {
          id: "capture",
          name: "viewport_capture",
          args: {
            importId: state.currentDisplay.importId,
            revision: state.currentDisplay.placement.revision,
          },
        };
      assert.match(JSON.stringify(request.messages), /data:image\/png;base64,/);
      return { text: "已收到截图" };
    }
    if (user === "观察摘要") {
      if (!results.has("summary"))
        return {
          id: "summary",
          name: "scene_inspect",
          args: { importId: state.currentDisplay.importId, limit: 1 },
        };
      const summary = results.read<{
        objectCount: number;
        nextOffset?: number;
        objects: { objectId: string }[];
        bounds: { min: number[] };
      }>("summary");
      assert.ok(
        summary.objectCount > 0 && summary.objects.length === 1 && summary.bounds.min.length === 3,
      );
      if (summary.objectCount > 1) assert.equal(summary.nextOffset, 1);
      if (!results.has("page"))
        return {
          id: "page",
          name: "scene_inspect",
          args: { importId: state.currentDisplay.importId, limit: 20 },
        };
      const page = results.read<{ objects: { objectId: string; kind: string }[] }>("page");
      const shape = page.objects.find((object) => object.kind === "shape");
      assert.ok(shape);
      if (!results.has("detail"))
        return {
          id: "detail",
          name: "scene_inspect",
          args: {
            importId: state.currentDisplay.importId,
            objectIds: [shape.objectId],
          },
        };
      const detail = results.read<{
        objects: { objectId: string; features: unknown[]; featureCount: number }[];
      }>("detail");
      assert.equal(detail.objects[0]?.objectId, shape.objectId);
      assert.ok(Array.isArray(detail.objects[0]?.features));
      assert.ok((detail.objects[0]?.featureCount ?? 0) > 0);
      assert.ok((detail.objects[0]?.features.length ?? 0) > 0);
      if (!results.has("missing-object"))
        return {
          id: "missing-object",
          name: "scene_inspect",
          args: { importId: state.currentDisplay.importId, objectIds: ["missing-object"] },
        };
      assert.equal(
        results.read<{ error: { code: string } }>("missing-object").error.code,
        "OBJECT_NOT_FOUND",
      );
      return { text: "摘要已读取" };
    }
    if (user === "检查缺失清单") {
      assert.equal(state.files.catalogError?.code, "MANIFEST_MISSING");
      assert.deepEqual(state.files.objects, []);
      assert.ok(state.currentDisplay.importId);
      return { text: "清单缺失，保留当前保存模型和定位；未自动导入。" };
    }
    if (
      user === "我看场景里还有一个机械臂是么" ||
      user === "查询现有场景的对象信息" ||
      user === "CAD启用时查询场景"
    ) {
      assert.ok(request.tools?.some((tool) => tool.function.name === "read"));
      assert.ok(
        request.tools?.some((tool) => tool.function.name.startsWith("cad_")) ===
          (user === "CAD启用时查询场景"),
        "Saved inspection works independently of CAD availability",
      );
      if (!results.has("saved-scene"))
        return {
          id: "saved-scene",
          name: "read",
          args: { path: state.files.objects[0]?.path },
        };
      const content =
        request.messages.find((message) => message.tool_call_id === "saved-scene")?.content ?? "";
      assert.ok(content.includes('"objectId"') && content.includes('"name"'));
      return { text: "已查看保存的对象信息；名称不足以确认机械臂。" };
    }
    assert.equal(user, "查询原始CAD的拓扑统计，保留当前显示");
    if (!results.has("saved-references"))
      return {
        id: "saved-references",
        name: "read",
        args: { path: state.files.references[0]?.path },
      };
    const referenceText = request.messages
      .find((message) => message.tool_call_id === "saved-references")
      ?.content?.split("\n<harness>\n")[0];
    assert.ok(referenceText);
    const references = referenceText
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { objectId: string; sourceKey: string });
    if (!results.has("open-original"))
      return {
        id: "open-original",
        name: "cad_import_step",
        args: { path: state.selectedSourcePath },
      };
    if (!results.has("wait-original"))
      return {
        id: "wait-original",
        name: "cad_wait_job",
        args: { job: results.read<{ data: { job: CadHandle } }>("open-original").data.job },
      };
    const document = results.read<{ data: { result: { document: CadHandle } } }>("wait-original")
      .data.result.document;
    assert.notEqual(
      document.serverInstanceId,
      firstDocument?.serverInstanceId,
      "A new run uses a fresh temporary CAD service",
    );
    if (!results.has("structure"))
      return {
        id: "structure",
        name: "cad_get_structure",
        args: { document, mode: "all", limit: 20 },
      };
    const shape = results
      .read<{ data: CadOutput<"cad_get_structure"> }>("structure")
      .data.items.find((item) => item.kind === "shape");
    assert.ok(shape);
    const savedObject = references.find((item) => item.sourceKey === shape.sourceKey);
    assert.ok(
      savedObject,
      "Match an explicitly requested temporary query to saved objects by sourceKey",
    );
    assert.notEqual(
      savedObject.objectId,
      shape.objectId,
      "Temporary IDs belong to the new CAD document",
    );
    if (!results.has("topology"))
      return {
        id: "topology",
        name: "cad_get_properties",
        args: { document, objectIds: [shape.objectId], fields: ["topology"] },
      };
    const topology = results.read<{ data: { items: CadProperty[] } }>("topology").data.items[0]
      ?.topology;
    assert.equal(topology?.status, "exact");
    if (topology?.status === "exact") assert.ok(topology.value.faceCount > 0);
    if (!results.has("release"))
      return { id: "release", name: "cad_release_document", args: { document } };
    assert.equal(results.read<{ ok: boolean }>("release").ok, true);
    return { text: "Original geometry inspected; current display preserved" };
  });
  const vault = { available: false, read: async () => "{}", write: async () => {} };
  const paths = {
    cadExecutable: cad,
    alignmentExecutable: alignment,
    skillsRoot: resolve("resources/skills"),
  };
  let app: Awaited<ReturnType<typeof openRuntime>>;
  const publish = (event: ApplicationEvent) => {
    events.push(event);
    if (event.type === "viewport.capture")
      void app.request("viewport.respond", {
        id: event.id,
        capture: {
          image: {
            mimeType: "image/png",
            data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a04AAAAASUVORK5CYII=",
          },
          camera: {
            position: [3, -3, 2],
            target: [0, 0, 0],
            up: [0, 0, 1],
            projection: "perspective",
          },
        },
      });
  };
  app = await openRuntime(root, vault, publish, paths);
  async function send(
    id: string,
    text: string,
    sceneReference?: import("../../src/shared/application.ts").SceneReference,
  ) {
    const start = (await app.request("conversation.watch", { id })).messages.length;
    await app.request("conversation.send", {
      id,
      requestId: crypto.randomUUID(),
      text,
      ...(sceneReference ? { sceneReference } : {}),
    });
    for (let i = 0; i < 500; i++) {
      assert.deepEqual(planner.failures, []);
      if (!(await app.request("workspace.get", {})).busyConversationId) {
        const view = await app.request("conversation.watch", { id });
        assert.equal(view.error, "");
        return view.messages.slice(start);
      }
      await setTimeout(10);
    }
    assert.fail("Inspection run did not settle");
  }
  try {
    await app.request("provider.save", {
      config: {
        id: "test",
        providerType: "local",
        name: "Inspection test",
        authMethod: "none",
        endpoint: planner.endpoint,
        enabled: true,
        persistCredentials: false,
        models: [
          {
            id: "test",
            name: "Test",
            context: 128000,
            output: 1000,
            reasoning: "标准",
            supportsImages: true,
          },
        ],
      },
    });
    const project = await app.request("project.open", { path: projectPath });
    const conversation = await app.request("conversation.create", { projectId: project.id });
    const id = conversation.id;
    await app.request("conversation.update", { id, mode: "scene" });
    await app.request("conversation.selectStep", { id, relativePath: "assembly.step" });
    await send(id, "导入并旋转");
    const before = await app.request("display.get", { id });
    assert.ok(before?.placement && before.placement.revision > 0);
    const manifest = JSON.parse(
      await readFile(
        join(root, "projects", project.id, "artifacts", before.importId, "manifest.json"),
        "utf8",
      ),
    ) as { objects: { objectId: string; name: string }[] };
    const object = manifest.objects[0];
    assert.ok(object);
    const reference = {
      importId: before.importId,
      objectId: object.objectId,
      revision: before.placement.revision,
    };
    const referenced = await send(id, "分析选中对象", reference);
    assert.ok(
      referenced.some(
        (message) => message.role === "user" && message.text.includes(object.objectId),
      ),
    );
    await assert.rejects(
      app.request("conversation.send", {
        id,
        requestId: crypto.randomUUID(),
        text: "分析选中对象",
        sceneReference: { ...reference, revision: reference.revision - 1 },
      }),
      /版本已变化/,
    );
    await assert.rejects(
      app.request("conversation.send", {
        id,
        requestId: crypto.randomUUID(),
        text: "分析选中对象",
        sceneReference: { ...reference, objectId: "missing" },
      }),
      /不属于当前场景/,
    );
    const plugin = await openBuiltinMcp(
      resolve("resources/mcp/alignment/server.ts"),
      { executable: alignment, sceneRoot: join(root, "projects", project.id) },
      join(root, "plugin-test"),
    );
    try {
      assert.ok(plugin.tools.some((tool) => tool.name === "scene_inspect"));
      const result = await plugin.client.callTool("scene_inspect", {
        importId: before.importId,
        limit: 1,
      });
      assert.equal(result.isError, undefined);
      const data = result.structuredContent as {
        importId: string;
        revision: number;
        objects: unknown[];
      };
      assert.equal(data.importId, before.importId);
      assert.equal(data.revision, before.placement.revision);
      assert.equal(data.objects.length, 1);
      const preview = await plugin.client.callTool("alignment_rotate", {
        importId: before.importId,
        expectedRevision: before.placement.revision,
        preview: true,
        axis: [0, 0, 1],
        angleDegrees: 90,
        pivot: [0, 0, 0],
        space: "world",
      });
      assert.equal(preview.isError, undefined);
      assert.equal(preview._meta?.["dai/placement"], undefined);
      assert.equal(
        (preview.structuredContent as { data: { preview: boolean } }).data.preview,
        true,
      );
      const stalePreview = await plugin.client.callTool("alignment_rotate", {
        importId: before.importId,
        expectedRevision: 0,
        preview: true,
        axis: [0, 0, 1],
        angleDegrees: 90,
        pivot: [0, 0, 0],
        space: "world",
      });
      assert.equal(stalePreview.isError, true);
      assert.equal(
        (stalePreview.structuredContent as { error: { code: string } }).error.code,
        "REVISION_CONFLICT",
      );
      assert.ok(plugin.tools.some((tool) => tool.name === "scene_find_features"));
      const candidates = await plugin.client.callTool("scene_find_features", {
        importId: before.importId,
        type: "plane_center",
        worldAxis: "Z",
        limit: 1,
      });
      assert.equal(candidates.isError, undefined);
      assert.equal(candidates._meta?.["dai/placement"], undefined);
      const found = candidates.structuredContent as {
        importId: string;
        revision: number;
        features: { objectId: string; featureId: string }[];
      };
      assert.equal(found.importId, before.importId);
      assert.equal(found.revision, before.placement.revision);
      assert.ok(found.features[0]?.objectId && found.features[0]?.featureId);
    } finally {
      await plugin.close();
    }
    const summary = await send(id, "观察摘要");
    assert.deepEqual(
      summary.filter((message) => message.role === "tool").map((message) => message.tool?.name),
      ["scene_inspect", "scene_inspect", "scene_inspect", "scene_inspect"],
    );
    assert.ok(
      summary
        .filter((message) => message.tool?.name === "scene_inspect")
        .every((message) => message.tool?.serverName === "alignment-mcp"),
    );
    assert.deepEqual(await app.request("display.get", { id }), before);
    const capture = await send(id, "观察视口");
    assert.deepEqual(
      capture.filter((message) => message.role === "tool").map((message) => message.tool?.name),
      ["viewport_capture"],
    );
    assert.equal(
      capture.find((message) => message.tool?.name === "viewport_capture")?.tool?.serverName,
      "viewport-mcp",
    );
    assert.equal(
      capture.find((message) => message.tool?.name === "viewport_capture")?.images?.[0]?.mimeType,
      "image/png",
    );
    await app.request("capability.setEnabled", { id: "builtin.viewport", enabled: false });
    await send(id, "视口插件已停用");
    await app.request("capability.setEnabled", { id: "builtin.viewport", enabled: true });
    const displayEvents = events.filter((event) => event.type === "display.changed").length;
    const placementPath = join(
      root,
      "projects",
      project.id,
      "placements",
      `${before.importId}.json`,
    );
    const savedPose = await readFile(placementPath);
    await app.close();
    app = await openRuntime(root, vault, (event) => events.push(event), paths);
    // Simulate an older import that has no derived catalogue; no STEP reparse is needed.
    const artifactRoot = join(root, "projects", project.id, "artifacts", before.importId);
    for (const file of await readdir(artifactRoot))
      if (/^(objects|references)-/.test(file)) await rm(join(artifactRoot, file));
    await app.request("capability.setEnabled", { id: "builtin.cad", enabled: false });
    const question = await send(id, "我看场景里还有一个机械臂是么");
    assert.deepEqual(
      question.filter((message) => message.role === "tool").map((message) => message.tool?.name),
      ["read"],
    );
    assert.deepEqual(await app.request("display.get", { id }), before);
    await app.request("capability.setEnabled", { id: "builtin.cad", enabled: true });
    const enabledQuery = await send(id, "CAD启用时查询场景");
    assert.deepEqual(
      enabledQuery
        .filter((message) => message.role === "tool")
        .map((message) => message.tool?.name),
      ["read"],
    );
    const exact = await send(id, "查询原始CAD的拓扑统计，保留当前显示");
    assert.deepEqual(
      exact.filter((message) => message.role === "tool").map((message) => message.tool?.name),
      [
        "read",
        "cad_import_step",
        "cad_wait_job",
        "cad_get_structure",
        "cad_get_properties",
        "cad_release_document",
      ],
    );
    assert.deepEqual(await app.request("display.get", { id }), before);
    assert.ok((await readFile(placementPath)).equals(savedPose));
    assert.ok((await readFile(source)).equals(original));
    assert.equal(
      events.filter((event) => event.type === "display.changed").length,
      displayEvents,
      "Inspection must not publish display or placement changes",
    );
    assert.equal(
      (await readdir(join(root, "projects", project.id, "artifacts"))).filter((name) =>
        /^[a-f0-9]{64}$/.test(name),
      ).length,
      1,
    );
    await app.request("capability.setEnabled", { id: "builtin.cad", enabled: false });
    await rm(source);
    const missing = await send(id, "查询现有场景的对象信息");
    assert.deepEqual(
      missing.filter((message) => message.role === "tool").map((message) => message.tool?.name),
      ["read"],
    );
    const after = await app.request("display.get", { id });
    assert.equal(after?.sourceStatus, "missing");
    assert.equal(after?.importId, before.importId);
    assert.deepEqual(after?.placement, before.placement);
    assert.ok((await readFile(placementPath)).equals(savedPose));
    const manifestPath = join(artifactRoot, "manifest.json");
    await rename(manifestPath, `${manifestPath}.missing`);
    await send(id, "检查缺失清单");
    assert.equal((await app.request("display.get", { id }))?.importId, before.importId);
    assert.ok((await readFile(placementPath)).equals(savedPose));
    await rename(`${manifestPath}.missing`, manifestPath);
  } finally {
    await app.close();
    await planner.close();
    await rm(root, { recursive: true, force: true });
  }
});
