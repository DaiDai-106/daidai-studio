import { strict as assert } from "node:assert";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { usageDashboard } from "../../../src/backend/agent/usage_dashboard.ts";
import { openProjectStore } from "../../../src/backend/projects/store.ts";
import { validateResult } from "../../../src/contracts/application.ts";

test("本地历史包含隐藏归档及分叉去重，错误提示不完整且费用未知不当作零", async () => {
  const root = await mkdtemp(join(tmpdir(), "usage-dashboard-"));
  const store = openProjectStore(root);
  try {
    const project = store.createProject({ name: "P", mode: "coding", path: root });
    const directory = join(root, "agent", "sessions", project.id);
    await mkdir(directory, { recursive: true });
    const original = join(directory, "one.jsonl");
    const fork = join(directory, "two.jsonl");
    const header = {
      type: "session",
      version: 3,
      id: "one",
      timestamp: "2025-01-01T00:00:00Z",
      cwd: root,
    };
    const usage = {
      input: 10,
      output: 3,
      cacheRead: 5,
      cacheWrite: 2,
      totalTokens: 20,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    const event = {
      type: "usage",
      id: "1234",
      parentId: null,
      timestamp: "2025-01-02T10:00:00Z",
      provider: "a",
      model: "m",
      kind: "cache_warm",
      usage,
    };
    const next = {
      ...event,
      id: "5678",
      provider: "b",
      timestamp: "2025-01-03T10:00:00Z",
      usage: { ...usage, cost: { ...usage.cost, total: 0.25 } },
    };
    await writeFile(
      original,
      `${[header, event].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );
    await writeFile(
      fork,
      `${[{ ...header, id: "two", parentSession: original }, event, next]
        .map((entry) => JSON.stringify(entry))
        .join("\n")}\n`,
    );
    const one = store.createConversation(project.id, "", original);
    store.updateConversation(one.id, { hasMessages: true, archived: true });
    const two = store.createConversation(project.id, "", fork);
    store.updateConversation(two.id, { hasMessages: true });
    const missing = store.createConversation(project.id, "", join(directory, "missing.jsonl"));
    store.updateConversation(missing.id, { hasMessages: true });
    store.hideProject(project.id);
    const result = await usageDashboard(store, root, () => undefined);
    assert.equal(result.incomplete, 1);
    assert.equal(result.events.length, 2);
    assert.deepEqual(
      result.events.map((item) => item.provider),
      ["b", "a"],
    );
    assert.equal(result.events[0]?.estimatedCostUsd, 0.25);
    assert.equal(result.events[1]?.estimatedCostUsd, null);
    assert.equal(result.events[1]?.totalTokens, 20);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("删除中间分叉仍去重，坏行和坏模型不会阻止读取有效用量", async () => {
  const root = await mkdtemp(join(tmpdir(), "usage-dashboard-forks-"));
  const store = openProjectStore(root);
  try {
    const project = store.createProject({ name: "P", mode: "coding", path: root });
    const directory = join(root, "agent", "sessions", project.id);
    await mkdir(directory, { recursive: true });
    const original = join(directory, "original.jsonl");
    const middle = join(directory, "middle.jsonl");
    const fork = join(directory, "fork.jsonl");
    const event = {
      type: "usage",
      id: "usage",
      parentId: null,
      timestamp: "2025-01-01T00:00:00Z",
      provider: "p",
      model: "m",
      kind: "cache_warm",
      usage: {
        input: 10,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 1 },
      },
    };
    for (const [path, parent] of [
      [original, null],
      [middle, original],
      [fork, middle],
    ] as const) {
      await writeFile(
        path,
        `${[
          JSON.stringify({ type: "session", id: path, parentSession: parent }),
          JSON.stringify(event),
        ].join("\n")}\n`,
      );
      const conversation = store.createConversation(project.id, "", path);
      store.updateConversation(conversation.id, { hasMessages: true });
      if (path === middle) store.deleteConversation(conversation.id);
    }
    await writeFile(
      fork,
      `${[
        JSON.stringify({ type: "session", id: fork, parentSession: middle }),
        JSON.stringify(event),
        "{broken",
        JSON.stringify({ ...event, id: "bad-provider", provider: 123 }),
        JSON.stringify({ ...event, id: "bad-model", model: "m".repeat(501) }),
        JSON.stringify({ ...event, id: "second", usage: { ...event.usage, input: 7 } }),
      ].join("\n")}\n`,
    );
    await appendFile(
      middle,
      `${JSON.stringify({ ...event, id: "orphan", usage: { ...event.usage, input: 1000 } })}\n`,
    );
    const result = await usageDashboard(store, root, () => undefined);
    assert.equal(result.incomplete, 3);
    assert.deepEqual(
      result.events.map((entry) => entry.totalTokens).sort((a, b) => a - b),
      [7, 10],
    );
    const first = result.events[0];
    assert.ok(first);
    assert.equal("conversation" in first, false);
    validateResult("usage.dashboard", result);
    await rm(middle);
    const missing = await usageDashboard(store, root, () => undefined);
    assert.equal(missing.incomplete, 4);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
