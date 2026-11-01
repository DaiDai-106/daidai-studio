import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createPiAgent } from "../../../src/backend/agent/piAgent.ts";
import { createPiHistory } from "../../../src/backend/agent/piHistory.ts";
import { createPackageService } from "../../../src/backend/extensions/packageService.ts";
import { openProjectStore } from "../../../src/backend/projects/store.ts";

test("Pi agent 从授权包加载技能和扩展，并使用项目模式的系统提示", async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-pi-agent-"));
  const dataRoot = join(root, "data");
  const cwd = join(root, "workspace");
  const source = join(root, "package");
  await mkdir(cwd);
  await mkdir(join(source, "extensions"), { recursive: true });
  await mkdir(join(source, "skills", "sample"), { recursive: true });
  await writeFile(join(source, "package.json"), JSON.stringify({ name: "test-pi-package" }));
  await writeFile(
    join(source, "extensions", "index.ts"),
    `export default pi => pi.registerTool({
    name: "sample_tool", label: "Sample", description: "Test tool", parameters: {type:"object",properties:{}},
    execute: async () => ({content:[{type:"text",text:"ok"}],details:{}})
  });`,
  );
  await writeFile(
    join(source, "skills", "sample", "SKILL.md"),
    "---\nname: sample\ndescription: sample capability\n---\nSample instructions.\n",
  );
  const store = openProjectStore(dataRoot);
  const packages = createPackageService({ dataRoot, projectId: "fixture", cwd });
  try {
    await packages.install(source, "project");
    const project = store.createProject({ name: "场景", mode: "scene", path: cwd });
    const conversation = store.createConversation(project.id);
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
    });
    const session = await createPiAgent({
      conversationId: conversation.id,
      cwd,
      dataRoot,
      mode: "scene",
      history: createPiHistory(store, dataRoot),
      packages,
      modelRuntime,
    });
    try {
      assert.match(session.systemPrompt, /场景搭建助手/);
      assert.match(session.systemPrompt, /sample capability/);
      assert.ok(session.getActiveToolNames().includes("sample_tool"));
      assert.ok(session.getActiveToolNames().includes("read"));
    } finally {
      session.dispose();
    }
  } finally {
    await packages.dispose();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
