import { cadDisplayDescriptions } from "./contract.ts";

// Distribution and display metadata. Calls still use the discovered stdio contract.
export const cadPlugin = {
  id: "builtin.cad",
  name: "cad-mcp",
  description: "解析 STEP、查询精确几何、拆分独立实体并生成显示资源。",
  modes: ["scene" as const],
  toolDescriptions: cadDisplayDescriptions,
};
