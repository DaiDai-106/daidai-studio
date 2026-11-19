import assert from "node:assert/strict";
import { test } from "node:test";
import { getReleaseNotes } from "../../src/shared/changelog.ts";

test("发布说明只提取对应版本，保留该版本正文的 Markdown", () => {
  const changelog = [
    "# Changelog",
    "## [Unreleased]",
    "- Draft",
    "## [0.0.10]",
    "- Later change",
    "## [0.0.1] - 2026-11-19",
    "### Changes",
    "",
    "- First launch",
    "## [0.0.0]",
    "- Older change",
  ].join("\r\n");
  assert.equal(getReleaseNotes(changelog, "0.0.1"), "### Changes\r\n\r\n- First launch");
  assert.equal(getReleaseNotes(changelog, "0.0.2"), undefined);
  assert.equal(getReleaseNotes("# Changelog\n## [0.0.1]\n", "0.0.1"), undefined);
});
