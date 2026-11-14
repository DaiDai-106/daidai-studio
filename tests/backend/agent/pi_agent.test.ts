import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createHistoryProjection } from "../../../src/backend/agent/history_projection.ts";
import { createPiAgent } from "../../../src/backend/agent/pi_agent.ts";
import { createPiHistory } from "../../../src/backend/agent/pi_history.ts";
import { createPackageService } from "../../../src/backend/extensions/package_service.ts";
import { openProjectStore } from "../../../src/backend/projects/store.ts";
import type { PackageLoad } from "../../../src/contracts/catalog.ts";

test("Pi agent 从授权包加载技能和扩展，并使用项目模式的系统提示", async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-pi-agent-"));
  const dataRoot = join(root, "data");
  const cwd = join(root, "workspace");
  const source = join(root, "package");
  const started = join(root, "server-started");
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
    join(source, "extensions", "server.ts"),
    `export default pi => pi.registerMcpServer('fixture', {
      command: ${JSON.stringify(process.execPath)},
      args: ['-e', ${JSON.stringify(`require('fs').writeFileSync(${JSON.stringify(started)}, 'started')`)}],
      exposure: 'direct'
    });`,
  );
  await writeFile(
    join(source, "skills", "sample", "SKILL.md"),
    "---\nname: sample\ndescription: sample capability\n---\nSample instructions.\n",
  );
  await writeFile(join(root, "AGENTS.md"), "Parent coding instruction fixture.\n");
  await writeFile(join(cwd, "AGENTS.md"), "Project coding instruction fixture.\n");
  await mkdir(join(cwd, ".pi", "extensions"), { recursive: true });
  await writeFile(
    join(cwd, ".pi", "extensions", "unexpected.ts"),
    "throw new Error('Unexpected project extension');",
  );
  const store = openProjectStore(dataRoot);
  await mkdir(join(dataRoot, "agent"), { recursive: true });
  await writeFile(join(dataRoot, "agent", "AGENTS.md"), "Global coding instruction fixture.\n");
  const packages = createPackageService({ dataRoot, moduleId: "coding" });
  try {
    await packages.install(source, "module");
    const project = store.createProject({ name: "场景", mode: "coding", path: cwd });
    const conversation = store.createConversation(project.id);
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
    });
    let loads: PackageLoad[] = [];
    const session = await createPiAgent({
      conversationId: conversation.id,
      cwd,
      dataRoot,
      history: createPiHistory(store, dataRoot),
      packages,
      modelRuntime,
      onPackageLoad: (entries) => {
        loads = entries;
      },
    });
    try {
      assert.match(session.systemPrompt, /编程助手/);
      assert.match(session.systemPrompt, /sample capability/);
      assert.ok(session.getActiveToolNames().includes("sample_tool"));
      assert.ok(loads.length > 0);
      assert.ok(
        loads.every((item) => item.source === source && item.scope === "module" && !item.error),
      );
      assert.ok(session.getActiveToolNames().includes("read"));
      assert.ok(!session.getActiveToolNames().some((name) => name.startsWith("mcp__")));
      await assert.rejects(readFile(started), { code: "ENOENT" });
      assert.match(session.systemPrompt, /coding instruction fixture/);
    } finally {
      session.dispose();
    }
    const coding = await createPiAgent({
      conversationId: conversation.id,
      cwd,
      dataRoot,
      history: createPiHistory(store, dataRoot),
      packages,
      modelRuntime,
    });
    try {
      const manager = coding.sessionManager;
      const usage = {
        input: 10,
        output: 2,
        cacheRead: 3,
        cacheWrite: 1,
        totalTokens: 16,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.1 },
      };
      const first = manager.appendMessage({ role: "user", content: "统计测试", timestamp: 1 });
      manager.appendUsage("fixture", "local", "model", usage);
      manager.appendCompaction("压缩摘要", first, 16, undefined, false, usage);
      manager.appendMessage({
        role: "toolResult",
        toolName: "fixture",
        toolCallId: "call",
        content: [],
        isError: false,
        timestamp: 2,
        usage,
      });
      manager.branch(first);
      manager.appendUsage("fixture", "local", "model", usage);
      const restored = createHistoryProjection(() => undefined).get(manager);
      const native = createHistoryProjection(() => undefined).get(manager, () =>
        coding.getSessionStats(),
      );
      assert.deepEqual(native.usage, restored.usage);
      assert.equal(native.usage.totalTokens, 64);
      assert.equal(native.branchUsage.totalTokens, 16);
      assert.match(coding.systemPrompt, /Global coding instruction fixture/);
      assert.match(coding.systemPrompt, /Parent coding instruction fixture/);
      assert.match(coding.systemPrompt, /Project coding instruction fixture/);
      assert.ok(coding.getActiveToolNames().includes("sample_tool"));
    } finally {
      coding.dispose();
    }
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
