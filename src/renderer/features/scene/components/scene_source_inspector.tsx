import { useMemo, useState } from "react";
import type {
  SceneDocument,
  SceneJoint,
  SceneJointPreview,
  SceneOperation,
} from "../../../../contracts/scene.ts";
import { sourcePartIds } from "../../../../shared/scene/geometry.ts";
import { SceneInspector } from "./scene_inspector.tsx";
import { SceneNewLinkFields } from "./scene_new_link_fields.tsx";

export function SceneSourceInspector({
  document,
  sourceIds,
  busy,
  apply,
  preview,
  onPreview,
}: {
  document: SceneDocument;
  sourceIds: string[];
  busy: boolean;
  preview: SceneJointPreview | undefined;
  onPreview(value: SceneJointPreview | undefined): void;
  apply(operation: SceneOperation, expectedRevision?: number): Promise<boolean>;
}) {
  const robot = document.robot;
  const source = document.sourceRobot;
  const parts = useMemo(
    () => (source ? sourcePartIds(source, sourceIds) : []),
    [source, sourceIds],
  );
  const owners = new Set(
    robot?.links
      .filter((link) => link.sourceParts?.some((part) => parts.includes(part.sourceId)))
      .map((link) => link.id),
  );
  const owner = owners.size === 1 ? robot?.links.find((link) => owners.has(link.id)) : undefined;
  const ownerJoint = robot?.joints.find((joint) => joint.childId === owner?.id);
  const allAssigned =
    owner && parts.every((id) => owner.sourceParts?.some((part) => part.sourceId === id));
  const [confirmation, setConfirmation] = useState<{
    operation: SceneOperation;
    revision: number;
  }>();
  const confirming = confirmation?.revision === document.revision ? confirmation : undefined;
  if (!robot || !source) return null;

  async function commit(operation: SceneOperation) {
    if (owners.size) setConfirmation({ operation, revision: document.revision });
    else await apply(operation, document.revision);
  }
  return (
    <section className="scene-source-config" aria-label="原始零件 URDF 配置">
      <p className="scene-details" title="原始 CAD 保留，配置写入同一份 URDF。">
        已选择 {parts.length} 个几何零件
      </p>
      {confirming && (
        <div className="scene-binding-confirmation" role="alert">
          <p>这些零件已有归属，继续将替换所选零件的绑定；原始 CAD 不会删除。</p>
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              if (await apply(confirming.operation, confirming.revision))
                setConfirmation(undefined);
            }}
          >
            确认重新分配或解除
          </button>
          <button type="button" onClick={() => setConfirmation(undefined)}>
            取消
          </button>
        </div>
      )}
      <form
        className="scene-inline scene-assignment"
        onSubmit={(event) => {
          event.preventDefault();
          const values = new FormData(event.currentTarget);
          void commit({ op: "assignSource", sourceIds, linkId: String(values.get("linkId")) });
        }}
      >
        <label>
          分配到连杆
          <select
            key={owner?.id}
            aria-label="分配到连杆"
            name="linkId"
            defaultValue={owner?.id ?? robot.rootLinkId}
          >
            {robot.links.map((link) => (
              <option key={link.id} value={link.id}>
                {link.name}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" disabled={busy || !parts.length}>
          分配零件
        </button>
      </form>
      <details className="scene-config-group" open={!owner}>
        <summary>用所选零件新建连杆</summary>
        <form
          className="scene-joint-form scene-create-link"
          aria-label="从零件创建连杆"
          onSubmit={(event) => {
            event.preventDefault();
            const values = new FormData(event.currentTarget);
            void commit({
              op: "createSourceLink",
              sourceIds,
              parentId: String(values.get("parentId")),
              linkName: String(values.get("linkName")),
              jointName: String(values.get("jointName")),
              jointType: values.get("jointType") as SceneJoint["type"],
            });
          }}
        >
          <SceneNewLinkFields>
            <label>
              新连杆的父级
              <select aria-label="新连杆的父级" name="parentId" defaultValue={robot.rootLinkId}>
                {robot.links.map((link) => (
                  <option key={link.id} value={link.id}>
                    {link.name}
                  </option>
                ))}
              </select>
            </label>
          </SceneNewLinkFields>
          <details className="scene-form-help">
            <summary>初始坐标如何确定？</summary>
            <p>初始连杆坐标取首个零件坐标，按关节零位保留 CAD 装配位置。原点和轴可在创建后调整。</p>
          </details>
          <button type="submit" disabled={busy || !parts.length}>
            创建连杆并分配
          </button>
        </form>
      </details>
      {owners.size > 0 && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void commit({ op: "unassignSource", sourceIds })}
        >
          解除所选零件绑定
        </button>
      )}
      {allAssigned && owner ? (
        <>
          <p className="scene-details">所属 Link：{owner.name}</p>
          <SceneInspector
            key={owner.id}
            robot={robot}
            target={{ entity: "link", node: owner }}
            busy={busy}
            revision={document.revision}
            apply={apply}
            preview={preview?.jointId === ownerJoint?.id ? preview?.position : undefined}
            onPreview={(position) =>
              onPreview(
                position === undefined || !ownerJoint
                  ? undefined
                  : { jointId: ownerJoint.id, position },
              )
            }
          />
        </>
      ) : (
        owners.size > 0 && (
          <p className="scene-details">
            所选零件尚未全部归到同一 Link，可重新分配，或单选零件编辑其所属 Link。
          </p>
        )
      )}
    </section>
  );
}
