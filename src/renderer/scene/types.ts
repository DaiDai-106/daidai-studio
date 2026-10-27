import type { Object3D } from "three";
import type { Placement } from "../../../resources/mcp/alignment/contract.ts";
import type { CadManifest } from "../../../resources/mcp/cad/contract.ts";

// Display projection only: no project, conversation, CAD handle or business state.
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
    view: import("../../shared/application.ts").CaptureView,
  ) => import("../../shared/application.ts").ViewportCapture | null;
}

export interface DisplayState {
  model?: Object3D | null;
  showGrid: boolean;
  showAxes: boolean;
  selectedId?: string | null;
  // Fraction hidden by the viewer (0 = opaque, 1 = transparent), inherited by descendants.
  transparency?: Readonly<Record<string, number>>;
  placement?: Placement | null;
}

export interface LoadedModel {
  readonly importId: string;
  readonly root: Object3D;
  readonly manifest: CadManifest;
  dispose(): void;
}
export interface ModelViewState {
  placement: Placement | null;
  status: "empty" | "loading" | "ready" | "error";
  loaded: LoadedModel | null;
  error: string;
}

// One loaded artifact's temporary viewing state; never written to CAD resources.
export interface ModelViewOverrides {
  importId: string;
  selectedId: string | null;
  transparency: Record<string, number>;
}
