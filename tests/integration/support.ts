import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ElectronApplication, Page } from "playwright";

export async function openTestProject(
  application: ElectronApplication,
  page: Page,
  profile: string,
  mode: "general" | "scene" | "robot" = "general",
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
  await chooseProject(application, page, directory, mode);
  await page.getByRole("textbox", { name: "消息内容", exact: true }).waitFor();
  return directory;
}

export async function chooseProject(
  application: ElectronApplication,
  page: Page,
  directory: string,
  mode: "general" | "scene" | "robot" = "general",
) {
  // Only the native picker is substituted. Directory enumeration and all backend
  // persistence, authentication, rendering and IPC use the production code.
  await application.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, directory);
  await page.getByRole("button", { name: "新建项目", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "新建项目" });
  await dialog.getByLabel("项目名称").fill(basename(directory));
  if (mode !== "general") {
    await dialog.getByLabel("项目模式").click();
    await page
      .getByRole("menuitemradio", { name: mode === "scene" ? "场景搭建" : "Dai Robotics" })
      .click();
  }
  await dialog.getByRole("button", { name: "选择文件夹", exact: true }).click();
  await dialog.getByRole("button", { name: "创建项目", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "新建对话", exact: true }).last().click();
  await page.getByRole("textbox", { name: "消息内容", exact: true }).waitFor();
}
