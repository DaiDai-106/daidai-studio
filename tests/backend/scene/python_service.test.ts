import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createScenePythonService } from "../../../src/backend/scene/python_service.ts";

test("Python 环境仅在用户触发时安装，进度事件与已有环境保护有效", {
  skip: process.platform === "win32",
  timeout: 15_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-python-service-"));
  const source = join(root, "source");
  const dataRoot = join(root, "data");
  const workerPath = join(source, "worker.py");
  await mkdir(source);
  await writeFile(workerPath, "");
  // 本测试用无网络的最小安装器验证宿主生命周期；真实依赖安装另有 Python 测试。
  await writeFile(
    join(source, "install.py"),
    `import pathlib, sys
root = pathlib.Path(sys.argv[sys.argv.index('--data-root') + 1])
target = root / 'python' / 'scene' / 'bin'
target.mkdir(parents=True)
python = target / 'python'
python.write_text('#!/bin/sh\\nexit 0\\n')
python.chmod(0o700)
`,
  );
  let ready!: () => void;
  const completed = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const states: string[] = [];
  const service = createScenePythonService({
    dataRoot,
    workerPath,
    hostPythonExecutable: "python3",
    publish: (event) => {
      if (event.type === "scene.pythonStatus") {
        states.push(event.status.state);
        if (event.status.state === "ready") ready();
      }
    },
  });
  try {
    assert.equal((await service.check()).state, "missing");
    assert.equal(service.install().state, "installing");
    await completed;
    assert.equal(service.current().state, "ready");
    assert.ok(states.includes("installing"));
    assert.match(await readFile(service.executable, "utf8"), /exit 0/);
    assert.throws(() => service.install(), /不会覆盖/);
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});
