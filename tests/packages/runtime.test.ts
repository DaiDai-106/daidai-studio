import assert from "node:assert/strict";
import { test } from "node:test";
import { createRuntimeManager } from "../../packages/core/src/runtime.ts";

test("项目 Runtime 按项目 ID 惰性创建、并发复用并独立释放", async () => {
  const created: string[] = [];
  const disposed: string[] = [];
  const manager = createRuntimeManager(async (projectId) => {
    created.push(projectId);
    await Promise.resolve();
    return {
      projectId,
      async dispose() {
        disposed.push(projectId);
      },
    };
  });
  assert.deepEqual(created, []);
  const [first, same] = await Promise.all([manager.get("project-a"), manager.get("project-a")]);
  assert.equal(first, same);
  const other = await manager.get("project-b");
  assert.notEqual(first, other);
  assert.deepEqual(created, ["project-a", "project-b"]);
  await manager.release("project-a");
  assert.deepEqual(disposed, ["project-a"]);
  assert.notEqual(await manager.get("project-a"), first);
  await manager.dispose();
  assert.deepEqual(disposed.sort(), ["project-a", "project-a", "project-b"]);
  await assert.rejects(manager.get("project-a"), /closed|关闭/i);
});

test("项目销毁完成前不会创建同一项目的新 Runtime", async () => {
  let complete!: () => void;
  const stop = new Promise<void>((resolve) => {
    complete = resolve;
  });
  let count = 0;
  const manager = createRuntimeManager(async () => {
    const generation = ++count;
    return {
      generation,
      async dispose() {
        if (generation === 1) await stop;
      },
    };
  });
  await manager.get("same-project");
  const releasing = manager.release("same-project");
  const acquiring = manager.get("same-project");
  await Promise.resolve();
  assert.equal(count, 1);
  complete();
  await releasing;
  assert.equal((await acquiring).generation, 2);
  await manager.dispose();
});
