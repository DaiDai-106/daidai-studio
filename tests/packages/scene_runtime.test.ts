import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createSceneRuntime } from "../../packages/scene/src/runtime.ts";

test("场景 worker 惰性启动并在同一项目中复用，取消后安全重建", { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "dai-scene-runtime-"));
  const source = join(directory, "model.step");
  const marker = join(directory, "started");
  await writeFile(source, "fixture");
  const runtime = createSceneRuntime({
    projectId: "project-a",
    cwd: directory,
    dataDir: directory,
    pythonExecutable: process.platform === "win32" ? "python" : "python3",
    workerPath: resolve("tests/packages/fixtures/scene_worker.py"),
  });
  try {
    assert.ok(runtime.listTools().some((tool) => tool.name === "scene_import"));
    await assert.rejects(access(marker));
    const first = (await runtime.call("scene_import", { path: source })) as {
      pid: number;
      projectId: string;
      path: string;
    };
    assert.equal(first.projectId, "project-a");
    assert.equal(first.path, source);
    assert.equal(Number(await readFile(marker, "utf8")), first.pid);
    const second = (await runtime.call("scene_import", { path: source })) as { pid: number };
    assert.equal(second.pid, first.pid);
    await assert.rejects(
      runtime.call("scene_import", { path: join(directory, "invalid.step") }),
      /invalid STEP/,
    );
    const abort = new AbortController();
    const pending = runtime.call(
      "scene_import",
      { path: join(directory, "hang.step") },
      { signal: abort.signal },
    );
    setTimeout(() => abort.abort(), 100);
    await assert.rejects(pending, { name: "AbortError" });
    const restarted = (await runtime.call("scene_import", { path: source })) as { pid: number };
    assert.notEqual(restarted.pid, first.pid);
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
  await assert.rejects(runtime.call("scene_import", { path: source }), /closed|关闭/i);
});

