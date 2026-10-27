import { readFile } from "node:fs/promises";
import type { SceneReference } from "../../shared/application.ts";
import type { SceneContext } from "./types.ts";

/** Resolve only an object in the current, verified display catalogue. */
export async function resolveSceneReference(reference: SceneReference, scene: SceneContext) {
  if (
    !scene.currentDisplay ||
    scene.currentDisplay.importId !== reference.importId ||
    scene.currentDisplay.placement.revision !== reference.revision
  )
    throw new Error("引用的场景或定位版本已变化，请重新选择对象。");
  if (!scene.files || scene.files.catalogError)
    throw new Error("当前对象目录不可用，请重新加载场景后再引用对象。");
  for (const page of scene.files.objects) {
    const lines = (await readFile(page.path, "utf8")).split("\n");
    for (const line of lines) {
      if (!line) continue;
      const value: unknown = JSON.parse(line);
      if (
        value &&
        typeof value === "object" &&
        "objectId" in value &&
        value.objectId === reference.objectId &&
        "name" in value &&
        typeof value.name === "string"
      )
        return { ...reference, name: value.name };
    }
  }
  throw new Error("引用的对象不属于当前场景，请重新选择对象。");
}
