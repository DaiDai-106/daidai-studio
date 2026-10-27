import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { openRuntime } from "../../src/backend/runtime.ts";
import { servePlanner } from "../support/planner.ts";

test("scene skill images reach vision models on demand and custom attachments survive restart", {
  timeout: 45000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-skill-images-"));
  const projectPath = join(root, "project");
  await mkdir(projectPath);
  const reference = await readFile(
    resolve("resources/skills/steel-structure/images/upright-reference.png"),
  );
  let customPath = "";
  const planner = await servePlanner((request) => {
    const user = request.messages
      .filter((message) => message.role === "user" && typeof message.content === "string")
      .at(-1)?.content;
    const has = (id: string) => request.messages.some((message) => message.tool_call_id === id);
    if (user === "无图片能力") {
      assert.ok(!request.tools?.some((tool) => tool.function.name === "scene_read_skill_image"));
      return { text: "当前模型不支持图片。" };
    }
    if (user === "检查缺失图片") {
      if (!has("missing-image"))
        return {
          id: "missing-image",
          name: "scene_read_skill_image",
          args: { skillId: "user-steel", path: "images/missing.png" },
        };
      assert.match(JSON.stringify(request.messages), /未找到该技能的参考图片/);
      return { text: "参考图片不存在。" };
    }
    if (user === "查看型钢参考图") {
      if (!has("select"))
        return {
          id: "select",
          name: "scene_select_profile",
          args: { profileId: "steel-structure", scope: "project" },
        };
      if (!has("builtin-image")) {
        assert.match(JSON.stringify(request.messages), /builtin:steel-structure/);
        return {
          id: "builtin-image",
          name: "scene_read_skill_image",
          args: { skillId: "builtin:steel-structure", path: "images/upright-reference.png" },
        };
      }
      assert.ok(
        JSON.stringify(request.messages).includes(reference.toString("base64")),
        "actual reference bytes must reach the model",
      );
      return { text: "收到型钢参考图片。" };
    }
    if (user === "查看自定义参考图") {
      assert.match(JSON.stringify(request.messages), /user-steel/);
      if (!has("custom-image"))
        return {
          id: "custom-image",
          name: "scene_read_skill_image",
          args: { skillId: "user-steel", path: customPath },
        };
      assert.ok(JSON.stringify(request.messages).includes(reference.toString("base64")));
      return { text: "收到自定义参考图片。" };
    }
    assert.fail(`Unexpected message: ${user}`);
  });
  const vault = { available: false, read: async () => "{}", write: async () => {} };
  const paths = { skillsRoot: resolve("resources/skills") };
  let app = await openRuntime(root, vault, () => {}, paths);
  async function send(id: string, text: string) {
    await app.request("conversation.send", { id, requestId: crypto.randomUUID(), text });
    for (let i = 0; i < 1000; i++) {
      assert.deepEqual(planner.failures, []);
      if (!(await app.request("workspace.get", {})).busyConversationId) return;
      await setTimeout(10);
    }
    assert.fail("Model did not finish");
  }
  try {
    await app.request("provider.save", {
      config: {
        id: "test",
        name: "Test",
        providerType: "local",
        endpoint: planner.endpoint,
        enabled: true,
        authMethod: "none",
        persistCredentials: false,
        models: [
          {
            id: "vision",
            name: "Vision",
            context: 128000,
            output: 2048,
            reasoning: "标准",
            supportsImages: true,
          },
          { id: "text", name: "Text", context: 128000, output: 2048, reasoning: "标准" },
        ],
      },
    });
    const project = await app.request("project.open", { path: projectPath });
    const chat = await app.request("conversation.create", { projectId: project.id });
    await app.request("conversation.update", {
      id: chat.id,
      mode: "scene",
      modelId: "test:vision",
    });
    await send(chat.id, "查看型钢参考图");
    assert.equal(
      (await app.request("conversation.watch", { id: chat.id })).messages.at(-1)?.text,
      "收到型钢参考图片。",
    );
    const image = await app.request("skill.image.add", {
      id: "user-steel",
      name: "参考图.png",
      image: { mimeType: "image/png", data: reference.toString("base64") },
    });
    customPath = image.path;
    await app.request("skill.save", {
      config: {
        id: "user-steel",
        name: "用户型钢",
        description: "型钢参考",
        body: `查看参考图 ${image.path}`,
        enabled: true,
        scope: { kind: "project", projectId: project.id },
        modes: ["scene"],
        sceneProfile: "steel-structure",
        images: [image],
      },
    });
    await app.close();
    app = await openRuntime(root, vault, () => {}, paths);
    assert.equal(
      (await app.request("skill.image.read", { id: "user-steel", path: customPath })).data,
      reference.toString("base64"),
    );
    await send(chat.id, "查看自定义参考图");
    await send(chat.id, "检查缺失图片");
    await app.request("conversation.update", { id: chat.id, modelId: "test:text" });
    await send(chat.id, "无图片能力");
    await app.request("skill.remove", { id: "user-steel" });
    await assert.rejects(app.request("skill.image.read", { id: "user-steel", path: customPath }));
    assert.deepEqual(planner.failures, []);
  } finally {
    await app.close();
    await planner.close();
    await rm(root, { recursive: true, force: true });
  }
});
