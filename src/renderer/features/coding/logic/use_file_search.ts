import { useEffect, useState } from "react";
import type { ApplicationBridge } from "../../../../contracts/bridge.ts";

type SearchResult = Awaited<ReturnType<ApplicationBridge["searchCodingFiles"]>>;

export function useFileSearch(projectId: string, query: string, enabled = true) {
  const [state, setState] = useState<{
    projectId: string;
    query: string;
    result: SearchResult | null;
    error: string;
  } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const timer = setTimeout(() => {
      void window.desktop.application.searchCodingFiles(projectId, query.trim()).then(
        (result) => {
          if (active) setState({ projectId, query, result, error: "" });
        },
        (cause: unknown) => {
          if (active)
            setState({
              projectId,
              query,
              result: null,
              error: cause instanceof Error ? cause.message : "文件搜索失败。",
            });
        },
      );
    }, 200);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [projectId, query, enabled]);
  return state?.projectId === projectId && state.query === query
    ? state
    : { result: null, error: "" };
}
