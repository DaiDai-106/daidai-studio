import type { McpToolSummary } from "../types.ts";

export function McpToolCatalog({
  tools,
  incomplete = false,
}: {
  tools: readonly McpToolSummary[];
  incomplete?: boolean;
}) {
  return (
    <section aria-label="MCP 工具目录">
      <h3>
        Tools <span className="count">{tools.length}</span>
      </h3>
      {incomplete && <p className="small muted">此响应还有下一页，当前仅展示已提供的工具。</p>}
      {!tools.length && <p className="small muted">此目录没有工具。</p>}
      <ul className="mcp-tool-list">
        {tools.map((tool) => (
          <li className="mcp-tool" key={tool.name}>
            <code>{tool.name}</code>
            {tool.description && <p>{tool.description}</p>}
          </li>
        ))}
      </ul>
    </section>
  );
}
