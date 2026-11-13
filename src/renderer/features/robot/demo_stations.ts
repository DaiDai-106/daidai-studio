// 演示工作站数据仅用于界面展示，不代表真实设备状态。
type DeviceKind = "arm" | "gripper" | "camera";
type DeviceStatus = "connected" | "disconnected";
type Device = {
  id: string;
  name: string;
  kind: DeviceKind;
  status: DeviceStatus;
  joints?: readonly { name: string; value: string }[];
  detail?: string;
};
export type Station = {
  id: string;
  name: string;
  devices: readonly Device[];
};

export const stations: readonly Station[] = [
  {
    id: "dual",
    name: "双臂工作站",
    devices: [
      {
        id: "left-arm",
        name: "左机械臂",
        kind: "arm",
        status: "connected",
        joints: [
          { name: "J1", value: "−12.4°" },
          { name: "J2", value: "35.1°" },
          { name: "J3", value: "68.0°" },
          { name: "J4", value: "−5.2°" },
          { name: "J5", value: "42.3°" },
          { name: "J6", value: "0.0°" },
        ],
      },
      {
        id: "right-arm",
        name: "右机械臂",
        kind: "arm",
        status: "connected",
        joints: [
          { name: "J1", value: "14.8°" },
          { name: "J2", value: "−28.2°" },
          { name: "J3", value: "57.1°" },
          { name: "J4", value: "6.4°" },
          { name: "J5", value: "−32.0°" },
          { name: "J6", value: "12.6°" },
          { name: "J7", value: "3.5°" },
        ],
      },
      {
        id: "left-gripper",
        name: "左夹爪",
        kind: "gripper",
        status: "connected",
        detail: "开合位置 · 42%",
      },
      {
        id: "right-gripper",
        name: "右夹爪",
        kind: "gripper",
        status: "disconnected",
        detail: "最后开合位置 · 18%",
      },
      {
        id: "head-camera",
        name: "顶部相机",
        kind: "camera",
        status: "connected",
        detail: "相机设备",
      },
      {
        id: "wrist-camera",
        name: "腕部相机",
        kind: "camera",
        status: "connected",
        detail: "相机设备",
      },
    ],
  },
  {
    id: "single",
    name: "单臂工作站",
    devices: [
      {
        id: "left-arm",
        name: "机械臂",
        kind: "arm",
        status: "connected",
        joints: [
          { name: "J1", value: "18.2°" },
          { name: "J2", value: "−34.5°" },
          { name: "J3", value: "59.0°" },
          { name: "J4", value: "22.8°" },
          { name: "J5", value: "−15.3°" },
          { name: "J6", value: "4.1°" },
        ],
      },
      {
        id: "left-gripper",
        name: "夹爪",
        kind: "gripper",
        status: "connected",
        detail: "开合位置 · 36%",
      },
      {
        id: "head-camera",
        name: "顶部相机",
        kind: "camera",
        status: "connected",
        detail: "相机设备",
      },
      {
        id: "wrist-camera",
        name: "腕部相机",
        kind: "camera",
        status: "connected",
        detail: "相机设备",
      },
    ],
  },
];
