import { Dialog } from "../components/Dialog.tsx";
import type { McpServer } from "../types.ts";
import { McpToolCatalog } from "./McpToolCatalog.tsx";

// Uses backend registration metadata without starting a native process.
export function BuiltinMcpDialog({ server, onClose }: { server: McpServer; onClose: () => void }) {
  return (
    <Dialog title={server.name} onClose={onClose}>
      <p className="small muted">
        {server.available ? "内置服务 · 按需启动" : "内置服务 · 原生模块尚未安装"}
      </p>
      <McpToolCatalog tools={server.tools ?? []} />
    </Dialog>
  );
}
