import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { SceneJoint, SceneRobot, SceneSelection } from "../../../../contracts/scene.ts";
import { Icon } from "../../../shared/components/icon.tsx";

export function SceneTree({
  robot,
  selection,
  picked,
  readOnly = false,
  hidden,
  onSelect,
}: {
  robot: SceneRobot;
  selection: SceneSelection;
  picked?: SceneSelection | undefined;
  readOnly?: boolean;
  hidden?: boolean;
  onSelect(selection: SceneSelection): void;
}) {
  const { links, children, parents } = useMemo(
    () => ({
      links: new Map(robot.links.map(({ id, name }) => [id, name])),
      children: Map.groupBy(robot.joints, ({ parentId }) => parentId),
      parents: new Map(robot.joints.map(({ childId, parentId }) => [childId, parentId])),
    }),
    [robot],
  );
  const roots = children.get(robot.rootLinkId);
  const [expanded, setExpanded] = useState(
    () => new Set(readOnly ? roots?.map(({ childId }) => childId) : [robot.rootLinkId]),
  );
  const [lastPick, setLastPick] = useState<SceneSelection>();
  const pickedButton = useRef<HTMLButtonElement>(null);

  if (picked !== lastPick) {
    setLastPick(picked);
    if (picked) {
      const next = new Set(expanded);
      for (let id = parents.get(picked.id); id !== undefined; id = parents.get(id)) {
        next.add(id);
      }
      setExpanded(next);
    }
  }

  useLayoutEffect(() => {
    if (picked && !hidden)
      pickedButton.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [picked, hidden]);

  function toggle(id: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  function branch(id: string, depth: number, joint?: SceneJoint) {
    const name = links.get(id) ?? id;
    const childJoints = children.get(id);
    const open = expanded.has(id);
    const linkSelected = selection.entity === "link" && selection.id === id;
    const jointSelected = selection.entity === "joint" && selection.id === joint?.id;
    return (
      <li key={id}>
        <div className="scene-tree-row" style={{ marginInlineStart: Math.min(depth, 6) * 8 }}>
          {childJoints ? (
            <button
              type="button"
              className="scene-tree-toggle"
              aria-expanded={open}
              aria-label={`${open ? "收起" : "展开"} ${name}`}
              onClick={() => toggle(id)}
            >
              <Icon name="chevron" size={14} />
            </button>
          ) : (
            <span className="scene-tree-spacer" aria-hidden="true" />
          )}
          <button
            type="button"
            className="scene-tree-link"
            aria-current={linkSelected ? "true" : undefined}
            title={name}
            ref={picked?.id === id ? pickedButton : undefined}
            onClick={() => onSelect({ entity: "link", id })}
          >
            <Icon name={childJoints ? "assembly" : "box"} size={14} />
            <span>{name}</span>
          </button>
          {joint && !readOnly && (
            <button
              type="button"
              className="scene-tree-joint"
              aria-current={jointSelected ? "true" : undefined}
              aria-label={joint.name}
              title={`${joint.name} · ${joint.type === "fixed" ? "固定连接" : joint.type}`}
              onClick={() => onSelect({ entity: "joint", id: joint.id })}
            >
              <Icon name="joint" size={13} />
            </button>
          )}
        </div>
        {open && childJoints && (
          <ul>{childJoints.map((child) => branch(child.childId, depth + 1, child))}</ul>
        )}
      </li>
    );
  }

  return (
    <nav
      className="scene-tree"
      aria-label={readOnly ? "原始模型结构树" : "机器人结构树"}
      hidden={hidden}
    >
      <header className="scene-tree-header">
        <strong>{readOnly ? "只读 CAD 装配" : "场景结构"}</strong>
        <span>
          {readOnly ? `${robot.links.length - 1} 个对象` : `${robot.links.length} 个连杆`}
        </span>
      </header>
      <div className="scene-tree-scroll">
        <ul>
          {readOnly ? roots?.map(({ childId }) => branch(childId, 0)) : branch(robot.rootLinkId, 0)}
        </ul>
      </div>
    </nav>
  );
}
