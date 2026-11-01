import type { Object3D } from "three";
import type { Placement } from "../../../../contracts/placement.ts";

// 仅包含显示状态，不持有项目、会话、CAD 句柄或业务状态。
export type CameraView =
  | "isometric"
  | "front"
  | "right"
  | "top"
  | "+X"
  | "-X"
  | "+Y"
  | "-Y"
  | "+Z"
  | "-Z";
export interface ViewportHandle {
  fit: () => void;
  setView: (view: CameraView) => void;
  capture: (
    view: import("../../../../contracts/application.ts").CaptureView,
  ) => import("../../../../contracts/application.ts").ViewportCapture | null;
}

export interface DisplayState {
  model?: Object3D | null;
  showGrid: boolean;
  showAxes: boolean;
  selectedId?: string | null;
  // 界面透明比例（0 为不透明、1 为完全透明），对子节点生效。
  transparency?: Readonly<Record<string, number>>;
  placement?: Placement | null;
}
