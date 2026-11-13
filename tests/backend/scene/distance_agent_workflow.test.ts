import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { openApplication } from "../../../src/backend/application.ts";

const python = process.env.DAI_SCENE_TEST_PYTHON;
const exec = promisify(execFile);

test("Pi 使用对象 ID 测量真实 STEP，不把距离误报为碰撞", {
  skip: !python,
  timeout: 90_000,
}, async () => {
  if (!python) return;
  const root = await mkdtemp(join(tmpdir(), "dai-distance-agent-"));
  const source = join(root, "external.step");
  const originalFetch = globalThis.fetch;
  let finished!: () => void;
  const done = new Promise<void>((resolveDone) => {
    finished = resolveDone;
  });
  let app: Awaited<ReturnType<typeof openApplication>> | undefined;
  try {
    await exec(
      python,
      [
        "-c",
        "import sys; sys.path.insert(0,'tests/python'); from assembly_fixture import write_assembly; write_assembly(sys.argv[1], False, False)",
        source,
      ],
      { cwd: resolve(".") },
    );
    app = await openApplication({
      dataRoot: join(root, "data"),
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
    const first = model?.objects.find((item) => item.name === "FirstBlock");
    const second = model?.objects.find((item) => item.name === "SecondBlock");
    assert.ok(model && first && second);
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
    let count = 0;
    let toolReply = "";
    let toolSchema = "";
    globalThis.fetch = async (_input, init) => {
      count++;
      if (count === 1) toolSchema = String(init?.body ?? "");
      if (count === 2) toolReply = String(init?.body ?? "");
      const delta =
        count === 1
          ? {
              tool_calls: [
                {
                  index: 0,
                  id: "distance",
                  type: "function",
                  function: {
                    name: "scene_measure_distance",
                    arguments: JSON.stringify({
                      revision: scene.revision,
                      firstModelId: model.id,
                      firstObjectId: first.id,
                      secondModelId: model.id,
                      secondObjectId: second.id,
                    }),
                  },
                },
              ],
            }
          : { role: "assistant", content: "距离已测量" };
      const chunk = (value: object, reason: string | null) =>
        `data: ${JSON.stringify({ id: "r", object: "chat.completion.chunk", created: 1, model: "example", choices: [{ index: 0, delta: value, finish_reason: reason }] })}\n\n`;
      return new Response(
        `${chunk(delta, null)}${chunk({}, count === 1 ? "tool_calls" : "stop")}data: [DONE]\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    };
    const conversation = await app.request("conversation.create", { projectId: project.id });
    await app.request("conversation.send", {
      id: conversation.id,
      requestId: "distance-request",
      text: "测量两个对象的距离",
    });
    await done;
    const view = await app.request("conversation.watch", { id: conversation.id });
    assert.equal(view.error, "");
    assert.ok(
      view.messages.some(
        (message) =>
          message.role === "tool" &&
          message.tool?.name === "scene_measure_distance" &&
          !message.failed,
      ),
    );
    const schema = JSON.parse(toolSchema).tools.find(
      (item: { function?: { name?: string } }) => item.function?.name === "scene_measure_distance",
    ).function.parameters;
    assert.equal(schema.properties.path, undefined);
    assert.equal(schema.properties.source, undefined);
    assert.ok(toolReply.includes("occt-brep"));
    assert.ok(toolReply.includes("unknown"));
    assert.deepEqual(await app.request("scene.get", { projectId: project.id }), scene);
  } finally {
    if (app) await app.close();
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});
