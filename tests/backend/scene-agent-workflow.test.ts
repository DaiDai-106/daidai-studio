import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { openApplication } from "../../src/backend/application.ts";
import type { ApplicationEvent } from "../../src/contracts/application.ts";

const python = process.env.DAI_SCENE_TEST_PYTHON;
const exec = promisify(execFile);

test("Pi tool call modifies the shared project scene and another chat observes it", {
  skip: !python,
  timeout: 90_000,
}, async () => {
  if (!python) return;
  const root = await mkdtemp(join(tmpdir(), "dai-agent-scene-"));
  const step = join(root, "external.step");
  const originalFetch = globalThis.fetch;
  let onEvent: (event: ApplicationEvent) => void = () => {};
  let app: Awaited<ReturnType<typeof openApplication>> | undefined;
  try {
    await exec(
      python,
      [
        "-c",
        "import sys; sys.path.insert(0,'tests/python'); from assembly_fixture import write_assembly; write_assembly(sys.argv[1], True)",
        step,
      ],
      { cwd: resolve(".") },
    );
    app = await openApplication({
      dataRoot: join(root, "data"),
      workerPath: resolve("packages/scene/python/worker.py"),
      pythonExecutable: python,
      sceneSkillPath: resolve("packages/scene/skills/scene"),

      publish: (event) => onEvent(event),
    });
    const project = await app.request("project.create", {
      name: "场景",
      path: root,
      mode: "scene",
    });
    const initial = await app.request("scene.import", {
      projectId: project.id,
      path: step,
      revision: 0,
      operation: "replace",
    });
    const model = initial.models[0];
    const object = model?.objects[0];
    assert.ok(model && object);
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
    globalThis.fetch = async () => {
      requests++;
      const delta =
        requests === 1
          ? {
              tool_calls: [
                {
                  index: 0,
                  id: "call_scene",
                  type: "function",
                  function: {
                    name: "scene_set_transform",
                    arguments: JSON.stringify({
                      modelId: model.id,
                      objectId: object.id,
                      revision: initial.revision,
                      position: [1, 2, 3],
                      rotation: [0, 0, 0, 1],
                    }),
                  },
                },
              ],
            }
          : { role: "assistant", content: "对象已移动" };
      const chunks = [
        {
          id: "response",
          object: "chat.completion.chunk",
          created: 1,
          model: "example",
          choices: [{ index: 0, delta, finish_reason: null }],
        },
        {
          id: "response",
          object: "chat.completion.chunk",
          created: 1,
          model: "example",
          choices: [{ index: 0, delta: {}, finish_reason: requests === 1 ? "tool_calls" : "stop" }],
        },
      ];
      return new Response(
        `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    };
    const first = await app.request("conversation.create", { projectId: project.id });
    const other = await app.request("conversation.create", { projectId: project.id });
    let observedTool = false;
    const finished = new Promise<void>((done, reject) => {
      const timeout = setTimeout(() => reject(new Error("Pi 场景操作未结束")), 20_000);
      onEvent = (event) => {
        if (
          event.type === "conversation" &&
          event.view.conversationId === first.id &&
          event.view.activity === "tools" &&
          event.view.activeTools.some((tool) => tool.name === "scene_set_transform")
        )
          observedTool = true;
        if (
          event.type === "conversation" &&
          event.view.conversationId === first.id &&
          !event.view.busy
        ) {
          clearTimeout(timeout);
          done();
        }
      };
    });
    await app.request("conversation.send", {
      id: first.id,
      requestId: "scene-request",
      text: "移动对象",
    });
    await finished;
    const view = await app.request("conversation.watch", { id: first.id });
    assert.equal(observedTool, true);
    assert.deepEqual(view.activeTools, []);
    assert.equal(view.error, "");
    assert.ok(
      view.messages.some(
        (message) =>
          message.role === "tool" &&
          message.tool?.name === "scene_set_transform" &&
          !message.failed,
      ),
    );
    assert.ok(
      view.messages.some(
        (message) => message.role === "assistant" && message.text === "对象已移动",
      ),
    );
    assert.deepEqual(
      (await app.request("scene.get", { projectId: other.projectId })).models[0]?.objects[0]
        ?.transform?.position,
      [1, 2, 3],
    );
    assert.deepEqual((await app.request("conversation.watch", { id: other.id })).messages, []);
    assert.equal(requests, 2);
  } finally {
    if (app) await app.close();
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});
