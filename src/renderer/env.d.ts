import type { DesktopBridge } from "../contracts/desktop.ts";

declare global {
  interface Window {
    desktop: DesktopBridge;
  }

  // Electron 提供此 Web API，但 TypeScript 的 DOM 类型尚未包含它。
  interface WindowControlsOverlay extends EventTarget {
    readonly visible: boolean;
    getTitlebarAreaRect(): DOMRect;
  }

  interface Navigator {
    readonly windowControlsOverlay?: WindowControlsOverlay;
  }
}
