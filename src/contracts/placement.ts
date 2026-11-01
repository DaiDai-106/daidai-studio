import { type Static, Type } from "typebox";
import { object } from "./schema.ts";

// 仅保留旧视图仍使用的通用位姿数据，不依赖旧 MCP 代码。
const coordinate = Type.Number({ minimum: -1e9, maximum: 1e9 });
export const PlacementSchema = object({
  importId: Type.String({ pattern: "^[0-9a-f]{64}$" }),
  sourceHash: Type.String({ pattern: "^[0-9a-f]{64}$" }),
  revision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  translation: Type.Tuple([coordinate, coordinate, coordinate]),
  rotation: Type.Tuple([Type.Number(), Type.Number(), Type.Number(), Type.Number()]),
  schemaVersion: Type.Literal(2),
});
export type Placement = Static<typeof PlacementSchema>;
