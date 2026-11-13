import { type ReactNode, useState } from "react";

import { useFileSearch } from "../logic/use_file_search.ts";

export function FileSearch({
  projectId,
  onSelect,
  children,
}: {
  projectId: string;
  onSelect: (path: string) => void;
  children?: ReactNode;
}) {
  const [query, setQuery] = useState("");
  const { result, error } = useFileSearch(projectId, query, !!query.trim());
  return (
    <div className="coding-file-search">
      <input
        aria-label="搜索项目文件"
        placeholder="搜索文件路径…"
        maxLength={200}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div hidden={!!query.trim()}>{children}</div>
      {query.trim() &&
        (error ? (
          <p role="alert">{error}</p>
        ) : !result ? (
          <p role="status">正在搜索…</p>
        ) : (
          <>
            <ul className="coding-search-results">
              {result.paths.map((path) => (
                <li key={path}>
                  <button
                    type="button"
                    className="coding-search-result"
                    onClick={() => onSelect(path)}
                  >
                    {path}
                  </button>
                </li>
              ))}
            </ul>
            {!result.paths.length && <p role="status">没有匹配文件。</p>}
            {result.truncated && <p role="status">已达到搜索上限，请缩小关键词或直接浏览目录。</p>}
          </>
        ))}
    </div>
  );
}
