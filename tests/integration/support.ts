import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ElectronApplication, Page } from "playwright";

export async function openTestProject(
  application: ElectronApplication,
  page: Page,
  profile: string,
) {
  const directory = join(profile, "project");
  await mkdir(join(directory, "assemblies"), { recursive: true });
  await writeFile(
    join(directory, "assemblies", "robot-arm.step"),
    "STEP test placeholder; deliberately not parsed.",
  );
  await writeFile(
    join(directory, "bracket.stp"),
    "STEP test placeholder; deliberately not parsed.",
  );
  await chooseProject(application, page, directory);
  await page.getByRole("textbox", { name: "消息内容", exact: true }).waitFor();
  return directory;
}

export async function chooseProject(
  application: ElectronApplication,
  page: Page,
  directory: string,
) {
  // Only the native picker is substituted. Directory enumeration and all backend
  // persistence, authentication, rendering and IPC use the production code.
  await application.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, directory);
  await page.getByRole("button", { name: "打开项目", exact: true }).first().click();
}
