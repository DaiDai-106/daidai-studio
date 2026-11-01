import DOMPurify from "dompurify";
import { useEffect, useId, useState } from "react";
import { Dialog } from "./Dialog.tsx";

let renderQueue: Promise<void> = Promise.resolve();

export function MermaidDiagram({ source }: { source: string }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const [result, setResult] = useState<{
    source: string;
    url: string;
    width: number;
    height: number;
  } | null>(null);
  const [dark, setDark] = useState(() => document.documentElement.dataset.theme === "dark");
  const [expanded, setExpanded] = useState(false);
  const [zoom, setZoom] = useState(1.5);

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setDark(document.documentElement.dataset.theme === "dark");
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let active = true;
    setResult(null);
    const timer = window.setTimeout(() => {
      // Mermaid 的配置是全局状态，顺序渲染以避免不同主题的图互相干扰。
      renderQueue = renderQueue.then(async () => {
        if (!active || source.length > 50000) return;
        try {
          const { default: mermaid } = await import("mermaid");
          if (!active) return;
          mermaid.initialize({
            startOnLoad: false,
            securityLevel: "strict",
            theme: dark ? "dark" : "default",
            htmlLabels: false,
            flowchart: { htmlLabels: false },
            secure: ["securityLevel", "secure", "themeCSS", "htmlLabels", "flowchart"],
          });
          const { svg } = await mermaid.render(`daiMermaid${id}`, source);
          const clean = DOMPurify.sanitize(svg, {
            USE_PROFILES: { svg: true, svgFilters: true },
            FORBID_TAGS: ["a", "foreignObject", "script"],
          });
          const root = new DOMParser().parseFromString(clean, "image/svg+xml").documentElement;
          const dimensions = root.getAttribute("viewBox")?.split(/[\s,]+/) ?? [];
          const width = Number(dimensions[2]);
          const height = Number(dimensions[3]);
          if (
            !Number.isFinite(width) ||
            width <= 0 ||
            width > 10000 ||
            !Number.isFinite(height) ||
            height <= 0
          )
            return;
          if (active)
            setResult({
              source,
              url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(clean)}`,
              width,
              height,
            });
        } catch {
          // 流式输出尚未结束或语法无效时保留原文。
        }
      });
    }, 350);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [source, dark, id]);

  if (!result || result.source !== source)
    return (
      <pre>
        <code>{source}</code>
      </pre>
    );
  return (
    <>
      <div className="mermaid-diagram">
        <div className="mermaid-diagram-actions">
          <button
            type="button"
            onClick={() => {
              setZoom(1.5);
              setExpanded(true);
            }}
          >
            展开查看
          </button>
        </div>
        <div className="mermaid-diagram-scroll">
          <img
            src={result.url}
            alt="Mermaid 图表"
            style={{
              width: `min(${result.width}px, 100%, calc(min(65dvh, 600px) * ${result.width / result.height}))`,
            }}
          />
        </div>
      </div>
      {expanded && (
        <Dialog title="查看图表" className="mermaid-dialog" onClose={() => setExpanded(false)}>
          <div className="mermaid-preview">
            <div className="mermaid-preview-toolbar">
              <button
                type="button"
                onClick={() => setZoom((value) => Math.max(0.5, value - 0.25))}
                disabled={zoom <= 0.5}
                aria-label="缩小图表"
              >
                −
              </button>
              <span aria-live="polite">{Math.round(zoom * 100)}%</span>
              <button
                type="button"
                onClick={() => setZoom((value) => Math.min(4, value + 0.25))}
                disabled={zoom >= 4}
                aria-label="放大图表"
              >
                +
              </button>
              <button type="button" onClick={() => setZoom(1)}>
                原始大小
              </button>
            </div>
            <div className="mermaid-preview-scroll">
              <img
                src={result.url}
                alt="放大的 Mermaid 图表"
                style={{ width: result.width * zoom }}
              />
            </div>
          </div>
        </Dialog>
      )}
    </>
  );
}
