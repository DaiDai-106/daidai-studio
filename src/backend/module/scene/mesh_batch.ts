import { createHash } from "node:crypto";
import { normalizeStl } from "../../../shared/node/stl.ts";

export function createMeshBatch() {
  const assets = new Map<string, Buffer>();
  let totalBytes = 0;
  return {
    assets,
    add(bytes: Buffer) {
      const data = normalizeStl(bytes);
      const id = `${createHash("sha256").update(data).digest("hex")}.stl`;
      if (!assets.has(id)) {
        totalBytes += data.length;
        if (totalBytes > 48 * 1024 * 1024) throw new Error("导入网格总大小超过 48 MiB。");
        assets.set(id, data);
      }
      return id;
    },
  };
}
