import type { MessageInfo, ToolProgressInfo } from "../../shared/application.ts";
import { Icon } from "../components/Icon.tsx";

const phases: Record<string, string> = {
  verify_source: "核对文件版本",
  read_step: "读取 STEP",
  build_structure: "整理对象结构",
  build_display: "生成显示网格",
  write_display: "写入显示资源",
  validate_resources: "校验资源",
  measure_distance: "测量零件间距",
};

function toolLabel(tool: { name: string; displayName?: string; serverName?: string }) {
  const name = tool.displayName ?? tool.name;
  return tool.serverName ? `${tool.serverName} · ${name}` : name;
}

export function ToolResult({ message }: { message: MessageInfo }) {
  return (
    <details className={`tool-message ${message.failed ? "failed" : ""}`}>
      <summary>
        <Icon name={message.failed ? "close" : "check"} size={14} />
        <span className="tool-name" title={message.tool?.name}>
          {message.tool ? toolLabel(message.tool) : "工具"}
        </span>
        <small>{message.failed ? "未完成" : "已完成"}</small>
      </summary>
      <pre>{message.text}</pre>
    </details>
  );
}

export function ActiveTools({ tools }: { tools: ToolProgressInfo[] }) {
  return tools.map((tool) => (
    <div className="tool-message running" role="status" key={tool.id}>
      <Icon name="tool" size={14} />
      <span className="tool-name" title={tool.name}>
        {toolLabel(tool)}
      </span>
      <small>{tool.status === "pending" ? "等待执行" : (phases[tool.phase] ?? "执行中")}</small>
    </div>
  ));
}
