import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import {
  access,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { TLSSocket } from "node:tls";
import { openApplication } from "../../../src/backend/application.ts";
import { createPackageService } from "../../../src/backend/extensions/package_service.ts";
import { mcpConfigDirectory } from "../../../src/backend/settings/mcp.ts";
import type { ConversationInfo } from "../../../src/contracts/application.ts";
import { type PluginModule, pluginModuleIds } from "../../../src/contracts/catalog.ts";
import { dwgParserProcess } from "../../../src/contracts/dwgparser.ts";

async function startDwgParserFixture(context: TestContext, root: string, directory: string) {
  await mkdir(directory, { recursive: true });
  const serverKey = join(root, "server.key");
  const serverCert = join(root, "server.crt");
  const deviceCert = join(directory, "device.crt");
  const deviceKey = join(directory, "device.key");
  for (const [key, cert, name] of [
    [serverKey, serverCert, "localhost"],
    [deviceKey, deviceCert, "device-test"],
  ] as const) {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:prime256v1",
        "-nodes",
        "-keyout",
        key,
        "-out",
        cert,
        "-days",
        "1",
        "-subj",
        `/CN=${name}`,
        "-addext",
        "subjectAltName=IP:127.0.0.1",
      ],
      { stdio: "ignore" },
    );
  }
  await copyFile(serverCert, join(directory, "server-ca.crt"));
  const server = createServer(
    {
      key: await readFile(serverKey),
      cert: await readFile(serverCert),
      ca: await readFile(deviceCert),
      requestCert: true,
      rejectUnauthorized: true,
    },
    async (req, res) => {
      assert.ok((req.socket as TLSSocket).authorized);
      if (req.method === "GET" && req.url === "/mcp/health") {
        res.writeHead(200, { "Content-Type": "application/json" }).end('{"status":"ok"}');
        return;
      }
      if (req.method === "DELETE") {
        res.writeHead(204).end();
        return;
      }
      const body = JSON.parse(
        await Array.fromAsync(req).then((chunks) => Buffer.concat(chunks).toString()),
      );
      if (body.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      const results = {
        initialize: {
          protocolVersion: body.params?.protocolVersion,
          serverInfo: { name: "dwgparser-fixture", version: "1" },
          capabilities: { tools: {} },
        },
        "tools/list": {
          tools: ["build_process_package", "get_package_task", "cancel_package_task"].map(
            (name) => ({
              name: `dwgparser_${name}`,
              inputSchema: { type: "object", properties: {} },
            }),
          ),
        },
        "tools/call": { content: [{ type: "text", text: "mTLS fixture task" }] },
      };
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Mcp-Session-Id": "fixture-session",
      });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: results[body.method as keyof typeof results],
        }),
      );
    },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => {
    server.close();
    server.closeAllConnections();
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `https://127.0.0.1:${address.port}/mcp`;
}

