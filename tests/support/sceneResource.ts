import type { ResourceLocation } from "../../src/contracts/process.ts";
import { createSceneResourceReader } from "../../src/desktop/main/resourceReader.ts";

export async function readSceneResource(root: string, resource: ResourceLocation, hash: string) {
  const reader = createSceneResourceReader(root);
  try {
    return await reader.read(resource, hash);
  } finally {
    reader.close();
  }
}
