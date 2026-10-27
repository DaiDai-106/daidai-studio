import { lstat, realpath } from "node:fs/promises";
import { basename } from "node:path";
import { listSteps } from "../../../resources/mcp/scene-profiles/steps.ts";
import type { ProjectInfo } from "../../shared/application.ts";
import { fileHash, resolveStepPath } from "./source.ts";

export async function projectDirectory(path: string) {
  const resolved = await realpath(path);
  if (!(await lstat(resolved)).isDirectory()) throw new Error("请选择本地项目目录。");
  return { path: resolved, name: basename(resolved) || resolved };
}
export async function projectFiles(project: {
  id: string;
  name: string;
  path: string;
}): Promise<ProjectInfo> {
  const info = { id: project.id, name: project.name, path: project.path };
  try {
    await projectDirectory(project.path);
    const steps = await listSteps(project.path);
    return { ...info, files: steps.files, filesComplete: steps.complete, available: true };
  } catch {
    return { ...info, files: [], filesComplete: false, available: false };
  }
}

export async function authorizeStepPath(
  projectRoot: string,
  source: { path: string; relativePath: string; sha256: string } | null,
  path: unknown,
  signal: AbortSignal,
) {
  if (!source || typeof path !== "string" || path !== source.path)
    throw new Error("CAD 导入 path 必须是当前选中 STEP 的绝对路径。");
  const file = await resolveStepPath(projectRoot, source.relativePath);
  if ((await fileHash(file.path, 512 * 1024 * 1024, signal)).sha256 !== source.sha256)
    throw new Error("STEP 在本轮执行期间发生变化，请重新发送请求。");
}
