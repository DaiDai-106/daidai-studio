import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fileReferences,
  formatFileReference,
  parseFileReference,
  resolveMarkdownFileReference,
} from "../../../src/shared/file_references.ts";

test("文件引用支持带空格路径和明确行范围，拒绝越界和特权地址", () => {
  for (const token of ['@"src/my file.ts":2-4', "src/main.ts:2-4", "src/main.ts#L2-L4"]) {
    assert.deepEqual(parseFileReference(token), {
      path: token.includes("my file") ? "src/my file.ts" : "src/main.ts",
      startLine: 2,
      endLine: 4,
    });
  }
  const reference = { path: "src/中文 file.ts", startLine: 2, endLine: 4 };
  assert.deepEqual(parseFileReference(formatFileReference(reference)), reference);
  const namedWithPosition = { path: "src/log.ts:12", startLine: 3, endLine: 6 };
  assert.deepEqual(parseFileReference(formatFileReference(namedWithPosition)), namedWithPosition);
  for (const token of [
    "../secret.ts",
    "/etc/passwd",
    "file:///tmp/a.ts",
    "https://example.com/a.ts",
    "src/a.ts:0",
    "src/a.ts:8-2",
    '"src/../a.ts"',
    "store.messages",
  ])
    assert.equal(parseFileReference(token), null, token);
  assert.deepEqual(
    fileReferences('检查 @"src/my file.ts":2-4 和 @"src/my file.ts":2-4，联系 a@b.com'),
    [{ path: "src/my file.ts", startLine: 2, endLine: 4 }],
  );
  assert.throws(() => fileReferences("请看 @../secret.ts"), /引用无效/);
  assert.throws(() => fileReferences('请看 @"src/main.ts":invalid'), /引用无效/);
  assert.deepEqual(fileReferences("联系 @someone"), []);
});

test("代码块内的 diff 数据不会被当作文件引用", () => {
  assert.deepEqual(fileReferences('请看 @"src/a.ts"\n```diff\n+ @../external/file.ts\n```'), [
    { path: "src/a.ts" },
  ]);
});

test("围栏结束后的引用仍会被识别", () => {
  assert.deepEqual(
    fileReferences('```diff\n```not-a-closing-fence\n+ @../secret\n```\n@"src/a.ts"'),
    [{ path: "src/a.ts" }],
  );
});

test("Markdown 链接相对于文档目录且不能越出项目", () => {
  assert.deepEqual(resolveMarkdownFileReference("../src/main.ts#L2-L4", "docs/guide.md"), {
    path: "src/main.ts",
    startLine: 2,
    endLine: 4,
  });
  assert.deepEqual(resolveMarkdownFileReference("./notes.md", "docs/guide.md"), {
    path: "docs/notes.md",
  });
  assert.deepEqual(resolveMarkdownFileReference("../asset.bin", "docs/guide.md"), {
    path: "asset.bin",
  });
  for (const value of [
    "../../secret",
    "/etc/passwd",
    "file:///tmp/a",
    "https://example.com",
    "../notes.md#heading",
  ])
    assert.equal(resolveMarkdownFileReference(value, "docs/guide.md"), null);
  assert.deepEqual(resolveMarkdownFileReference("src/main.ts:2"), {
    path: "src/main.ts",
    startLine: 2,
    endLine: 2,
  });
});
