import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openApplication } from "../../src/backend/application.ts";
import { openProjectStore } from "../../src/backend/projects/store.ts";

test("Pi 只能生成关节草稿；用户确认后项目共享并持久化", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-joint-agent-"));
  const dataRoot = join(root, "data");
  const store = openProjectStore(dataRoot);
  const project = store.createProject({ name: "场景", mode: "scene", path: root });
  const sha = "a".repeat(64);
  store.saveScene(project.id, 0, {
    models: [
      {
        source: { path: join(root, "model.step"), sha256: sha },
        resource: { path: join(root, "model.glb"), sha256: sha, format: "glb", byteLength: 4 },
        objects: [
          { id: "parent", name: "父", parentId: null },
          { id: "child", name: "子", parentId: null },
        ],
        warnings: [],
        complete: false,
      },
    ],
  });
  store.close();
  const originalFetch = globalThis.fetch;
  let finished!: () => void;
  const done = new Promise<void>((resolve) => {
    finished = resolve;
  });
  const app = await openApplication({
    dataRoot,

    publish: (event) => {
      if (event.type === "conversation" && !event.view.busy) finished();
    },
  });
  try {
    const initial = await app.request("scene.get", { projectId: project.id });
    const model = initial.models[0];
    assert.ok(model);
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
    let firstRequest = "";
    globalThis.fetch = async (_input, init) => {
      requests++;
      if (requests === 1) firstRequest = String(init?.body ?? "");
      const delta =
        requests === 1
          ? {
              tool_calls: [
                {
                  index: 0,
                  id: "joint",
                  type: "function",
                  function: {
                    name: "scene_create_joint_draft",
                    arguments: JSON.stringify({
                      revision: initial.revision,
                      parentModelId: model.id,
                      parentObjectId: "parent",
                      childModelId: model.id,
                      childObjectId: "child",
                      type: "revolute",
                      axisOrigin: [0, 0, 0],
                      axisDirection: [0, 0, 1],
                    }),
                  },
                },
              ],
            }
          : { role: "assistant", content: "候选已创建，请确认" };
      const chunk = (value: object, reason: string | null) =>
        `data: ${JSON.stringify({ id: "r", object: "chat.completion.chunk", created: 1, model: "example", choices: [{ index: 0, delta: value, finish_reason: reason }] })}\n\n`;
      return new Response(
        `${chunk(delta, null)}${chunk({}, requests === 1 ? "tool_calls" : "stop")}data: [DONE]\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    };
    const first = await app.request("conversation.create", { projectId: project.id });
    const second = await app.request("conversation.create", { projectId: project.id });
    await app.request("conversation.send", {
      id: first.id,
      requestId: "propose",
      text: "请提出关节候选",
    });
    await done;
    assert.ok(firstRequest.includes("scene_create_joint_draft"));
    assert.ok(!firstRequest.includes("scene_confirm_joint"));
    const draft = await app.request("scene.get", { projectId: second.projectId });
    assert.equal(draft.joints[0]?.status, "draft");
    assert.equal(draft.joints[0]?.limits, "unknown");
    const candidate = draft.joints[0];
    assert.ok(candidate);
    const confirmed = await app.request("scene.confirmJoint", {
      projectId: project.id,
      candidateId: candidate.id,
      revision: draft.revision,
    });
    assert.equal(confirmed.joints[0]?.status, "confirmed");
    assert.equal(confirmed.joints[0]?.validity, "current");
  } finally {
    await app.close();
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});
