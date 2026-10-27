import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { _electron as electron } from "playwright";

test("skill image upload preserves concurrent edits and discarding an edit cleans up only new images", {
  timeout: 45_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-skill-image-ui-"));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[0] !== "ELECTRON_RUN_AS_NODE" && entry[1] !== undefined,
    ),
  );
  const app = await electron.launch({
    args: [process.cwd(), `--user-data-dir=${root}`],
    env,
    chromiumSandbox: true,
  });
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(10_000);
    await page.evaluate(async () => {
      await window.desktop.application.saveSkill({
        id: "image-ui",
        name: "图片技能",
        description: "参考图片",
        body: "原始正文",
        enabled: true,
        scope: { kind: "global" },
        modes: ["scene"],
        sceneProfile: "steel-structure",
      });
      const read = FileReader.prototype.readAsDataURL;
      FileReader.prototype.readAsDataURL = function (blob: Blob) {
        setTimeout(() => read.call(this, blob), 500);
      };
    });
    await page.getByRole("button", { name: "工具与技能", exact: true }).first().click();
    const card = page.getByRole("article", { name: "图片技能" });
    await card.getByRole("button", { name: "编辑技能" }).click();
    let dialog = page.getByRole("dialog", { name: "编辑技能" });
    const image = await readFile(
      resolve("resources/skills/steel-structure/images/upright-reference.png"),
    );
    await dialog
      .getByLabel("参考图片")
      .setInputFiles({ name: "one.png", mimeType: "image/png", buffer: image });
    await dialog.getByRole("textbox", { name: "Markdown 正文" }).fill("上传时编辑的正文");
    await dialog.getByText("one.png", { exact: true }).waitFor();
    assert.match(
      await dialog.getByRole("textbox", { name: "Markdown 正文" }).inputValue(),
      /^上传时编辑的正文/,
    );
    await dialog.getByRole("button", { name: "保存技能" }).click();
    await dialog.waitFor({ state: "hidden" });

    const stored = await page.evaluate(async () =>
      (await window.desktop.application.getWorkspace()).settings.skills.find(
        (item) => item.id === "image-ui",
      ),
    );
    assert.match(stored?.body ?? "", /^上传时编辑的正文/);
    assert.equal(stored?.images?.length, 1);
    await card.getByRole("button", { name: "编辑技能" }).click();
    dialog = page.getByRole("dialog", { name: "编辑技能" });
    await dialog
      .getByLabel("参考图片")
      .setInputFiles({ name: "two.png", mimeType: "image/png", buffer: image });
    await dialog.getByText("two.png", { exact: true }).waitFor();
    await dialog.getByRole("button", { name: "关闭弹窗" }).click();
    await dialog.getByRole("button", { name: "放弃修改" }).click();
    await dialog.waitFor({ state: "hidden" });

    const directory = join(
      root,
      "data",
      "skill-images",
      createHash("sha256").update("image-ui").digest("hex"),
      "images",
    );
    assert.equal((await readdir(directory)).length, 1);
    assert.ok(stored?.images?.[0]);
    assert.ok(
      await page.evaluate(
        async (path) => window.desktop.application.readSkillImage("image-ui", path),
        stored.images[0].path,
      ),
    );
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
