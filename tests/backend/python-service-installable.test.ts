import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createScenePythonService } from "../../src/backend/projects/pythonService.ts";

test("Python 缺失可安装，已有损坏目录不可覆盖，失败回滚后可重试", async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-installable-"));
  const source = join(root, "source");
  await mkdir(source);
  const workerPath = join(source, "worker.py");
  await writeFile(workerPath, "");
  await writeFile(join(source, "install.py"), "");
  const dataRoot = join(root, "data");
  let completed: (status: { state: string; canInstall?: boolean }) => void = () => {};
  const failed = new Promise<{ state: string; canInstall?: boolean }>((resolve) => {
    completed = resolve;
  });
  const service = createScenePythonService({
    dataRoot,
    workerPath,
    hostPythonExecutable: join(root, "no-python"),
    publish(event) {
      if (event.type === "scene.pythonStatus" && event.status.state === "invalid")
        completed(event.status);
    },
  });
  try {
    assert.equal((await service.check()).canInstall, true);
    assert.equal(service.install().canInstall, false);
    const failure = await failed;
    assert.equal(failure.state, "invalid");
    assert.equal(failure.canInstall, true);
  } finally {
    await service.close();
  }
  const otherRoot = join(root, "existing");
  await mkdir(join(otherRoot, "python", "scene"), { recursive: true });
  const other = createScenePythonService({ dataRoot: otherRoot, workerPath, publish() {} });
  try {
    const status = await other.check();
    assert.equal(status.state, "invalid");
    assert.equal(status.canInstall, false);
    assert.throws(() => other.install(), /不会覆盖/);
  } finally {
    await other.close();
    await rm(root, { recursive: true, force: true });
  }
});
