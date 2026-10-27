import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openRuntime } from "../../src/backend/runtime.ts";
import { servePlanner } from "../support/planner.ts";

const image = {
  mimeType: "image/png" as const,
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a04AAAAASUVORK5CYII=",
};

test("image input reaches the model and survives conversation recovery", {
  timeout: 30000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-image-"));
  const planner = await servePlanner(() => ({ text: "看到了" }));
  const vault = { available: false, read: async () => "{}", write: async () => {} };
  let runtime = await openRuntime(root, vault, () => {});
  try {
    await runtime.request("provider.save", {
      config: {
        id: "vision",
        name: "Vision",
        providerType: "local",
        endpoint: planner.endpoint,
        enabled: true,
        authMethod: "none",
        persistCredentials: false,
        models: [
          {
            id: "workflow-test",
            name: "Test",
            context: 8192,
            output: 1024,
            reasoning: "标准",
            supportsImages: true,
          },
          { id: "text-only", name: "Text", context: 8192, output: 1024, reasoning: "标准" },
        ],
      },
    });
    const project = await runtime.request("project.open", { path: root });
    const conversation = await runtime.request("conversation.create", { projectId: project.id });
    await runtime.request("conversation.update", {
      id: conversation.id,
      modelId: "vision:workflow-test",
    });
    await runtime.request("conversation.send", {
      id: conversation.id,
      requestId: "image",
      text: "看看",
      images: [image],
    });
    while ((await runtime.request("workspace.get", {})).busyConversationId)
      await new Promise((done) => setTimeout(done, 10));
    assert.equal(planner.requests.length, 1);
    const user = planner.requests[0]?.messages.find((message) => message.role === "user");
    assert.match(JSON.stringify(user?.content), /data:image\/png;base64,/);
    assert.deepEqual(
      (await runtime.request("conversation.watch", { id: conversation.id })).messages[0]?.images,
      [image],
    );
    const changedImage = {
      ...image,
      data: Buffer.concat([Buffer.from(image.data, "base64"), Buffer.from([0])]).toString("base64"),
    };
    await assert.rejects(
      runtime.request("conversation.send", {
        id: conversation.id,
        requestId: "image",
        text: "看看",
        images: [changedImage],
      }),
      /发送标识与原请求内容不一致/,
    );
    await runtime.request("conversation.update", {
      id: conversation.id,
      modelId: "vision:text-only",
    });
    await assert.rejects(
      runtime.request("conversation.send", {
        id: conversation.id,
        requestId: "unsupported",
        text: "",
        images: [image],
      }),
      /当前模型不支持图片输入/,
    );
    await runtime.close();
    runtime = await openRuntime(root, vault, () => {});
    assert.deepEqual(
      (await runtime.request("conversation.watch", { id: conversation.id })).messages[0]?.images,
      [image],
    );
    await assert.rejects(
      runtime.request("conversation.send", {
        id: conversation.id,
        requestId: "bad",
        text: "",
        images: [{ ...image, data: "aGVsbG8=" }],
      }),
      /图片格式无效/,
    );
  } finally {
    await runtime.close();
    await planner.close();
    await rm(root, { recursive: true, force: true });
  }
});
