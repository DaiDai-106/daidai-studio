import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAssistantMessageEventStream, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createHistoryProjection } from "../../../src/backend/agent/history_projection.ts";
import { createAgentModuleConfig } from "../../../src/backend/agent/module_config.ts";
import { createPiAgent } from "../../../src/backend/agent/pi_agent.ts";
import { createPiHistory } from "../../../src/backend/agent/pi_history.ts";
import { createPackageService } from "../../../src/backend/extensions/package_service.ts";
import { openProjectStore } from "../../../src/backend/projects/store.ts";
import { createProviders } from "../../../src/backend/settings/providers.ts";
import type { PackageLoad } from "../../../src/contracts/catalog.ts";

test("恢复旧 Coding 会话时为历史工具清单追加 Code Mode", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "dai-pi-resume-"));
  const dataRoot = join(root, "data");
  const store = openProjectStore(dataRoot);
  context.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const project = store.createProject({ name: "Coding", mode: "coding", path: root });
  const { id } = store.createConversation(project.id);
  const oldSession = createPiHistory(store, dataRoot).open(id);
  oldSession.appendMessage({
    role: "system",
    content: "旧版本工具配置",
    toolsAdded: ["read", "find"].map((name) => ({
      name,
      description: name,
      parameters: { type: "object", properties: {} },
    })),
    timestamp: 1,
  });
  oldSession.appendMessage({ role: "user", content: "之前的消息", timestamp: 2 });
  assert.ok(oldSession.isPersisted());

  const session = await createPiAgent({
    conversationId: id,
    cwd: root,
    dataRoot,
    history: createPiHistory(store, dataRoot),
    packages: createPackageService({ dataRoot, moduleId: "coding" }),
    modelRuntime: await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
    }),
    moduleConfig: createAgentModuleConfig({ project, conversationId: id }),
  });
  try {
    assert.deepEqual([...session.getActiveToolNames()].sort(), ["codemode", "find", "read"]);
  } finally {
    session.dispose();
  }
});

