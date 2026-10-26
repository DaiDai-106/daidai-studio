import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
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
import { createSettings } from "../../../src/backend/settings/handlers.ts";
import { servePlanner } from "../../support/planner.ts";

function gate() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("failed stop remains retryable; a delayed completion cannot release the next run", {
  timeout: 15000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dai-session-"));
  const planner = await servePlanner(() => ({ text: "Completed" }));
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
  const projects = createProjects(harness, storage);
  const artifacts = createArtifacts(harness, storage, () => {});
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
    projects,
    settings,
    idle,
    publish: () => {},
  });
  const changes = settings.requests({
    idle,
    logins,
    projects,
    releaseCad: () => builtins.cad.release(),
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
  const flush = artifacts.flush;
  let flushes = 0;
  t.mock.method(artifacts, "flush", async () => {
    const pending = ++flushes === 1 ? first : second;
    pending.entered.resolve();
    await pending.resume.promise;
    await flush();
    if (pending === first) first.returned.resolve();
  });
  const release = builtins.cad.release;
  let releases = 0;
  let failRelease = true;
  t.mock.method(builtins.cad, "release", async () => {
    releases++;
    if (failRelease) throw new Error("Release failed");
    await release();
  });
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
    assert.equal(session.busyId(), id, "failed cleanup must remain available for retry");
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
    assert.equal(planner.requests.length, 2);
    assert.deepEqual(planner.failures, []);
  } finally {
    failRelease = false;
    first.resume.resolve();
    second.resume.resolve();
    await session.unwatch();
    logins.close();
    await harness.waitForIdle(context);
    await builtins.close();
    await artifacts.close();
    await harness.close(context);
    await planner.close();
    await rm(root, { recursive: true, force: true });
  }
});
