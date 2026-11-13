import type { SceneView } from "../../../../contracts/application.ts";

const typeNames = { fixed: "固定", revolute: "旋转", prismatic: "滑动" } as const;
const validityNames = {
  current: "依据未变化",
  stale: "依据已变化，请重新检查",
  invalidated: "关联对象不可用，请重新检查",
} as const;

export function SceneJoints({
  scene,
  busy,
  onConfirm,
  onRemove,
}: {
  scene: SceneView;
  busy: boolean;
  onConfirm: (id: string) => void;
  onRemove: (id: string, confirmed: boolean) => void;
}) {
  if (!scene.joints.length) return null;

  function objectName(ref: { modelId: string; objectId: string }) {
    const model = scene.models.find((item) => item.id === ref.modelId);
    return model?.objects.find((item) => item.id === ref.objectId)?.name || ref.objectId;
  }
  return (
    <section className="scene-joints" aria-label="关节候选">
      <strong>关节候选</strong>
      <p>候选由模型提出，轴向与连接尚需核验；限位未知。</p>
      {scene.joints.map((joint) => (
        <div className="scene-joint" key={joint.id}>
          <span>
            {objectName(joint.parent)} → {objectName(joint.child)} · {typeNames[joint.type]}
          </span>
          <span>
            {joint.status === "draft" ? "待确认" : "用户已确认"} · {validityNames[joint.validity]} ·
            限位未知
          </span>
          {joint.axis && (
            <small>
              父对象局部轴：原点 ({joint.axis.origin.join(", ")}) 米，方向 (
              {joint.axis.direction.join(", ")})
            </small>
          )}
          {joint.status === "draft" && (
            <button
              type="button"
              disabled={busy || joint.validity !== "current"}
              onClick={() => onConfirm(joint.id)}
            >
              确认候选
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => onRemove(joint.id, joint.status === "confirmed")}
          >
            {joint.status === "draft" ? "放弃草稿" : "移除已确认关节"}
          </button>
        </div>
      ))}
    </section>
  );
}
