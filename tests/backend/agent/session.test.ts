import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setImmediate, setTimeout } from "node:timers/promises";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
  type AgentSession,
  createSession,
  createSessionExtension,
} from "../../../src/backend/agent/session.ts";
import { createArtifacts } from "../../../src/backend/artifacts/store.ts";
import { loadBuiltins } from "../../../src/backend/builtin.ts";
import { createProjects } from "../../../src/backend/projects/handlers.ts";
import { createPlacements } from "../../../src/backend/projects/placements.ts";
import { createSettings } from "../../../src/backend/settings/handlers.ts";
import { servePlanner, turnResults } from "../../support/planner.ts";

function gate() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("run cleanup retains ownership on failure and delayed completion cannot release the next run", {
  timeout: 15000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dai-session-"));
  const fifth = { ready: gate(), resume: gate(), flush: gate() };
  const planner = await servePlanner((request) => {
    const text = request.messages.filter((message) => message.role === "user").at(-1)?.content;
    if ((text === "Third" || text === "Fifth") && turnResults(request).count === 0)
      return { id: "discover", name: "mcp_list_tools", args: { serverId: "test-server" } };
    if (text === "Fifth") {
      fifth.ready.resolve();
      return { text: "Waiting", beforeFinish: fifth.resume.promise };
    }
    return { text: "Completed" };
  });
  const builtins = await loadBuiltins({}, join(root, "tmp"));
  const storage = await openNodeSqliteStorage(join(root, "app.sqlite"));
  let harness: Harness;
  let session: AgentSession | undefined;
  const settings = await createSettings(
    { available: false, read: async () => "{}", write: async () => {} },
    () => harness,
    () => {},
  );
  const registry = createRegistry();
  const extension = createSessionExtension((id) => session?.skillFor(id));
  registry.install(extension);
  harness = await Harness.open(storage, { models: settings.providers.models, registry }, context);
  const logins = await settings.initialize();
  const projects = createProjects(harness, storage, settings.model);
  const artifacts = createArtifacts(harness, storage, () => {}, root);
  const placements = createPlacements(harness, storage, () => {}, root);
  const idle = () => {
    assert.equal(session?.busyId() ?? null, null);
  };
  session = createSession({
    harness,
    storage,
    registry,
    extension,
    builtins,
    artifacts,
    placements,
    projects,
    settings,
    idle,
    publish: () => {},
  });
  const changes = settings.requests({
    idle,
    logins,
    projects,
    releaseBuiltin: () => builtins.release(),
  });
  const projectRequests = projects.requests({
    idle,
    defaultModel: () => settings.read().defaultModel,
    watcher: { currentId: session.watchedId, stop: session.unwatch },
    display: artifacts,
    publish: () => {},
  });
  // Delay only display-index drainage, keeping durable generation and storage real.
  const first = { entered: gate(), resume: gate(), returned: gate() };
  const second = { entered: gate(), resume: gate() };
  const third = { entered: gate(), released: gate() };
  const fourth = { released: gate() };
  const flush = artifacts.flush;
  let flushes = 0;
  t.mock.method(artifacts, "flush", async () => {
    flushes++;
    if (flushes === 3) {
      third.entered.resolve();
      throw new Error("Display flush failed");
    }
    if (flushes === 5) await fifth.flush.promise;
    if (flushes > 3) return flush();
    const pending = flushes === 1 ? first : second;
    pending.entered.resolve();
    await pending.resume.promise;
    await flush();
    if (pending === first) first.returned.resolve();
  });
  const release = builtins.cad.release;
  let releases = 0;
  let failRelease = true;
  let failExternal = false;
  const cleanupOrder: string[] = [];
  const uninstall = registry.uninstall.bind(registry);
  t.mock.method(registry, "uninstall", (...args: Parameters<typeof registry.uninstall>) => {
    if (failExternal && args[0].name === "external-mcp") {
      cleanupOrder.push("external");
      throw new Error("External close failed");
    }
    return uninstall(...args);
  });
  t.mock.method(builtins.cad, "release", async () => {
    releases++;
    if (failExternal) cleanupOrder.push("builtin");
    if (failRelease) {
      if (flushes === 4) fourth.released.resolve();
      throw new Error("Release failed");
    }
    await release();
    if (flushes === 3) third.released.resolve();
  });
  const reports: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => reports.push(args.map(String).join(" ")));
  try {
    await changes["provider.save"]({
      config: {
        id: "session-test",
        name: "Session test",
        providerType: "local",
        endpoint: planner.endpoint,
        enabled: true,
        authMethod: "none",
        persistCredentials: false,
        models: [
          { id: "workflow-test", name: "Test", context: 8192, output: 1024, reasoning: "标准" },
        ],
      },
    });
    const project = await projectRequests["project.open"]({ path: root });
    const conversation = await projectRequests["conversation.create"]({ projectId: project.id });
    const id = conversation.id;
    await projectRequests["conversation.update"]({ id, mode: "scene" });
    await session.handlers["conversation.send"]({ id, text: "First", requestId: "first" });
    await first.entered.promise;
    await assert.rejects(session.handlers["conversation.stop"]({ id }), /Release failed/);
    assert.equal(session.busyId(), id, "failed cleanup must keep the run available to stop");
    failRelease = false;
    await session.handlers["conversation.stop"]({ id });
    assert.equal(session.busyId(), null);
    await session.handlers["conversation.send"]({ id, text: "Second", requestId: "second" });
    await second.entered.promise;
    const before = releases;
    first.resume.resolve();
    await first.returned.promise;
    await setImmediate();
    assert.equal(releases, before, "old completion must not release the current CAD worker");
    assert.equal(session.busyId(), id, "old completion must not clear the current run");
    second.resume.resolve();
    // Finishing flush and run cleanup use only promise continuations in this fixture.
    await setImmediate();
    assert.equal(session.busyId(), null);
    assert.equal(releases, before + 1);

    const marker = join(root, "external-closed");
    const readSettings = settings.read;
    let externalEnabled = true;
    t.mock.method(settings, "read", () => ({
      ...readSettings(),
      ...(externalEnabled
        ? {
            mcpServers: [
              {
                id: "test-server",
                name: "Test server",
                enabled: true,
                scope: { kind: "global" as const },
                modes: ["scene" as const],
                transport: "stdio" as const,
                command: process.execPath,
                args: [
                  "--experimental-strip-types",
                  resolve("tests/fixtures/mcp-stdio.ts"),
                  marker,
                ],
                timeoutMs: 5000,
              },
            ],
          }
        : {}),
    }));
    await session.handlers["conversation.send"]({ id, text: "Third", requestId: "third" });
    await third.entered.promise;
    await third.released.promise;
    for (let attempt = 0; attempt < 500 && session.busyId(); attempt++) await setTimeout(10);
    assert.equal(session.busyId(), null, "a flush failure must not skip resource release");
    assert.equal(
      await readFile(marker, "utf8"),
      "closed",
      "external MCP is closed after flush failure",
    );
    assert.ok(reports.some((message) => message.includes("Conversation ended unexpectedly")));

    externalEnabled = false;
    failRelease = true;
    await session.handlers["conversation.send"]({ id, text: "Fourth", requestId: "fourth" });
    await fourth.released.promise;
    await setImmediate();
    assert.equal(session.busyId(), id, "failed cleanup must retain its run for another stop");
    failRelease = false;
    await session.handlers["conversation.stop"]({ id });
    assert.equal(session.busyId(), null);
    assert.equal(planner.requests.length, 5);
    assert.deepEqual(planner.failures, []);

    externalEnabled = true;
    await session.handlers["conversation.send"]({ id, text: "Fifth", requestId: "fifth" });
    await fifth.ready.promise;
    failExternal = true;
    await assert.rejects(session.handlers["conversation.stop"]({ id }), /External close failed/);
    assert.deepEqual(cleanupOrder.slice(0, 2), ["external", "builtin"]);
    assert.equal(session.busyId(), id, "a failed stop retains ownership of the run");
  } finally {
    failExternal = false;
    failRelease = false;
    first.resume.resolve();
    second.resume.resolve();
    fifth.resume.resolve();
    fifth.flush.resolve();
    await session.unwatch();
    logins.close();
    await harness.waitForIdle(context);
    await builtins.close();
    await artifacts.close();
    await placements.close();
    await harness.close(context);
    await planner.close();
    await rm(root, { recursive: true, force: true });
  }
});
