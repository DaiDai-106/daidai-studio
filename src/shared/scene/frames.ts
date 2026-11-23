import { Euler, Group, type Matrix4, type Object3D, Quaternion, Vector3 } from "three";
import type {
  SceneJoint,
  SceneJointPreview,
  SceneOrigin,
  SceneRobot,
} from "../../contracts/scene.ts";

export function setOrigin(object: Object3D, origin: SceneOrigin) {
  object.position.fromArray(origin.xyz);
  // URDF uses fixed-axis roll, pitch, yaw: Rz(yaw) · Ry(pitch) · Rx(roll).
  object.quaternion.setFromEuler(new Euler(...origin.rpy, "ZYX"));
}

export function robotFrames(robot: SceneRobot) {
  const links = new Map(robot.links.map((link) => [link.id, new Group()]));
  const origins = new Map<string, Group>();
  const motions = new Map<string, { child: Group; axis: Vector3 }>();
  for (const joint of robot.joints) {
    const parent = links.get(joint.parentId);
    const child = links.get(joint.childId);
    if (!parent || !child) continue;
    const origin = joint.type === "fixed" ? child : new Group();
    setOrigin(origin, joint.origin);
    parent.add(origin);
    origins.set(joint.id, origin);
    if (origin !== child) {
      origin.add(child);
      motions.set(joint.id, { child, axis: new Vector3(...joint.axis).normalize() });
    }
  }
  return {
    root: links.get(robot.rootLinkId) ?? new Group(),
    links,
    origins,
    pose(joints: SceneJoint[], preview?: SceneJointPreview) {
      for (const joint of joints) {
        const frame = motions.get(joint.id);
        if (!frame) continue;
        const position = preview?.jointId === joint.id ? preview.position : joint.position;
        if (joint.type === "prismatic")
          frame.child.position.copy(frame.axis).multiplyScalar(position);
        else frame.child.quaternion.setFromAxisAngle(frame.axis, position);
      }
    },
  };
}

export function coordinates(matrix: Matrix4): SceneOrigin {
  const xyz = new Vector3();
  const rotation = new Quaternion();
  matrix.decompose(xyz, rotation, new Vector3());
  const { x, y, z } = new Euler().setFromQuaternion(rotation, "ZYX");
  return { xyz: xyz.toArray(), rpy: [x, y, z] };
}

export function sceneCoordinates(
  robot: SceneRobot,
  entity: "link" | "joint",
  id: string,
  preview?: SceneJointPreview,
) {
  const frames = robotFrames(robot);
  const frame = (entity === "link" ? frames.links : frames.origins).get(id);
  if (!frame) return;
  const joint = robot.joints.find((joint) =>
    entity === "link" ? joint.childId === id : joint.id === id,
  );
  const parent = joint && frames.links.get(joint.parentId);
  frames.pose(robot.joints, preview);
  frame.updateWorldMatrix(true, false);
  const world = coordinates(frame.matrixWorld);
  return {
    local: parent
      ? coordinates(parent.matrixWorld.clone().invert().multiply(frame.matrixWorld))
      : world,
    world,
  };
}
