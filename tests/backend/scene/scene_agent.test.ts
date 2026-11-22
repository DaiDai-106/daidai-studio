import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type TestContext, test } from "node:test";
import { openApplication } from "../../../src/backend/application.ts";
import type { ApplicationEvent, ExtensionUiRequest } from "../../../src/contracts/application.ts";
import { testRobot } from "../../support/scene_fixture.ts";
import {
  stepAgentReply,
  stepWorkerAvailable,
  writeStepFixture,
} from "../../support/step_fixture.ts";

async function openTestScene(context: TestContext, publish: (event: ApplicationEvent) => void) {
  const root = await mkdtemp(join(tmpdir(), "dai-scene-agent-"));
  const originalFetch = globalThis.fetch;
  const app = await openApplication({ dataRoot: join(root, "data"), publish });
  context.after(async () => {
    globalThis.fetch = originalFetch;
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  const { id: projectId } = await app.request("project.create", {
    name: "场景",
    mode: "scene",
    path: root,
  });
  const path = join(root, "robot.urdf");
  await writeFile(path, testRobot);
  await app.request("scene.import", { projectId, path, expectedRevision: 0 });
  await app.request("provider.save", {
    config: {
      id: "local",
      name: "Local",
      providerType: "local",
      authMethod: "none",
      endpoint: "http://127.0.0.1:11434/v1",
      enabled: true,
      models: [{ id: "example", name: "Example", context: 4096, output: 1024, reasoning: "标准" }],
    },
  });
  return { app, root, projectId };
}

test("Pi 场景工具沿用审批，等待确认期间的手动修改使旧版本失效", {
  timeout: 15_000,
}, async (context) => {
  let approval = Promise.withResolvers<ExtensionUiRequest>();
  let finished = Promise.withResolvers<void>();
  let approvals = 0;
  const { app, root, projectId } = await openTestScene(context, (event) => {
    if (event.type === "extension.ui.request") {
      approvals++;
      approval.resolve(event.request);
    }
    if (event.type === "conversation" && !event.view.busy) finished.resolve();
  });
  const conversation = await app.request("conversation.create", { projectId });
  const tools: string[][] = [];
  let requestedRevision = 1;
  let nextCall = true;
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      tools?: Array<{ function?: { name: string } }>;
    };
    tools.push((body.tools ?? []).flatMap((tool) => (tool.function ? [tool.function.name] : [])));
    const delta = nextCall
      ? {
          tool_calls: [
            {
              index: 0,
              id: `joint-${requestedRevision}`,
              type: "function",
              function: {
                name: "scene_set_joint_position",
                arguments: JSON.stringify({
                  jointId: "joint-0",
                  position: 1,
                  expectedRevision: requestedRevision,
                }),
              },
            },
          ],
        }
      : { role: "assistant", content: "完成" };
    const chunk = (value: object, reason: string | null) =>
      `data: ${JSON.stringify({ id: "r", object: "chat.completion.chunk", created: 1, model: "example", choices: [{ index: 0, delta: value, finish_reason: reason }] })}\n\n`;
    const content = `${chunk(delta, null)}${chunk({}, nextCall ? "tool_calls" : "stop")}data: [DONE]\n\n`;
    nextCall = false;
    return new Response(content, { headers: { "content-type": "text/event-stream" } });
  };

  const send = (id: string, requestId: string) =>
    app.request("conversation.send", { id, requestId, text: "调整场景关节" });
  await send(conversation.id, "one");
  const awaitApproval = () =>
    Promise.race([
      approval.promise,
      finished.promise.then(async () => {
        const view = await app.request("conversation.watch", { id: conversation.id });
        throw new Error(
          JSON.stringify({
            tools,
            error: view.error,
            messages: view.messages.map(({ role, text }) => [role, text]),
          }),
        );
      }),
    ]);
  const first = await awaitApproval();
  assert.equal(first.kind, "confirm");
  assert.match(first.message ?? "", /swivel/);
  await app.request("scene.apply", {
    projectId,
    expectedRevision: 1,
    operation: { op: "setJointPosition", jointId: "joint-0", position: 0.5 },
  });
  await app.request("extension.ui.respond", {
    requestId: first.requestId,
    cancelled: false,
    value: "true",
  });
  await finished.promise;
  const stale = await app.request("scene.get", { projectId });
  assert.equal(stale.document.revision, 2);
  assert.equal(stale.document.robot?.joints[0]?.position, 0.5);

  requestedRevision = 2;
  nextCall = true;
  approval = Promise.withResolvers<ExtensionUiRequest>();
  finished = Promise.withResolvers<void>();
  await send(conversation.id, "two");
  const second = await awaitApproval();
  await app.request("extension.ui.respond", {
    requestId: second.requestId,
    cancelled: false,
    value: "true",
  });
  await finished.promise;
  const saved = await app.request("scene.get", { projectId });
  assert.equal(saved.document.revision, 3);
  assert.equal(saved.document.robot?.joints[0]?.position, 1);
  assert.ok(tools[0]?.includes("scene_get"));
  assert.ok(tools[0]?.includes("scene_set_joint_position"));
  for (const name of ["bash", "powershell", "write", "edit", "codemode"])
    assert.ok(!tools[0]?.includes(name));

  requestedRevision = 3;
  nextCall = true;
  finished = Promise.withResolvers<void>();
  await send(conversation.id, "same-position");
  await finished.promise;
  assert.equal(approvals, 2);
  assert.deepEqual(await app.request("scene.get", { projectId }), saved);

  const coding = await app.request("project.create", { name: "代码", mode: "coding", path: root });
  const chat = await app.request("conversation.create", { projectId: coding.id });
  finished = Promise.withResolvers<void>();
  await send(chat.id, "coding");
  await finished.promise;
  assert.ok(tools.at(-1)?.includes("edit"));
  assert.ok(!tools.at(-1)?.includes("scene_get"));
});

