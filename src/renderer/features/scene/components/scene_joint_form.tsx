import { useState } from "react";
import {
  type SceneJoint,
  type SceneOperation,
  type SceneRobot,
  sceneJointTypes,
} from "../../../../contracts/scene.ts";

import { subtreeLinkIds } from "../../../../shared/scene/tree.ts";

export function SceneJointForm({
  robot,
  joint,
  busy,
  revision,
  apply,
}: {
  robot: SceneRobot;
  joint: SceneJoint;
  busy: boolean;
  revision: number;
  apply(operation: SceneOperation, expectedRevision?: number): Promise<boolean>;
}) {
  const [type, setType] = useState(joint.type);
  const [effort, setEffort] = useState<string>();
  const [velocity, setVelocity] = useState<string>();
  const bounded = type === "revolute" || type === "prismatic";
  const effortValue = effort ?? joint.limit?.effort ?? (bounded ? 0 : "");
  const velocityValue = velocity ?? joint.limit?.velocity ?? (bounded ? 0 : "");
  const hasLimit = bounded || effortValue !== "" || velocityValue !== "";
  const descendants = subtreeLinkIds(robot, [joint.childId]);
  return (
    <form
      className="scene-joint-form scene-joint-config"
      aria-label="关节配置"
      onSubmit={(event) => {
        event.preventDefault();
        const values = new FormData(event.currentTarget);
        const num = (name: string) => Number(values.get(name));
        const vector = (name: string): [number, number, number] => [
          num(`${name}0`),
          num(`${name}1`),
          num(`${name}2`),
        ];
        void apply(
          {
            op: "updateJoint",
            jointId: joint.id,
            name: String(values.get("jointName")),
            parentId: String(values.get("parentId")),
            jointType: type,
            origin: { xyz: vector("xyz"), rpy: vector("rpy") },
            axis: type === "fixed" ? joint.axis : vector("axis"),
            ...(type !== "fixed" && hasLimit
              ? {
                  limit: {
                    effort: num("effort"),
                    velocity: num("velocity"),
                    ...(bounded ? { lower: num("lower"), upper: num("upper") } : {}),
                  },
                }
              : {}),
          },
          revision,
        );
      }}
    >
      <strong>父关节配置</strong>
      <label>
        父关节名称
        <input name="jointName" defaultValue={joint.name} required maxLength={200} />
      </label>
      <label>
        父连杆
        <select aria-label="父连杆" name="parentId" defaultValue={joint.parentId}>
          {robot.links
            .filter((link) => !descendants.has(link.id))
            .map((link) => (
              <option key={link.id} value={link.id}>
                {link.name}
              </option>
            ))}
        </select>
      </label>
      <label>
        关节类型
        <select
          aria-label="关节类型"
          value={type}
          onChange={(event) => setType(event.target.value as SceneJoint["type"])}
        >
          {sceneJointTypes.map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
      </label>
      {(
        [
          ["xyz", "原点位置 (m)", joint.origin.xyz],
          ["rpy", "原点姿态 (rad)", joint.origin.rpy],
          ...(type === "fixed" ? [] : [["axis", "关节轴", joint.axis]]),
        ] as [string, string, number[]][]
      ).map(([name, label, vector]) => (
        <fieldset key={name} className="scene-vector">
          <legend>{label}</legend>
          {vector.map((value, index) => (
            <label key={["X", "Y", "Z"][index]}>
              {["X", "Y", "Z"][index]}
              <input
                aria-label={`${label} ${["X", "Y", "Z"][index]}`}
                name={`${name}${index}`}
                type="number"
                step="any"
                required
                defaultValue={value}
              />
            </label>
          ))}
        </fieldset>
      ))}
      {type !== "fixed" && (
        <>
          {bounded && (
            <div className="scene-inline">
              <label>
                下限
                <input
                  name="lower"
                  type="number"
                  step="any"
                  required
                  defaultValue={joint.limit?.lower ?? -1}
                />
              </label>
              <label>
                上限
                <input
                  name="upper"
                  type="number"
                  step="any"
                  required
                  defaultValue={joint.limit?.upper ?? 1}
                />
              </label>
            </div>
          )}
          <div className="scene-inline">
            <label>
              最大力/力矩
              <input
                name="effort"
                type="number"
                step="any"
                min="0"
                required={hasLimit}
                value={effortValue}
                onChange={(event) => setEffort(event.target.value)}
              />
            </label>
            <label>
              最大速度
              <input
                name="velocity"
                type="number"
                step="any"
                min="0"
                required={hasLimit}
                value={velocityValue}
                onChange={(event) => setVelocity(event.target.value)}
              />
            </label>
          </div>
        </>
      )}
      <button type="submit" disabled={busy}>
        保存关节配置
      </button>
    </form>
  );
}
