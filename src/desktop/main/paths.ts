import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { App } from "electron";

export function configureDataPaths(app: App) {
  // An explicit profile remains isolated for development and integration tests.
  const isolated = app.commandLine.getSwitchValue("user-data-dir");
  const root = isolated ? join(isolated, "data") : join(app.getPath("home"), ".daidai");
  const profile = isolated || join(root, "desktop");
  for (const path of [root, profile, join(root, "logs"), join(root, "cache"), join(root, "tmp")])
    mkdirSync(path, { recursive: true, mode: 0o700 });
  app.setPath("userData", profile);
  app.setAppLogsPath(join(root, "logs"));
  return {
    root,
    profile,
    database: join(root, "app.sqlite"),
    credentials: join(root, "credentials.enc"),
  };
}