test("Pi agent 从授权包加载技能和扩展，并使用项目模式的系统提示", async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-pi-agent-"));
  const dataRoot = join(root, "data");
  const cwd = join(root, "workspace");
  const source = join(root, "package");
  const lifecycle = join(root, "extension-lifecycle");
  await mkdir(cwd);
  await mkdir(join(source, "extensions"), { recursive: true });
  await mkdir(join(source, "skills", "sample"), { recursive: true });
  await writeFile(join(source, "package.json"), JSON.stringify({ name: "test-pi-package" }));
  await writeFile(
    join(source, "extensions", "index.ts"),
    `import { appendFileSync } from "node:fs";
  export default pi => {
    pi.on("session_start", () => appendFileSync(${JSON.stringify(lifecycle)}, ${JSON.stringify("start\n")}));
    pi.on("session_shutdown", () => appendFileSync(${JSON.stringify(lifecycle)}, ${JSON.stringify("shutdown\n")}));
    pi.registerTool({
      name: "sample_tool", label: "Sample", description: "Test tool", parameters: {type:"object",properties:{}},
      execute: async () => ({content:[{type:"text",text:"ok"}],details:{}})
    });
  };`,
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
      moduleConfig: createAgentModuleConfig({ project, conversationId: conversation.id }),
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
      assert.ok(session.getActiveToolNames().includes("codemode"));
      assert.ok(!session.getActiveToolNames().some((name) => name.startsWith("mcp__")));
      assert.match(session.systemPrompt, /coding instruction fixture/);
      assert.equal(await readFile(lifecycle, "utf8"), "start\n");
      await session.reload();
      assert.equal(await readFile(lifecycle, "utf8"), "start\nshutdown\nstart\n");
      assert.ok(session.getActiveToolNames().includes("sample_tool"));
      assert.ok(session.getActiveToolNames().includes("codemode"));
      assert.ok(!session.getActiveToolNames().some((name) => name.startsWith("mcp__")));
    } finally {
      session.dispose();
    }
    let fullAccess = false;
    const coding = await createPiAgent({
      conversationId: conversation.id,
      cwd,
      dataRoot,
      history: createPiHistory(store, dataRoot),
      packages,
      modelRuntime,
      moduleConfig: createAgentModuleConfig({
        project,
        conversationId: conversation.id,
        fullAccess: () => fullAccess,
      }),
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
      await mkdir(join(cwd, "src"));
      await mkdir(join(cwd, "nested", "src"), { recursive: true });
      await writeFile(join(cwd, "src", "main.ts"), "export {};\n");
      await writeFile(join(cwd, "nested", "src", "other.ts"), "export {};\n");
      coding.setActiveToolsByName([...coding.getActiveToolNames(), "find"]);
      const find = coding.agent.state.tools.find((tool) => tool.name === "find");
      assert.ok(find);
      for (const [pattern, expected] of [
        ["src/*.ts", ["src/main.ts"]],
        ["./src/*.ts", ["src/main.ts"]],
        ["**/src/*.ts", ["nested/src/other.ts", "src/main.ts"]],
      ] as const) {
        const result = await find.execute(`find-${pattern}`, { pattern });
        const paths = result.content.flatMap((part) =>
          part.type === "text" ? part.text.split("\n") : [],
        );
        assert.deepEqual(paths.sort(), [...expected].sort());
      }
      const outside = join(root, "outside");
      await mkdir(outside);
      await writeFile(join(outside, "private-secret.ts"), "secret");
      if (process.platform !== "win32") await symlink(outside, join(cwd, "escape"), "dir");
      modelRuntime.registerNativeProvider(
        createProviders(new InMemoryCredentialStore()).create({
          id: "find-test",
          name: "Find test",
          providerType: "local",
          authMethod: "none",
          endpoint: "http://127.0.0.1:1/v1",
          enabled: true,
          models: [
            {
              id: "find-model",
              name: "Find model",
              context: 128000,
              output: 4096,
              reasoning: "标准",
            },
          ],
        }),
      );
      const model = modelRuntime.getModel("find-test", "find-model");
      assert.ok(model);
      await coding.setModel(model);
      let requests = 0;
      const paths =
        process.platform === "win32" ? ["src", "../outside"] : ["src", "../outside", "escape"];
      coding.agent.streamFunction = (selected) => {
        const path = (fullAccess ? ["../outside"] : paths)[requests++];
        const response = createAssistantMessageEventStream();
        const message = {
          role: "assistant" as const,
          api: selected.api,
          provider: selected.provider,
          model: selected.id,
          usage,
          timestamp: Date.now(),
          stopReason: path ? ("toolUse" as const) : ("stop" as const),
          content: path
            ? [
                {
                  type: "toolCall" as const,
                  id: `find-${fullAccess ? "full" : "restricted"}-${requests}`,
                  name: "find",
                  arguments: { pattern: "**/*.ts", path },
                },
              ]
            : [{ type: "text" as const, text: "完成" }],
        };
        response.push({ type: "done", reason: message.stopReason, message });
        return response;
      };
      await coding.prompt("通过 find 查找文件");
      const results = coding.messages
        .filter((message) => message.role === "toolResult")
        .filter((message) => message.toolCallId.startsWith("find-restricted-"));
      assert.equal(results.length, paths.length);
      assert.equal(results[0]?.isError, false);
      assert.match(JSON.stringify(results[0]?.content), /main.ts/);
      for (const result of results.slice(1)) {
        assert.equal(result.isError, true);
        assert.match(JSON.stringify(result.content), /不在项目目录/);
        assert.doesNotMatch(JSON.stringify(result.content), /private-secret/);
      }
      fullAccess = true;
      requests = 0;
      await coding.prompt("已授权完整访问，再次查找外部目录");
      const allowed = coding.messages
        .filter((message) => message.role === "toolResult")
        .find((message) => message.toolCallId === "find-full-1");
      assert.ok(allowed);
      assert.equal(allowed.isError, false);
      assert.match(JSON.stringify(allowed.content), /private-secret.ts/);
    } finally {
      coding.dispose();
    }
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("规划 Agent 读写编辑全角空格文件时保留实际目标", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "dai-planning-file-path-"));
  const dataRoot = join(root, "data");
  const cwd = join(root, "workspace");
  const store = openProjectStore(dataRoot);
  let session: Awaited<ReturnType<typeof createPiAgent>> | undefined;
  context.after(async () => {
    session?.dispose();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(cwd);
  const file = "车间　参数.txt";
  const other = "车间 参数.txt";
  await writeFile(join(cwd, file), "目标文件");
  await writeFile(join(cwd, other), "另一个文件");

  const project = store.createProject({ name: "规划", mode: "planning", path: cwd });
  const conversation = store.createConversation(project.id);
  const credentials = new InMemoryCredentialStore();
  const modelRuntime = await ModelRuntime.create({
    credentials,
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(
    createProviders(credentials).create({
      id: "planning-test",
      name: "Planning test",
      providerType: "local",
      authMethod: "none",
      endpoint: "http://127.0.0.1:1/v1",
      enabled: true,
      models: [{ id: "fixture", name: "Fixture", context: 4096, output: 1024, reasoning: "标准" }],
    }),
  );
  const model = modelRuntime.getModel("planning-test", "fixture");
  assert.ok(model);
  session = await createPiAgent({
    conversationId: conversation.id,
    cwd,
    dataRoot,
    history: createPiHistory(store, dataRoot),
    packages: createPackageService({ dataRoot, moduleId: "planning" }),
    modelRuntime,
    moduleConfig: createAgentModuleConfig({ project, conversationId: conversation.id }),
    model,
  });

  const calls = [
    { name: "read", arguments: { path: file } },
    { name: "write", arguments: { path: file, content: "写入后" } },
    { name: "edit", arguments: { path: file, edits: [{ oldText: "写入后", newText: "编辑后" }] } },
  ];
  session.agent.streamFunction = (selected) => {
    const call = calls.shift();
    const response = createAssistantMessageEventStream();
    const message = {
      role: "assistant" as const,
      api: selected.api,
      provider: selected.provider,
      model: selected.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      timestamp: Date.now(),
      stopReason: call ? ("toolUse" as const) : ("stop" as const),
      content: call
        ? [{ type: "toolCall" as const, id: call.name, ...call }]
        : [{ type: "text" as const, text: "完成" }],
    };
    response.push({ type: "done", reason: message.stopReason, message });
    return response;
  };
  await session.prompt("读写并编辑指定文件");

  const results = session.messages.filter((message) => message.role === "toolResult");
  assert.deepEqual(
    results.map(({ toolName, isError }) => [toolName, isError]),
    [
      ["read", false],
      ["write", false],
      ["edit", false],
    ],
  );
  assert.deepEqual(results[0]?.content, [{ type: "text", text: "目标文件" }]);
  assert.equal(await readFile(join(cwd, file), "utf8"), "编辑后");
  assert.equal(await readFile(join(cwd, other), "utf8"), "另一个文件");
});