test("缺少 Python 或 worker 启动失败时明确失败", { timeout: 5_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "dai-scene-missing-"));
  const runtime = createSceneRuntime({
    projectId: "missing",
    cwd: directory,
    dataDir: directory,
    pythonExecutable: join(directory, "no-python"),
  });
  try {
    await assert.rejects(runtime.call("scene_import", { path: join(directory, "x.step") }));
    await assert.rejects(
      runtime.call("scene_import", { path: join(directory, "x.step") }),
      /无法启动场景 Python/,
    );
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("未配置场景 Python 时提示安装，不回退到系统解释器", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dai-scene-unconfigured-"));
  const runtime = createSceneRuntime({
    projectId: "unconfigured",
    cwd: directory,
    dataDir: directory,
  });
  try {
    await assert.rejects(
      runtime.call("scene_import", { path: join(directory, "x.step") }),
      /场景依赖安装/,
    );
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("同项目任务串行，取消一个任务不会取消其他会话的任务", { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "dai-scene-queue-"));
  const runtime = createSceneRuntime({
    projectId: "queue",
    cwd: directory,
    dataDir: directory,
    workerPath: resolve("tests/packages/fixtures/scene_worker.py"),
    pythonExecutable: process.platform === "win32" ? "python" : "python3",
  });
  try {
    const runningAbort = new AbortController();
    const running = runtime.call(
      "scene_import",
      { path: join(directory, "hang.step") },
      { signal: runningAbort.signal },
    );
    const other = runtime.call("scene_import", { path: join(directory, "ok.step") });
    setTimeout(() => runningAbort.abort(), 100);
    await assert.rejects(running, { name: "AbortError" });
    assert.equal(((await other) as { path: string }).path, join(directory, "ok.step"));

    const slow = runtime.call("scene_import", { path: join(directory, "slow.step") });
    const queuedAbort = new AbortController();
    const queued = runtime.call(
      "scene_import",
      { path: join(directory, "never.step") },
      { signal: queuedAbort.signal },
    );
    queuedAbort.abort();
    await assert.rejects(queued, { name: "AbortError" });
    assert.equal(((await slow) as { path: string }).path, join(directory, "slow.step"));
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("不同项目 worker 的取消互不影响", { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "dai-scene-separate-"));
  const options = {
    cwd: directory,
    workerPath: resolve("tests/packages/fixtures/scene_worker.py"),
    pythonExecutable: process.platform === "win32" ? "python" : "python3",
  };
  const first = createSceneRuntime({
    ...options,
    projectId: "first",
    dataDir: join(directory, "first"),
  });
  const second = createSceneRuntime({
    ...options,
    projectId: "second",
    dataDir: join(directory, "second"),
  });
  try {
    const abort = new AbortController();
    const cancelled = first.call(
      "scene_import",
      { path: join(directory, "hang.step") },
      { signal: abort.signal },
    );
    const completed = second.call("scene_import", { path: join(directory, "slow.step") });
    setTimeout(() => abort.abort(), 100);
    await assert.rejects(cancelled, { name: "AbortError" });
    assert.equal(((await completed) as { projectId: string }).projectId, "second");
  } finally {
    await Promise.all([first.dispose(), second.dispose()]);
    await rm(directory, { recursive: true, force: true });
  }
});

test("空闲时只关闭 worker，执行和排队中的任务不受影响", {
  timeout: 10_000,
  skip: process.platform === "win32",
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "dai-scene-idle-"));
  const options = {
    cwd: directory,
    workerPath: resolve("tests/packages/fixtures/scene_worker.py"),
    pythonExecutable: "python3",
    idleTimeoutMs: 80,
  };
  const first = createSceneRuntime({
    ...options,
    projectId: "first",
    dataDir: join(directory, "first"),
  });
  const second = createSceneRuntime({
    ...options,
    projectId: "second",
    dataDir: join(directory, "second"),
  });
  try {
    const firstResult = (await first.call("scene_import", {
      path: join(directory, "ok.step"),
    })) as { pid: number };
    const active = second.call("scene_import", { path: join(directory, "slow.step") });
    const queued = second.call("scene_import", { path: join(directory, "ok.step") });
    const deadline = Date.now() + 3_000;
    let firstStopped = false;
    while (Date.now() < deadline) {
      try {
        process.kill(firstResult.pid, 0);
      } catch {
        firstStopped = true;
        break;
      }
      await new Promise((done) => setTimeout(done, 20));
    }
    assert.equal(firstStopped, true, "空闲项目 worker 应自行关闭");
    const activeResult = (await active) as { pid: number };
    const queuedResult = (await queued) as { pid: number };
    assert.equal(activeResult.pid, queuedResult.pid, "队列任务不能触发空闲退出");
    const reloaded = (await first.call("scene_import", { path: join(directory, "ok.step") })) as {
      pid: number;
    };
    assert.notEqual(reloaded.pid, firstResult.pid);
  } finally {
    await Promise.all([first.dispose(), second.dispose()]);
    await rm(directory, { recursive: true, force: true });
  }
});

test("worker 允许多 MB 结果，但按 UTF-8 字节限制超大响应并可恢复", {
  timeout: 15_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "dai-scene-response-"));
  const runtime = createSceneRuntime({
    projectId: "response",
    cwd: directory,
    dataDir: directory,
    workerPath: resolve("tests/packages/fixtures/scene_worker.py"),
    pythonExecutable: process.platform === "win32" ? "python" : "python3",
  });
  try {
    const result = (await runtime.call("scene_import", {
      path: join(directory, "large-response.step"),
    })) as { payload: string };
    assert.equal(result.payload.length, 2 * 1024 * 1024);
    await assert.rejects(
      runtime.call("scene_import", { path: join(directory, "oversized-response.step") }),
      /响应超过大小限制/,
    );
    const recovered = (await runtime.call("scene_import", {
      path: join(directory, "ok.step"),
    })) as { path: string };
    assert.equal(recovered.path, join(directory, "ok.step"));
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
