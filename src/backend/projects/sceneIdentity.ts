import { createHash } from "node:crypto";

/** 同资源的重复导入需要独立身份；追加不会改变已有模型的顺序。 */
export function sceneModelId(
  model: { source: { path: string }; resource: { sha256: string }; stableId?: string },
  index: number,
): string {
  return (
    model.stableId ??
    createHash("sha256")
      .update(JSON.stringify([model.source.path, model.resource.sha256, index]))
      .digest("hex")
  );
}
