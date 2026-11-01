import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { openApplication } from "../../src/backend/application.ts";

const python = process.env.DAI_SCENE_TEST_PYTHON;
const exec = promisify(execFile);

test("真实圆柱几何按对象分页传给 Pi，且不会宣称已识别关节", {
  skip: !python,
  timeout: 90_000,
}, async () => {
  if (!python) return;
  const root = await mkdtemp(join(tmpdir(), "dai-cylinder-workflow-"));
  const dataRoot = join(root, "data");
  const source = join(root, "external.step");
  const originalFetch = globalThis.fetch;
  let finished!: () => void;
  const done = new Promise<void>((resolve) => {
    finished = resolve;
  });
  let app: Awaited<ReturnType<typeof openApplication>> | undefined;
  try {
    await exec(
      python,
      [
        "-c",
        "import sys; sys.path.insert(0,'tests/python'); from assembly_fixture import write_cylinder_assembly; write_cylinder_assembly(sys.argv[1])",
        source,
      ],
      { cwd: resolve(".") },
    );
    app = await openApplication({
      dataRoot,
      workerPath: resolve("packages/scene/python/worker.py"),
      pythonExecutable: python,
      sceneSkillPath: resolve("packages/scene/skills/scene"),

      publish: (event) => {
        if (event.type === "conversation" && !event.view.busy) finished();
      },
    });
    const project = await app.request("project.create", {
      name: "场景",
      mode: "scene",
      path: root,
    });
    const scene = await app.request("scene.import", {
      projectId: project.id,
      path: source,
      operation: "replace",
      revision: 0,
    });
    const model = scene.models[0];
    const object = model?.objects.find((item) => item.cylinderCandidates?.length);
    assert.ok(model && object);
    const other = model.objects.find(
      (item) => item.id !== object.id && item.cylinderCandidates?.length,
    );
    assert.ok(other && object.cylinderCandidates?.[0] && other.cylinderCandidates?.[0]);
    const firstFace = object.cylinderCandidates[0].faceIndex;
    const secondFace = other.cylinderCandidates[0].faceIndex;
    assert.equal(object.cylinderCandidates?.[0]?.kinematics, "unknown");
    assert.equal(object.cylinderCandidates?.[0]?.unit, "m");
    await app.request("provider.save", {
      config: {
        id: "local",
        name: "Local",
        providerType: "local",
        authMethod: "none",
        endpoint: "http://127.0.0.1:11434/v1",
        enabled: true,

        models: [
          { id: "example", name: "Example", context: 4096, output: 1024, reasoning: "标准" },
        ],
      },
    });
    let requests = 0;
    let secondRequest = "";
    let thirdRequest = "";
    globalThis.fetch = async (_input, init) => {
      requests++;
      if (requests === 2) secondRequest = String(init?.body ?? "");
      if (requests === 3) thirdRequest = String(init?.body ?? "");
      const delta =
        requests === 1
          ? {
              tool_calls: [
                {
                  index: 0,
                  id: "cylinder",
                  type: "function",
                  function: {
                    name: "scene_get_cylinders",
                    arguments: JSON.stringify({
                      modelId: model.id,
                      objectId: object.id,
                      offset: 0,
                      limit: 1,
                    }),
                  },
                },
              ],
            }
          : requests === 2
            ? {
                tool_calls: [
                  {
                    index: 0,
                    id: "compare",
                    type: "function",
                    function: {
                      name: "scene_compare_cylinder_axes",
                      arguments: JSON.stringify({
                        revision: scene.revision,
                        firstModelId: model.id,
                        firstObjectId: object.id,
                        firstFaceIndex: firstFace,
                        secondModelId: model.id,
                        secondObjectId: other.id,
                        secondFaceIndex: secondFace,
                        angleRad: 0.01,
                        distanceM: 0.001,
                      }),
                    },
                  },
                ],
              }
            : { role: "assistant", content: "已读取几何候选" };
      const chunk = (value: object, reason: string | null) =>
        `data: ${JSON.stringify({ id: "r", object: "chat.completion.chunk", created: 1, model: "example", choices: [{ index: 0, delta: value, finish_reason: reason }] })}\n\n`;
      return new Response(
        `${chunk(delta, null)}${chunk({}, requests <= 2 ? "tool_calls" : "stop")}data: [DONE]\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    };
    const conversation = await app.request("conversation.create", { projectId: project.id });
    await app.request("conversation.send", {
      id: conversation.id,
      requestId: "cylinder-request",
      text: "查看圆柱面",
    });
    await done;
    const view = await app.request("conversation.watch", { id: conversation.id });
    assert.equal(view.error, "");
    assert.ok(
      view.messages.some(
        (message) =>
          message.role === "tool" &&
          message.tool?.name === "scene_get_cylinders" &&
          !message.failed,
      ),
    );
    assert.ok(secondRequest.includes("analytic-cylinder"));
    assert.ok(secondRequest.includes("unknown"));
    assert.ok(thirdRequest.includes("second-origin-to-first-infinite-axis"));
    assert.ok(thirdRequest.includes("unverified"));
    await app.close();
    app = await openApplication({
      dataRoot,

      publish: () => {},
    });
    const restored = await app.request("scene.get", { projectId: project.id });
    assert.deepEqual(
      restored.models[0]?.objects.find((item) => item.id === object.id)?.cylinderCandidates,
      object.cylinderCandidates,
    );
  } finally {
    if (app) await app.close();
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});
