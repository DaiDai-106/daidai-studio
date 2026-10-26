import type { DesktopBridge } from "../shared/desktop.ts";

declare global {
  interface Window {
    desktop: DesktopBridge;
  }

  // Electron exposes this web API; TypeScript's DOM library does not include it yet.
  interface WindowControlsOverlay extends EventTarget {
    readonly visible: boolean;
    getTitlebarAreaRect(): DOMRect;
  }

  interface Navigator {
    readonly windowControlsOverlay?: WindowControlsOverlay;
  }
}
