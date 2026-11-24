import { type Static, Type } from "typebox";
import builtinMcpConfig from "../../modules/mcp_config/mcp.json" with { type: "json" };
import { object } from "./schema.ts";

const name = "dwgparser";
export const dwgParserProcess = {
  id: `builtin:${name}`,
  name,
  ...builtinMcpConfig.mcpServers[name],
} as const;

const status = object({
  state: Type.Enum(["missing", "ready", "invalid"]),
  directory: Type.String({ maxLength: 8192 }),
  message: Type.Optional(Type.String({ maxLength: 500 })),
});
export type DwgParserStatus = Static<typeof status>;

export const dwgParserCommands = {
  "mcp.dwgparser.status": object({}),
  "mcp.dwgparser.configure": object({ directory: status.properties.directory }),
  "mcp.dwgparser.refresh": object({}),
  "mcp.dwgparser.test": object({}),
};

export const dwgParserResults = {
  "mcp.dwgparser.status": status,
  "mcp.dwgparser.configure": status,
  "mcp.dwgparser.refresh": status,
  "mcp.dwgparser.test": object({
    tools: Type.Integer({ minimum: dwgParserProcess.requiredTools.length }),
  }),
};
