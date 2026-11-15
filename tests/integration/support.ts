import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { TestContext } from "node:test";
import { type ElectronApplication, _electron as electron, type Page } from "playwright";

export async function launchTestApp(context: TestContext) {
  const profile = await mkdtemp(join(tmpdir(), "dai-ui-"));
  let application: ElectronApplication | undefined;
  context.after(async () => {
    try {
      if (application?.process().exitCode === null) await application.close();
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  });
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[0] !== "ELECTRON_RUN_AS_NODE" && entry[1] !== undefined,
    ),
  );
  application = await electron.launch({
    args: [process.cwd(), `--user-data-dir=${profile}`],
    env,
    chromiumSandbox: true,
  });
  return { application, page: await application.firstWindow(), profile };
}

export async function openTestProject(
  application: ElectronApplication,
  page: Page,
  profile: string,
  mode: "coding" = "coding",
) {
  const directory = join(profile, "project");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "example.ts"), "export const example = 1;\n");
  await chooseProject(application, page, directory, mode);
  await page.getByRole("textbox", { name: "消息内容", exact: true }).waitFor();
  return directory;
}

export async function chooseProject(
  application: ElectronApplication,
  page: Page,
  directory: string,
  _mode: "coding" = "coding",
) {
  // Only the native picker is substituted. Directory enumeration and all backend
  // persistence, authentication, rendering and IPC use the production code.
  await application.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, directory);
  await page.getByRole("button", { name: "新建项目", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "新建项目" });
  await dialog.getByLabel("项目名称").fill(basename(directory));
  await dialog.getByRole("button", { name: "选择文件夹", exact: true }).click();
  await dialog.getByRole("button", { name: "创建项目", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "新建对话", exact: true }).last().click();
  await page.getByRole("textbox", { name: "消息内容", exact: true }).waitFor();
}
