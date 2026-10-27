import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { _electron as electron } from "playwright";
import { chooseProject } from "./support.ts";

test("an incomplete STEP list permits a validated project-relative path", {
  timeout: 30_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-step-picker-"));
  const project = join(root, "project");
  const directory = join(project, "a", "b", "c", "d", "e", "f");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "part.step"), "fixture");
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
    await chooseProject(app, page, project);
    await page.getByRole("button", { name: "选择项目 STEP" }).click();
    const dialog = page.getByRole("dialog", { name: "选择项目 STEP" });
    await dialog.getByText(/清单不完整/).waitFor();
    const path = dialog.getByLabel("STEP 相对路径");
    await path.fill("../outside.step");
    await dialog.getByRole("button", { name: "选择此路径" }).click();
    await dialog.getByRole("alert").waitFor();
    await path.fill("a/b/c/d/e/f/part.step");
    await dialog.getByRole("button", { name: "选择此路径" }).click();
    await dialog.waitFor({ state: "hidden" });
    const workspace = await page.evaluate(() => window.desktop.application.getWorkspace());
    assert.equal(workspace.conversations[0]?.source?.relativePath, "a/b/c/d/e/f/part.step");
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