test("Code Mode 全局可用，MCP 按模块加载并在保存后刷新", { timeout: 15_000 }, async (context) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dai-mcp-")));
  const dataRoot = join(root, "data");
  const tlsDirectory = join(mcpConfigDirectory(dataRoot), "process", "dwgparser");
  const dwgParserEndpoint = await startDwgParserFixture(context, root, tlsDirectory);
  const provisionedDirectory = join(root, "provisioned-certificates");
  await cp(tlsDirectory, provisionedDirectory, { recursive: true });
  const projectPath = join(root, "project");
  await mkdir(join(projectPath, ".pi"), { recursive: true });
  await writeFile(
    join(projectPath, ".pi", "mcp.json"),
    JSON.stringify({ mcpServers: { unexpected: { url: "http://localhost/mcp/unexpected" } } }),
  );
  const plugin = join(root, "plugin");
  await mkdir(join(plugin, "extensions"), { recursive: true });
  await writeFile(join(plugin, "package.json"), '{"name":"mcp-command-fixture"}');
  await writeFile(
    join(plugin, "extensions", "index.ts"),
    'export default (pi) => pi.registerCommand("mcp", { description: "Fixture", handler: async () => {} });',
  );
  const requests: string[] = [];
  const notices: string[] = [];
  const modelTools: string[][] = [];
  let config = "";
  let finished = Promise.withResolvers<void>();
  const originalFetch = globalThis.fetch;
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(dataRoot, "agent");
  const app = await openApplication({
    dataRoot,
    dwgParserEndpoint,
    publish(event) {
      if (event.type === "conversation" && !event.view.busy) finished.resolve();
      if (event.type === "extension.ui.notification") notices.push(event.message);
    },
  });
  await createPackageService({ dataRoot, moduleId: "coding" }).install(plugin, "module");
  context.after(async () => {
    try {
      await app.close();
    } finally {
      globalThis.fetch = originalFetch;
      if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
      await rm(root, { recursive: true, force: true });
    }
  });

  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.origin === new URL(dwgParserEndpoint).origin) return originalFetch(input, init);
    if (url.pathname.startsWith("/mcp/")) {
      requests.push(url.pathname);
      if (init?.method !== "POST") return new Response(null, { status: 405 });
      const request = JSON.parse(String(init.body));
      if (request.id === undefined) return new Response(null, { status: 202 });
      const inputSchema = { type: "object", properties: {} };
      let result: object;
      switch (request.method) {
        case "initialize":
          result = {
            protocolVersion: request.params.protocolVersion,
            serverInfo: { name: "fixture", version: "1" },
            capabilities: { tools: {} },
          };
          break;
        case "tools/list":
          result = {
            tools: [
              { name: "read_data", description: "Read fixture data", inputSchema },
              { name: "write_data", description: "Write fixture data", inputSchema },
            ],
          };
          break;
        case "tools/call":
          assert.equal(request.params.name, "read_data");
          result = {
            content: [{ type: "text", text: "fixture" }],
            structuredContent: { source: url.pathname },
          };
          break;
        default:
          throw new Error(`Unexpected request ${request.method}`);
      }
      return Response.json({ jsonrpc: "2.0", id: request.id, result });
    }

    const body = JSON.parse(String(init?.body));
    const names = body.tools.map((tool: { function: { name: string } }) => tool.function.name);
    modelTools.push(names);
    const last = body.messages.at(-1);
    const toolCall = last.role === "user";
    const delta = toolCall
      ? {
          tool_calls: [
            {
              index: 0,
              id: `codemode-${modelTools.length}`,
              type: "function",
              function: { name: "codemode", arguments: JSON.stringify({ code: config }) },
            },
          ],
        }
      : { role: "assistant", content: "完成" };
    const chunk = (value: object, reason: string | null) =>
      `data: ${JSON.stringify({
        id: "mcp-fixture",
        object: "chat.completion.chunk",
        model: "fixture",
        created: 1,
        choices: [{ index: 0, delta: value, finish_reason: reason }],
      })}\n\n`;
    return new Response(
      `${chunk(delta, null)}${chunk({}, toolCall ? "tool_calls" : "stop")}data: [DONE]\n\n`,
      {
        headers: { "content-type": "text/event-stream" },
      },
    );
  };

  await app.request("provider.save", {
    config: {
      id: "local",
      name: "Local",
      providerType: "local",
      authMethod: "none",
      endpoint: "http://localhost/v1",
      enabled: true,
      models: [
        { id: "fixture", name: "Fixture", context: 128000, output: 4096, reasoning: "标准" },
      ],
    },
  });
  const configFor = (scope: string) =>
    JSON.stringify({
      mcpServers: {
        catalog: {
          url: `http://localhost/mcp/${scope}`,
          exposure: "hidden",
          toolExposure: { read_data: "codemode" },
        },
      },
    });
  const global = configFor("global");
  const local = configFor("planning");
  await app.request("mcp.save", { text: global });
  await app.request("mcp.save", { moduleId: "planning", text: local });
  await assert.rejects(
    app.request("mcp.save", { moduleId: "planning", text: "{invalid" }),
    /有效的 JSON/,
  );
  await assert.rejects(
    app.request("mcp.save", {
      text: JSON.stringify({
        mcpServers: {
          "fixture-test": { url: "http://localhost/mcp/first" },
          fixture_test: { url: "http://localhost/mcp/second" },
        },
      }),
    }),
    /相同工具命名空间/u,
  );
  assert.equal(await app.request("mcp.get", {}), global);
  assert.equal(await app.request("mcp.get", { moduleId: "planning" }), local);

  async function callCode(id: string, code: string, requestId: string) {
    config = code;
    finished = Promise.withResolvers();
    await app.request("conversation.send", { id, requestId, text: "使用 Code Mode 检查工具" });
    await finished.promise;
    const view = await app.request("conversation.watch", { id });
    const result = view.messages.findLast((message) => message.role === "tool");
    assert.ok(
      result && !result.failed,
      JSON.stringify({ result: result?.text, error: view.error, notices, requests }),
    );
    return result.text;
  }

  const chats = new Map<PluginModule, ConversationInfo>();
  for (const mode of pluginModuleIds) {
    const project = await app.request("project.create", {
      name: mode,
      mode,
      path: mode === "coding" ? root : projectPath,
    });
    const conversation = await app.request("conversation.create", { projectId: project.id });
    chats.set(mode, conversation);
    const output = await callCode(
      conversation.id,
      `const data = await tools.mcp__catalog__read_data({});
return { data: data.structuredContent, names: ALL_TOOLS.map(({ name }) => name) };`,
      `run-${mode}`,
    );
    assert.match(output, mode === "planning" ? /\/mcp\/planning/ : /\/mcp\/global/);
    assert.doesNotMatch(output, /mcp__catalog__write_data/);
    assert.ok(modelTools.at(-1)?.includes("codemode"));
    assert.ok(!modelTools.at(-1)?.some((name) => name.startsWith("mcp__")));
    if (mode === "scene") assert.doesNotMatch(output, /"(write|edit|bash|powershell)"/);
  }

  const coding = chats.get("coding")?.id;
  const planningChat = chats.get("planning");
  assert.ok(coding && planningChat);
  const { id: planning, projectId: planningProject } = planningChat;
  finished = Promise.withResolvers();
  await app.request("conversation.send", { id: coding, requestId: "mcp-status", text: "/dai-mcp" });
  await finished.promise;
  assert.ok(
    notices.some((notice) => /catalog: connected/u.test(notice)),
    JSON.stringify(notices),
  );

  const globalPath = join(mcpConfigDirectory(dataRoot), "mcp.json");
  const denied = await callCode(
    coding,
    `try { await tools.write({ path: ${JSON.stringify(globalPath)}, content: "{}" }); }
catch (error) { return String(error); }`,
    "protected-config",
  );
  assert.match(denied, /MCP 配置不能由项目文件工具修改/u);
  assert.equal(await app.request("mcp.get", {}), global);

  const spilled = await callCode(
    coding,
    '// @options: {"max_output_tokens": 16}\ntext("complete-fixture-output ".repeat(1000));',
    "spill-output",
  );
  const outputFile = spilled.match(/\[Full output: (.+) \(read with offset\/limit\)\]/u)?.[1];
  assert.ok(outputFile, spilled);
  context.after(() => rm(outputFile, { force: true }));
  const readOutput = `try { return (await tools.read({path: ${JSON.stringify(outputFile)}, limit: 1})).slice(0, 100); }
catch (error) { return String(error); }`;
  assert.match(await callCode(coding, readOutput, "read-own-output"), /complete-fixture-output/u);
  assert.match(await callCode(planning, readOutput, "read-other-output"), /明确授权/u);

  await app.request("mcp.save", {
    moduleId: "planning",
    text: JSON.stringify({ mcpServers: { catalog: { enabled: false } } }),
  });
  const output = await callCode(
    planning,
    "return ALL_TOOLS.map(({ name }) => name);",
    "run-disabled",
  );
  assert.match(output, /planning_get_scene/);
  assert.doesNotMatch(output, /mcp__catalog__/);
  await writeFile(
    join(mcpConfigDirectory(dataRoot), "modules", "planning", "mcp.json"),
    "{invalid",
  );
  const { id: damaged } = await app.request("conversation.create", { projectId: planningProject });
  const afterDamage = await callCode(
    damaged,
    "return ALL_TOOLS.map(({ name }) => name);",
    "damaged-config",
  );
  assert.match(afterDamage, /planning_get_scene/);
  assert.doesNotMatch(afterDamage, /mcp__catalog__/);
  assert.ok(notices.some((notice) => /MCP 已暂停.*有效的 JSON/su.test(notice)));
  await app.request("mcp.save", { moduleId: "planning", text: local });
  const repaired = await callCode(
    damaged,
    "return (await tools.mcp__catalog__read_data({})).structuredContent;",
    "repaired-config",
  );
  assert.match(repaired, /\/mcp\/planning/u);

  const processConfig = JSON.stringify({
    mcpServers: {
      custom: { url: "http://localhost/mcp/custom", label: "非标图纸工艺" },
      bevel: { url: "http://localhost/mcp/bevel" },
      weld: { url: "http://localhost/mcp/weld", label: "焊接", enabled: false },
    },
  });
  await app.request("mcp.save", { scope: "process", text: processConfig });
  assert.equal(await app.request("mcp.get", { scope: "process" }), processConfig);
  assert.deepEqual(await app.request("planning.process.get", { projectId: planningProject }), {
    selected: null,
    servers: [
      { id: dwgParserProcess.id, label: dwgParserProcess.label },
      { id: "custom", label: "非标图纸工艺" },
      { id: "bevel", label: "bevel" },
    ],
  });
  await assert.rejects(
    app.request("planning.process.select", { projectId: planningProject, server: "weld" }),
    /已停用或移除/u,
  );
  const codingProject = chats.get("coding")?.projectId;
  assert.ok(codingProject);
  const keyPath = join(tlsDirectory, "device.key");
  await assert.rejects(
    app.request("coding.read", {
      projectId: codingProject,
      path: "data/agent/mcp/process/dwgparser/device.key",
    }),
    /MCP 设备私钥/u,
  );
  assert.match(
    await callCode(
      coding,
      `try { await tools.read({path: ${JSON.stringify(keyPath)}}); return "allowed"; }
catch (error) { return String(error); }`,
      "protected-device-key",
    ),
    /MCP 设备私钥/u,
  );
  const scanProject = await app.request("project.create", {
    name: "包含证书目录的规划项目",
    mode: "planning",
    path: root,
  });
  const scanChat = await app.request("conversation.create", { projectId: scanProject.id });
  assert.match(
    await callCode(
      scanChat.id,
      `try { await tools.grep({path: ".", pattern: "PRIVATE KEY"}); return "allowed"; }
catch (error) { return String(error); }`,
      "protected-device-key-search",
    ),
    /MCP 设备私钥/u,
  );
  await assert.rejects(
    app.request("planning.process.select", { projectId: codingProject, server: "custom" }),
    /规划项目不存在/u,
  );
  await app.request("planning.process.select", { projectId: planningProject, server: "custom" });
  assert.match(
    await callCode(
      planning,
      "return (await tools.mcp__custom__read_data({})).structuredContent;",
      "selected-process",
    ),
    /\/mcp\/custom/u,
  );
  const other = await app.request("project.create", {
    name: "另一规划项目",
    mode: "planning",
    path: projectPath,
  });
  await app.request("planning.process.select", { projectId: other.id, server: "bevel" });
  const otherChat = await app.request("conversation.create", { projectId: other.id });
  const otherTools = await callCode(
    otherChat.id,
    "return ALL_TOOLS.map(({ name }) => name);",
    "other-process",
  );
  assert.match(otherTools, /mcp__bevel__read_data/u);
  assert.doesNotMatch(otherTools, /mcp__custom__/u);
  assert.equal(
    (await app.request("planning.process.get", { projectId: planningProject })).selected,
    "custom",
  );
  await app.request("planning.process.select", { projectId: planningProject, server: null });
  assert.doesNotMatch(
    await callCode(planning, "return ALL_TOOLS.map(({ name }) => name);", "cleared-process"),
    /mcp__custom__/u,
  );
  assert.deepEqual(await app.request("mcp.dwgparser.status", {}), {
    state: "ready",
    directory: tlsDirectory,
  });
  assert.deepEqual(await app.request("mcp.dwgparser.test", {}), { tools: 3 });
  await app.request("planning.process.select", {
    projectId: planningProject,
    server: dwgParserProcess.id,
  });
  const dwgResult = await callCode(
    planning,
    `return {
    task: await tools.mcp__dwgparser__dwgparser_get_package_task({}),
    catalog: (await tools.mcp__catalog__read_data({})).structuredContent
  };`,
    "builtin-dwgparser",
  );
  assert.match(dwgResult, /mTLS fixture task/u);
  assert.match(dwgResult, /\/mcp\/planning/u);

  const processPath = join(mcpConfigDirectory(dataRoot), "process", "mcp.json");
  await writeFile(processPath, "{invalid");
  const withInvalidConfig = await app.request("planning.process.get", {
    projectId: planningProject,
  });
  assert.equal(withInvalidConfig.selected, dwgParserProcess.id);
  assert.deepEqual(withInvalidConfig.servers, [
    { id: dwgParserProcess.id, label: dwgParserProcess.label },
  ]);
  assert.match(withInvalidConfig.configError ?? "", /有效的 JSON/u);
  await app.request("planning.process.select", { projectId: planningProject, server: null });
  await app.request("planning.process.select", {
    projectId: planningProject,
    server: dwgParserProcess.id,
  });
  await app.request("mcp.save", { scope: "process", text: processConfig });

  const clock = Date.now;
  try {
    Date.now = () => clock() + 2 * 86_400_000;
    const expired = await app.request("mcp.dwgparser.refresh", {});
    assert.equal(expired.state, "invalid");
    assert.match(expired.message ?? "", /有效期/u);
    await assert.rejects(app.request("mcp.dwgparser.test", {}), /有效期/u);
  } finally {
    Date.now = clock;
  }
  assert.equal((await app.request("mcp.dwgparser.refresh", {})).state, "ready");

  const ordinary = JSON.parse(await app.request("mcp.get", { moduleId: "planning" }));
  ordinary.mcpServers.dwgparser = { url: "http://localhost/mcp/ordinary-dwgparser" };
  await app.request("mcp.save", { moduleId: "planning", text: JSON.stringify(ordinary) });
  await copyFile(join(tlsDirectory, "device.crt"), join(tlsDirectory, "server-ca.crt"));
  assert.equal((await app.request("mcp.dwgparser.refresh", {})).state, "ready");
  await assert.rejects(app.request("mcp.dwgparser.test", {}), /mTLS 握手失败/u);
  await rm(join(tlsDirectory, "device.key"));
  assert.equal((await app.request("mcp.dwgparser.refresh", {})).state, "missing");
  const projectWithMissingKey = await app.request("planning.process.get", {
    projectId: planningProject,
  });
  assert.equal(projectWithMissingKey.selected, dwgParserProcess.id);
  assert.equal(projectWithMissingKey.servers[0]?.disabled, true);
  const afterMissingKey = await callCode(
    planning,
    "return ALL_TOOLS.map(({ name }) => name);",
    "no-same-name-fallback",
  );
  assert.match(afterMissingKey, /mcp__catalog__read_data/u);
  assert.doesNotMatch(afterMissingKey, /mcp__dwgparser__/u);
  assert.ok(notices.some((notice) => /dwgparser.*配置 MCP 服务证书/u.test(notice)));
  assert.ok(!requests.includes("/mcp/ordinary-dwgparser"));
  assert.ok(!requests.includes("/mcp/weld"));
  assert.ok(!requests.includes("/mcp/unexpected"));

  await assert.rejects(app.request("mcp.dwgparser.configure", { directory: root }), /需要包含/u);
  assert.equal((await app.request("mcp.dwgparser.status", {})).state, "missing");
  assert.deepEqual(
    await app.request("mcp.dwgparser.configure", { directory: provisionedDirectory }),
    {
      state: "ready",
      directory: provisionedDirectory,
    },
  );
  const authPath = join(mcpConfigDirectory(dataRoot), "auth.json");
  assert.deepEqual(JSON.parse(await readFile(authPath, "utf8")), {
    dwgparser: {
      certificateDirectory: provisionedDirectory,
      protectedPrivateKeys: [
        join(tlsDirectory, "device.key"),
        join(provisionedDirectory, "device.key"),
      ],
    },
  });
  const previousKey = { projectId: codingProject, path: "provisioned-certificates/device.key" };
  const previousKeyPath = join(provisionedDirectory, "device.key");
  await assert.rejects(app.request("coding.read", previousKey), /MCP 设备私钥/u);
  await app.request("mcp.dwgparser.configure", { directory: provisionedDirectory });
  await access(previousKeyPath);

  const replacementDirectory = join(root, "replacement-certificates");
  await cp(provisionedDirectory, replacementDirectory, { recursive: true });
  const nextKey = join(replacementDirectory, "device.key");
  if (process.platform !== "win32") {
    await rm(nextKey);
    await symlink(previousKeyPath, nextKey);
    await assert.rejects(
      app.request("mcp.dwgparser.configure", { directory: replacementDirectory }),
      /引用了同一私钥/u,
    );
    await access(previousKeyPath);
    await rm(nextKey);
    await copyFile(previousKeyPath, nextKey);
  }

  const replacementCa = join(replacementDirectory, "server-ca.crt");
  await copyFile(join(replacementDirectory, "device.crt"), replacementCa);
  await assert.rejects(
    app.request("mcp.dwgparser.configure", { directory: replacementDirectory }),
    /mTLS 握手失败/u,
  );
  await access(previousKeyPath);
  assert.equal((await app.request("mcp.dwgparser.status", {})).directory, provisionedDirectory);
  await copyFile(join(provisionedDirectory, "server-ca.crt"), replacementCa);
  assert.equal(
    (await app.request("mcp.dwgparser.configure", { directory: replacementDirectory })).directory,
    replacementDirectory,
  );
  await assert.rejects(access(previousKeyPath), { code: "ENOENT" });
  await access(nextKey);
  await assert.rejects(app.request("coding.read", previousKey), /MCP 设备私钥/u);
  await writeFile(previousKeyPath, "dummy restored key\n");
  assert.match(
    await callCode(
      scanChat.id,
      `try { await tools.grep({path: "provisioned-certificates", pattern: "PRIVATE KEY"}); return "allowed"; }
catch (error) { return String(error); }`,
      "protected-previous-key-search",
    ),
    /MCP 设备私钥/u,
  );
  await app.close();
  const restarted = await openApplication({ dataRoot, dwgParserEndpoint, publish() {} });
  try {
    assert.deepEqual(await restarted.request("mcp.dwgparser.status", {}), {
      state: "ready",
      directory: replacementDirectory,
    });
    await assert.rejects(restarted.request("coding.read", previousKey), /MCP 设备私钥/u);
    await assert.rejects(
      restarted.request("coding.read", {
        projectId: codingProject,
        path: "replacement-certificates/device.key",
      }),
      /MCP 设备私钥/u,
    );
    assert.deepEqual(await restarted.request("mcp.dwgparser.test", {}), { tools: 3 });
  } finally {
    await restarted.close();
  }
});
