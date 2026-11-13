import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  highlightCode,
  languageForPath,
} from "../../../src/renderer/features/coding/logic/syntax_highlighting.ts";

test("识别常用代码与机器人文件的语法", () => {
  assert.equal(languageForPath("src/example.tsx"), "tsx");
  assert.equal(languageForPath("a/example.py"), "python");
  assert.equal(languageForPath("example.CPP"), "cpp");
  assert.equal(languageForPath("robot.urdf"), "xml");
  assert.equal(languageForPath("README.unknown"), null);
});

test("常用语言在浅色和深色主题下生成可读的高亮", async () => {
  for (const [path, content] of [
    ["a.ts", "const answer = 42;"],
    ["a.py", "def greet():\n    return 'hi'"],
    ["a.css", "body { color: red; }"],
    ["a.cpp", "int main() { return 0; }"],
    ["robot.urdf", '<robot name="arm"/>'],
  ] as const) {
    for (const dark of [false, true]) {
      const lines = await highlightCode(path, content, dark);
      assert.ok(lines, path);
      assert.equal(
        lines.map((line) => line.map((token) => token.content).join("")).join("\n"),
        content,
      );
      assert.ok(new Set(lines.flatMap((line) => line.map((token) => token.color))).size > 1, path);
    }
  }
  assert.equal(await highlightCode("a.unknown", "text", false), null);
  assert.equal(await highlightCode("a.ts", "x".repeat(200_001), false), null);
  assert.equal(await highlightCode("a.ts", "x".repeat(10_001), false), null);
});
