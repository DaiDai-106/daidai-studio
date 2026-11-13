import assert from "node:assert/strict";
import { test } from "node:test";
import {
  loadCodingWorkspace,
  saveCodingWorkspace,
} from "../../../src/renderer/features/coding/logic/workspace_storage.ts";

test("工作区按项目恢复文件、差异和布局，不保存网页地址", () => {
  const values = new Map<string, string>();
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
  try {
    const id = "00000000-0000-4000-8000-000000000001";
    assert.equal(
      saveCodingWorkspace("p", {
        open: false,
        width: 65,
        navigation: "changes",
        tabs: {
          items: [
            { id, content: { type: "file", path: "src/main.ts" } },
            {
              id: crypto.randomUUID(),
              content: { type: "preview", url: "https://example.com/?secret=value" },
            },
          ],
          activeId: id,
        },
      }),
      "",
    );
    const state = loadCodingWorkspace("p");
    assert.equal(state.open, false);
    assert.equal(state.width, 65);
    assert.equal(state.navigation, "changes");
    assert.deepEqual(state.tabs.items, [{ id, content: { type: "file", path: "src/main.ts" } }]);
    assert.equal(state.tabs.activeId, id);
    assert.ok(!values.get("dai:coding:p")?.includes("secret"));
    assert.equal(loadCodingWorkspace("other").tabs.items.length, 0);
    assert.equal(loadCodingWorkspace("other").open, false);
    values.set("dai:coding:p", "invalid json");
    assert.match(loadCodingWorkspace("p").error, /无法恢复/);
    values.set(
      "dai:coding:p",
      JSON.stringify({
        version: 1,
        width: -1,
        tabs: { items: [{ id, content: { type: "file", path: "../secret" } }] },
      }),
    );
    assert.equal(loadCodingWorkspace("p").width, 50);
    assert.equal(loadCodingWorkspace("p").tabs.items.length, 0);
    values.set(
      "dai:coding:p",
      JSON.stringify({
        version: 1,
        tabs: {
          items: [
            null,
            { id, content: { type: "file", path: "main.ts" } },
            { id, content: { type: "file", path: "other.ts" } },
          ],
        },
      }),
    );
    assert.deepEqual(loadCodingWorkspace("p").tabs.items, [
      { id, content: { type: "file", path: "main.ts" } },
    ]);
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem() {
          throw new Error("读取失败");
        },
        setItem() {
          throw new Error("存储已满");
        },
      },
    });
    assert.match(loadCodingWorkspace("p").error, /无法恢复/);
    assert.match(
      saveCodingWorkspace("p", {
        open: true,
        width: 50,
        tabs: { items: [], activeId: null },
        navigation: "files",
      }),
      /无法保存/,
    );
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("超限优先恢复活动文件，其余保留最近打开的标签；网页不占保存名额", () => {
  const values = new Map<string, string>();
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
  try {
    const files = Array.from({ length: 110 }, (_, index) => ({
      id: crypto.randomUUID(),
      content: { type: "file" as const, path: `file-${index}.ts` },
    }));
    const first = files[0];
    const last = files.at(-1);
    assert.ok(first && last);
    const page = {
      id: crypto.randomUUID(),
      content: { type: "preview" as const, url: "https://example.com" },
    };
    const state = {
      open: true,
      width: 50,
      navigation: "files" as const,
      tabs: { items: [...files, page], activeId: last.id },
    };
    saveCodingWorkspace("p", state);
    let restored = loadCodingWorkspace("p");
    assert.equal(restored.open, true);
    assert.equal(restored.tabs.items.length, 100);
    assert.equal(restored.tabs.activeId, last.id);
    assert.deepEqual(restored.tabs.items, files.slice(-100));
    saveCodingWorkspace("p", { ...state, tabs: { ...state.tabs, activeId: first.id } });
    restored = loadCodingWorkspace("p");
    assert.equal(restored.tabs.activeId, first.id);
    assert.deepEqual(restored.tabs.items, [files[0], ...files.slice(-99)]);
    saveCodingWorkspace("p", { ...state, tabs: { ...state.tabs, activeId: page.id } });
    restored = loadCodingWorkspace("p");
    assert.equal(restored.tabs.activeId, last.id);
    assert.equal(
      restored.tabs.items.some((item) => item.id === page.id),
      false,
    );
    assert.equal(state.tabs.items.length, 111, "保存不能修改运行中的标签");
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
