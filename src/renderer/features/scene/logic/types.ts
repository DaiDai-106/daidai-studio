import type { Object3D } from "three";

// 仅包含显示状态，不持有项目、会话、CAD 句柄或业务状态。
export interface ViewportHandle {
  fit: () => void;
}

export interface DisplayState {
  model?: Object3D | null;
  showGrid: boolean;
  showAxes: boolean;
  selectedId?: string | null;
  // 界面透明比例（0 为不透明、1 为完全透明），对子节点生效。
  transparency?: Readonly<Record<string, number>>;
}
