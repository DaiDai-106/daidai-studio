import assert from "node:assert/strict";
import { test } from "node:test";
import { Mesh, Vector3 } from "three";
import { parseUrdf } from "../../../src/backend/scene/urdf.ts";
import {
  robotFrames,
  sceneCoordinates,
} from "../../../src/renderer/features/scene/logic/robot_frames.ts";
import { createRobotModel } from "../../../src/renderer/features/scene/logic/robot_model.ts";
import { testRobot } from "../../support/scene_fixture.ts";

test("预览在关节的局部坐标系中变换，清除预览恢复已提交位置", () => {
  const { robot } = parseUrdf(
    testRobot.replace('xyz="0 0 0.2"', 'xyz="0 0 0.2" rpy="1.5707963267948966 0 0"'),
  );
  const joint = robot.joints[0];
  assert.ok(joint);
  const frames = robotFrames(robot);
  const child = frames.links.get(joint.childId);
  assert.ok(child);
  frames.pose(robot.joints, { jointId: joint.id, position: Math.PI / 2 });
  const tip = child.localToWorld(new Vector3(1, 0, 0));
  assert.ok(tip.distanceTo(new Vector3(0, 0, 1.2)) < 1e-8);
  const moving = sceneCoordinates(robot, "link", joint.childId, {
    jointId: joint.id,
    position: Math.PI / 2,
  });
  assert.ok(moving);
  assert.deepEqual(moving.world.xyz, joint.origin.xyz);
  assert.ok(Math.abs(moving.local.rpy[1] + Math.PI / 2) < 1e-8);
  frames.pose(robot.joints);
  assert.ok(child.localToWorld(new Vector3(1, 0, 0)).distanceTo(new Vector3(1, 0, 0.2)) < 1e-8);
});

test("嵌套连杆坐标区分父级变换和世界变换", () => {
  const { robot } = parseUrdf(
    testRobot.replace(
      "</robot>",
      `
    <link name="tip"/>
    <joint name="tip-weld" type="fixed">
      <parent link="arm"/><child link="tip"/><origin xyz="1 0 0"/>
    </joint>
  </robot>`,
    ),
  );
  const tip = robot.links.find(({ name }) => name === "tip");
  const swivel = robot.joints.find(({ name }) => name === "swivel");
  assert.ok(tip && swivel);
  const preview = { jointId: swivel.id, position: Math.PI / 2 };
  const coordinates = sceneCoordinates(robot, "link", tip.id, preview);
  assert.ok(coordinates);
  assert.ok(new Vector3(...coordinates.local.xyz).distanceTo(new Vector3(1, 0, 0)) < 1e-8);
  assert.ok(new Vector3(...coordinates.world.xyz).distanceTo(new Vector3(0, 1, 0.2)) < 1e-8);
  assert.ok(Math.abs(coordinates.world.rpy[2] - Math.PI / 2) < 1e-8);
});

test("同一 STL 只读一次，限制并发且卸载后停止读取", async () => {
  const { robot } = parseUrdf(testRobot);
  const link = robot.links[0];
  const visual = link?.visuals[0];
  assert.ok(link && visual);
  link.visuals = [0, 0, 1, 2, 3, 4, 5].map((asset) => ({
    ...visual,
    geometry: { type: "mesh", asset: String(asset), scale: [1, 1, 1] },
  }));
  const stl = Buffer.alloc(134);
  stl.writeUInt32LE(1, 80);
  stl.writeFloatLE(1, 108);
  stl.writeFloatLE(1, 124);
  const ready = Promise.withResolvers<string>();
  const requests: string[] = [];
  const create = () =>
    createRobotModel(
      robot,
      (asset) => {
        requests.push(asset);
        return ready.promise;
      },
      () => {},
      () => assert.fail("无法读取测试 STL"),
    );

  const cancelled = create();
  assert.equal(requests.length, 4);
  cancelled.dispose();
  ready.resolve(stl.toString("base64"));
  await cancelled.ready;
  assert.equal(requests.length, 4);

  requests.length = 0;
  const model = create();
  try {
    await model.ready;
    assert.deepEqual(requests, ["0", "1", "2", "3", "4", "5"]);
    const meshes: Mesh[] = [];
    model.root.traverse((object) => {
      if (object instanceof Mesh && object.userData.linkId === link.id) meshes.push(object);
    });
    assert.equal(meshes.length, 7);
    assert.equal(meshes[0]?.geometry, meshes[1]?.geometry);
  } finally {
    model.dispose();
  }
});
