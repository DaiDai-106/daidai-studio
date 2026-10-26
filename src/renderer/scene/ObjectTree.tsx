import { useEffect, useMemo, useState } from "react";
import type { CadManifest } from "../../../resources/mcp/cad/contract.ts";
import { Icon } from "../components/Icon.tsx";

export function ObjectTree({
  manifest,
  selected,
  onSelect,
}: {
  manifest: CadManifest;
  selected: string | null;
  onSelect(id: string): void;
}) {
  const [collapsed, setCollapsed] = useState(
    () =>
      new Set(
        manifest.objects.filter((object) => object.parentObjectId).map((object) => object.objectId),
      ),
  );
  const objects = useMemo(
    () => new Map(manifest.objects.map((object) => [object.objectId, object])),
    [manifest],
  );
  useEffect(() => {
    if (!selected) return;
    setCollapsed((previous) => {
      const next = new Set(previous);
      let object = objects.get(selected);
      while (object?.parentObjectId) {
        next.delete(object.parentObjectId);
        object = objects.get(object.parentObjectId);
      }
      return next;
    });
  }, [selected, objects]);
  const children = new Map<string, typeof manifest.objects>();
  for (const object of manifest.objects) {
    const parent = object.parentObjectId ?? "";
    const items = children.get(parent) ?? [];
    items.push(object);
    children.set(parent, items);
  }
  function branch(parent: string, depth: number): React.ReactNode {
    return (children.get(parent) ?? []).map((object) => {
      const nested = children.has(object.objectId);
      const expanded = !collapsed.has(object.objectId);
      const unavailable =
        object.display && object.display.faceCount === object.display.omittedFaceCount;
      return (
        <li key={object.objectId} data-selected={selected === object.objectId}>
          <div className="object-tree-row" style={{ paddingLeft: 8 + depth * 12 }}>
            <button
              type="button"
              className="object-tree-toggle"
              aria-expanded={nested ? expanded : undefined}
              aria-label={`${expanded ? "折叠" : "展开"} ${object.name}`}
              disabled={!nested}
              onClick={() =>
                setCollapsed((previous) => {
                  const next = new Set(previous);
                  if (next.has(object.objectId)) next.delete(object.objectId);
                  else next.add(object.objectId);
                  return next;
                })
              }
            >
              {nested && <Icon name={expanded ? "chevron-down" : "chevron"} size={12} />}
            </button>
            <button
              type="button"
              className="object-tree-name"
              aria-pressed={selected === object.objectId}
              onClick={() => onSelect(object.objectId)}
              title={object.name}
            >
              <Icon name={nested ? "layers" : "box"} size={13} />
              <span>{object.name || "未命名对象"}</span>
              {unavailable && <span className="muted">未显示</span>}
            </button>
          </div>
          {nested && expanded && <ul>{branch(object.objectId, depth + 1)}</ul>}
        </li>
      );
    });
  }
  return (
    <ul className="object-tree" aria-label="CAD 对象树">
      {branch("", 0)}
    </ul>
  );
}