test("Pi 直接导入本地 STEP 附件，失败、取消及版本冲突时保留原场景", {
  skip: !stepWorkerAvailable && "先运行 npm run build:scene",
  timeout: 25_000,
}, async (context) => {
  let approvalCount = 0;
  let finished = Promise.withResolvers<void>();
  let beforeAttachmentRead: (() => void) | undefined;
  const { app, root, projectId } = await openTestScene(context, (event) => {
    if (event.type === "extension.ui.request") approvalCount++;
    if (event.type === "conversation") {
      if (!event.view.busy) finished.resolve();
      else if (beforeAttachmentRead) {
        const notify = beforeAttachmentRead;
        beforeAttachmentRead = undefined;
        notify();
      }
    }
  });
  const valid = join(root, "新装配.step");
  const invalid = join(root, "broken.step");
  await writeStepFixture(valid);
  await writeFile(invalid, "bad CAD");
  const { id } = await app.request("conversation.create", { projectId });
  const scene = () => app.request("scene.get", { projectId });
  let expectedRevision = 1;
  let beforeReply: (() => Promise<void>) | undefined;
  globalThis.fetch = async (_input, init) => {
    const body = String(init?.body);
    assert.ok(!body.includes(valid) && !body.includes(invalid));
    assert.ok(!body.includes("ISO-10303-21") && !body.includes("bad CAD"));
    const wait = beforeReply;
    beforeReply = undefined;
    await wait?.();
    return new Response(stepAgentReply(body, expectedRevision), {
      headers: { "content-type": "text/event-stream" },
    });
  };

  const send = (stepPath: string) => {
    finished = Promise.withResolvers<void>();
    return app.request("conversation.send", {
      id,
      requestId: crypto.randomUUID(),
      text: "",
      stepPath,
    });
  };
  async function pauseReply(stepPath: string) {
    const entered = Promise.withResolvers<void>();
    const reply = Promise.withResolvers<void>();
    beforeReply = () => {
      entered.resolve();
      return reply.promise;
    };
    await send(stepPath);
    await entered.promise;
    return reply.resolve;
  }

  const initial = await scene();
  let updateDraft: Promise<unknown> | undefined;
  beforeAttachmentRead = () => {
    updateDraft = app.request("conversation.update", { id, draft: "读取附件时编辑的新草稿" });
  };
  await send(invalid);
  await finished.promise;
  assert.ok(updateDraft);
  await updateDraft;
  assert.equal(
    (await app.request("workspace.get", {})).conversations.find((item) => item.id === id)?.draft,
    "读取附件时编辑的新草稿",
  );
  assert.deepEqual(await scene(), initial);

  const replyWithStaleVersion = await pauseReply(valid);
  const edited = await app.request("scene.apply", {
    projectId,
    expectedRevision: 1,
    operation: { op: "setJointPosition", jointId: "joint-0", position: 0.5 },
  });
  replyWithStaleVersion();
  await finished.promise;
  assert.deepEqual(await scene(), edited);

  expectedRevision = 2;
  const replyAfterStop = await pauseReply(valid);
  const stopping = app.request("conversation.stop", { id });
  replyAfterStop();
  await stopping;
  await finished.promise;
  assert.deepEqual(await scene(), edited);

  const replyWithSavedAttachment = await pauseReply(valid);
  // The local attachment represents what was selected and sent, even if the original is moved.
  await rm(valid);
  replyWithSavedAttachment();
  await finished.promise;
  const imported = (await scene()).document;
  assert.equal(imported.revision, 3);
  assert.equal(approvalCount, 0);
  assert.equal(imported.robot?.name, "新装配");
  assert.equal(imported.robot.links.length, 8);
  const mesh = imported.robot.links.flatMap((link) => link.visuals)[0]?.geometry;
  assert.equal(mesh?.type, "mesh");
  const preview = await app.request("scene.asset", { projectId, asset: mesh.asset });
  const exported = await app.request("scene.export", { projectId, directory: root });
  const stl = await readFile(join(dirname(exported.path), "meshes", mesh.asset));
  assert.equal(stl.toString("base64"), preview);
  assert.ok((await readFile(exported.path, "utf8")).includes(`meshes/${mesh.asset}`));
  const view = await app.request("conversation.watch", { id });
  assert.equal(
    view.messages.filter((message) => message.stepAttachment).at(-1)?.stepAttachment?.name,
    "新装配.step",
  );
  assert.equal(view.history.markers.at(-1)?.label, "新装配.step");

  const replyAfterQueue = await pauseReply(invalid);
  try {
    const directory = join(root, "data", "projects", projectId, "scene", "attachments");
    const before = (await readdir(directory)).sort();
    const messageId = crypto.randomUUID();
    await app.request("conversation.send", {
      id,
      requestId: messageId,
      text: "",
      stepPath: invalid,
      delivery: "followUp",
    });
    assert.equal((await readdir(directory)).length, before.length + 1);
    await app.request("conversation.cancelQueued", { id, messageId });
    assert.deepEqual((await readdir(directory)).sort(), before);
  } finally {
    replyAfterQueue();
  }
  await finished.promise;
});
