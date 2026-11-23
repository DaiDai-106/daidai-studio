import { useRef, useState } from "react";
import type { SceneJoint, SceneOperation, SceneRobot } from "../../../../contracts/scene.ts";
import { SceneJointForm } from "./scene_joint_form.tsx";
import { SceneNewLinkFields } from "./scene_new_link_fields.tsx";

export type SceneTarget =
  | { entity: "link"; node: SceneRobot["links"][number] }
  | { entity: "joint"; node: SceneJoint };
type JointControlProps = {
  revision: number;
  busy: boolean;
  apply(operation: SceneOperation, expectedRevision?: number): Promise<boolean>;
  preview?: number | undefined;
  onPreview(position?: number): void;
};
const sliderKeys = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

function JointPositionControl({
  joint,
  revision,
  busy,
  apply,
  preview,
  onPreview,
}: JointControlProps & { joint: SceneJoint }) {
  const [location, setLocation] = useState({ saved: joint.position, text: String(joint.position) });
  if (location.saved !== joint.position)
    setLocation({ saved: joint.position, text: String(joint.position) });
  const interaction = useRef<{ revision: number; pointerId?: number } | undefined>(undefined);
  const min = joint.limit?.lower ?? Math.min(-Math.PI, joint.position);
  const max = joint.limit?.upper ?? Math.max(Math.PI, joint.position);
  const unit = joint.type === "prismatic" ? "m" : "rad";

  function cancel() {
    if (!interaction.current) return;
    interaction.current = undefined;
    onPreview();
  }

  function commit(position: number, expectedRevision: number) {
    interaction.current = undefined;
    if (
      expectedRevision !== revision ||
      busy ||
      !Number.isFinite(position) ||
      position === joint.position
    ) {
      onPreview();
      return;
    }
    void apply({ op: "setJointPosition", jointId: joint.id, position }, expectedRevision).finally(
      () => onPreview(),
    );
  }

  return (
    <form
      className="scene-inline"
      onSubmit={(event) => {
        event.preventDefault();
        if (location.text.trim()) commit(Number(location.text), revision);
      }}
    >
      <label className="scene-range">
        预览位置
        <input
          type="range"
          min={min}
          max={max}
          step="any"
          value={preview ?? joint.position}
          disabled={min === max}
          aria-disabled={busy}
          onChange={(event) => {
            if (!busy && interaction.current?.revision === revision)
              onPreview(event.currentTarget.valueAsNumber);
          }}
          onPointerDown={(event) => {
            if (busy || interaction.current || !event.isPrimary || event.button !== 0) {
              event.preventDefault();
              return;
            }
            interaction.current = { revision, pointerId: event.pointerId };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerUp={(event) => {
            const active = interaction.current;
            if (active?.pointerId === event.pointerId)
              commit(event.currentTarget.valueAsNumber, active.revision);
          }}
          onLostPointerCapture={(event) => {
            if (interaction.current?.pointerId === event.pointerId) cancel();
          }}
          onPointerCancel={cancel}
          onBlur={cancel}
          onKeyDown={(event) => {
            if (!sliderKeys.has(event.key)) return;
            if (busy || interaction.current?.pointerId !== undefined) event.preventDefault();
            else interaction.current ??= { revision };
          }}
          onKeyUp={(event) => {
            const active = interaction.current;
            if (active && active.pointerId === undefined && sliderKeys.has(event.key))
              commit(event.currentTarget.valueAsNumber, active.revision);
          }}
        />
      </label>
      <label>
        位置 ({unit})
        <input
          type="number"
          step="any"
          value={location.text}
          onChange={(event) => setLocation({ saved: joint.position, text: event.target.value })}
        />
      </label>
      <button type="submit" disabled={busy || !location.text.trim()}>
        应用位置
      </button>
    </form>
  );
}

export function SceneInspector({
  target,
  robot,
  ...controls
}: JointControlProps & { target: SceneTarget; robot: SceneRobot }) {
  const { busy, apply } = controls;
  const { id, name } = target.node;
  const rootLinkId = robot.rootLinkId;
  const joint =
    target.entity === "joint" ? target.node : robot.joints.find((joint) => joint.childId === id);
  const [draft, setDraft] = useState({ name, text: name });
  if (draft.name !== name) setDraft({ name, text: name });
  const draftName = draft.text.trim();
  const [removing, setRemoving] = useState(false);

  return (
    <section className="scene-inspector" aria-label="场景属性">
      <form
        className="scene-inline"
        onSubmit={(event) => {
          event.preventDefault();
          if (draftName && draftName !== name)
            void apply(
              { op: "rename", entity: target.entity, id, name: draftName },
              controls.revision,
            );
        }}
      >
        <label>
          {target.entity === "joint" ? "关节名称" : "连杆名称"}
          <input
            value={draft.text}
            maxLength={200}
            onChange={(event) => setDraft({ name, text: event.target.value })}
          />
        </label>
        <button type="submit" disabled={busy || !draftName || draftName === name}>
          保存名称
        </button>
      </form>
      {joint && (
        <SceneJointForm
          key={JSON.stringify({ ...joint, position: 0 })}
          robot={robot}
          joint={joint}
          busy={busy}
          revision={controls.revision}
          apply={apply}
        />
      )}
      {target.entity === "link" && joint && joint.type !== "fixed" && (
        <JointPositionControl {...controls} joint={joint} />
      )}
      {target.entity === "joint" ? (
        <>
          <p className="scene-details">
            {target.node.type === "fixed"
              ? "固定连接"
              : `${target.node.type} · 轴 [${target.node.axis.join(", ")}]`}
          </p>
          {target.node.type !== "fixed" && (
            <JointPositionControl {...controls} joint={target.node} />
          )}
        </>
      ) : (
        <div className="scene-link-controls">
          <details>
            <summary>添加子连杆</summary>
            <form
              className="scene-inline"
              onSubmit={async (event) => {
                event.preventDefault();
                const form = event.currentTarget;
                const values = new FormData(form);
                if (
                  await apply(
                    {
                      op: "addChildLink",
                      parentId: id,
                      linkName: String(values.get("linkName") ?? ""),
                      jointName: String(values.get("jointName") ?? ""),
                      jointType: values.get("jointType") as SceneJoint["type"],
                    },
                    controls.revision,
                  )
                )
                  form.reset();
              }}
            >
              <SceneNewLinkFields />
              <button type="submit" disabled={busy}>
                添加
              </button>
            </form>
          </details>
          {id !== rootLinkId && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                if (removing) {
                  setRemoving(false);
                  void apply({ op: "removeSubtree", linkId: id }, controls.revision);
                } else setRemoving(true);
              }}
            >
              {removing ? "确认删除子树并解除零件绑定" : "删除子树"}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
