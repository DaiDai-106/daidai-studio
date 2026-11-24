import { maxSceneAssetBytes, maxUrdfBytes, type SceneRobot } from "../../../../contracts/scene.ts";
import { validateRobot } from "../../../../shared/scene/robot.ts";
import { parseUrdf } from "../../../../shared/scene/urdf.ts";

export type PlanningScene = {
  name: string;
  robot: SceneRobot;
  readAsset: (id: string) => Promise<string>;
  warnings: string[];
};

export function sceneFilePath(file: File) {
  return file.webkitRelativePath || file.name;
}

function readMesh(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`无法读取网格：${file.name}。`));
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "");
    reader.readAsDataURL(file);
  });
}

function resolveRelativePath(directory: string, segments: string[]) {
  const folders = directory.split("/").filter(Boolean);
  const rootDepth = folders.length ? 1 : 0;
  for (const segment of segments) {
    if (segment === ".") continue;
    if (segment === "..") {
      if (folders.length <= rootDepth) return;
      folders.pop();
    } else folders.push(segment);
  }
  return folders.join("/");
}

export async function loadPlanningScene(urdf: File, files: File[]): Promise<PlanningScene> {
  if (urdf.size > maxUrdfBytes) throw new Error("URDF 文件超过 1 MiB。");
  const source = new TextDecoder("utf-8", { fatal: true }).decode(await urdf.arrayBuffer());
  const { robot, warnings } = parseUrdf(source);
  if (robot.links.length > 512 || robot.joints.length > 511)
    throw new Error("场景的连杆或关节数量超出预览限制。");
  validateRobot(robot);

  const path = sceneFilePath(urdf);
  const directory = path.slice(0, path.lastIndexOf("/") + 1);
  const byPath = new Map(files.map((file) => [sceneFilePath(file), file]));
  const assets = new Map<string, File>();
  const unavailable = new Set<string>();
  for (const link of robot.links) {
    for (const { geometry } of link.visuals) {
      if (geometry.type !== "mesh") continue;
      const { asset } = geometry;
      if (assets.has(asset) || unavailable.has(asset)) continue;
      const parts = asset.split("/");
      const valid =
        /\.stl$/iu.test(asset) && parts.every((part) => part && !/[:\\\p{Cc}]/u.test(part));
      const local = valid ? resolveRelativePath(directory, parts) : undefined;
      const file = local ? byPath.get(local) : undefined;
      if (file && file.size <= maxSceneAssetBytes) assets.set(asset, file);
      else unavailable.add(asset);
    }
  }
  return {
    name: path,
    robot,
    warnings: unavailable.size
      ? [
          `有 ${unavailable.size} 个 STL 未能在已选文件中定位。可以改用「选择 Package 目录」。`,
          ...warnings,
        ]
      : warnings,
    readAsset: async (id) => {
      const file = assets.get(id);
      if (!file) throw new Error(`缺少 STL：${id}。`);
      return readMesh(file);
    },
  };
}
