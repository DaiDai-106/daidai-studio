import type { WebContents } from "electron";

export function installZoomShortcuts(contents: WebContents): void {
  contents.on("before-input-event", (event, input) => {
    if (
      input.type !== "keyDown" ||
      input.isComposing ||
      input.alt ||
      !(process.platform === "darwin" ? input.meta : input.control)
    )
      return;

    const direction = input.key === "+" || input.key === "=" ? 1 : input.key === "-" ? -1 : 0;
    if (!direction && input.key !== "0") return;
    event.preventDefault();
    const percentage = direction
      ? Math.round(contents.getZoomFactor() * 100) + direction * 10
      : 100;
    contents.setZoomFactor(Math.max(80, Math.min(150, percentage)) / 100);
  });
}
