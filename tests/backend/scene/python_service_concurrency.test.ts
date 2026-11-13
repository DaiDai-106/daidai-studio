import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createScenePythonService } from "../../../src/backend/scene/python_service.ts";

async function waitForFile(path: string): Promise<string> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      return await readFile(path, "utf8");
    } catch {
      await new Promise((done) => setTimeout(done, 20));
    }
  }
  throw new Error("检查子进程未启动");
}

test("并发环境检查共用一个进程，关闭时终止并等待该检查", {
  timeout: 10_000,
  skip: process.platform === "win32",
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "dai-python-check-"));
  const executable = join(directory, "python-check");
  const marker = join(directory, "pids");
  await writeFile(
    executable,
    `#!/usr/bin/env python3\nimport os,time\nwith open(${JSON.stringify(marker)},'a') as f: f.write(str(os.getpid())+'\\n')\ntime.sleep(60)\n`,
  );
  await chmod(executable, 0o755);
  const service = createScenePythonService({
    dataRoot: join(directory, "data"),
    pythonExecutable: executable,
    publish() {},
  });
  const first = service.check();
  const second = service.check();
  try {
    assert.throws(() => service.install(), /正在检查/);
    await waitForFile(marker);
    await new Promise((done) => setTimeout(done, 100));
    const pids = (await readFile(marker, "utf8")).trim().split("\n").map(Number);
    assert.equal(pids.length, 1);
    await service.close();
    await Promise.all([first, second]);
    assert.throws(() => process.kill(pids[0] ?? 0, 0));
  } finally {
    try {
      const pids = (await readFile(marker, "utf8")).trim().split("\n").map(Number);
      for (const pid of pids)
        if (pid > 0) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {}
        }
    } catch {}
    await service.close();
    await Promise.allSettled([first, second]);
    await rm(directory, { recursive: true, force: true });
  }
});

test("已安装真实几何环境经 Python 服务检查后可用", {
  skip: process.env.DAI_SCENE_TEST_PYTHON ? false : "需要配置 DAI_SCENE_TEST_PYTHON",
  timeout: 20_000,
}, async () => {
  const executable = process.env.DAI_SCENE_TEST_PYTHON;
  assert.ok(executable);
  const directory = await mkdtemp(join(tmpdir(), "dai-python-real-check-"));
  const service = createScenePythonService({
    dataRoot: directory,
    pythonExecutable: executable,
    publish() {},
  });
  try {
    assert.equal((await service.check()).state, "ready");
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("用户触发真实离线安装后服务确认环境可用", {
  skip: process.env.DAI_SCENE_TEST_WHEELHOUSE ? false : "需要配置 DAI_SCENE_TEST_WHEELHOUSE",
  timeout: 90_000,
}, async () => {
  const wheelhouse = process.env.DAI_SCENE_TEST_WHEELHOUSE;
  assert.ok(wheelhouse);
  const directory = await mkdtemp(join(tmpdir(), "dai-python-real-install-"));
  let completed: (state: string) => void = () => {};
  const finished = new Promise<string>((resolve) => {
    completed = resolve;
  });
  const service = createScenePythonService({
    dataRoot: directory,
    workerPath: join(process.cwd(), "packages/scene/python/worker.py"),
    hostPythonExecutable: "python3.12",
    wheelhouse,
    publish(event) {
      if (
        event.type === "scene.pythonStatus" &&
        (event.status.state === "ready" || event.status.state === "invalid")
      )
        completed(event.status.state);
    },
  });
  try {
    assert.equal((await service.check()).state, "missing");
    assert.equal(service.install().state, "installing");
    assert.equal(await finished, "ready");
    assert.equal((await service.check()).state, "ready");
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});
