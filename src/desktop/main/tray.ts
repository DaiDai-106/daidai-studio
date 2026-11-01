import { fileURLToPath } from "node:url";
import { app, Menu, nativeImage, Tray } from "electron";

// 托盘负责重新显示窗口和真正退出应用。
export function createAppTray(showWindow: () => void): Tray {
  const filename =
    process.platform === "darwin"
      ? "trayTemplate.png"
      : process.platform === "win32"
        ? "app.ico"
        : "256.png";
  const icon = nativeImage.createFromPath(
    fileURLToPath(new URL(`../icons/${filename}`, import.meta.url)),
  );
  if (icon.isEmpty()) throw new Error("Tray icon could not be loaded.");
  if (process.platform === "darwin") icon.setTemplateImage(true);
  const tray = new Tray(icon);
  tray.setToolTip("Dai");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "打开 Dai", click: showWindow },
      { type: "separator" },
      { label: "退出 Dai", click: () => app.quit() },
    ]),
  );
  tray.on("click", showWindow);
  return tray;
}
