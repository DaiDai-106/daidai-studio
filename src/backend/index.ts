import { BACKEND_READY, BACKEND_SHUTDOWN } from "../contracts/desktop.ts";
import type { BackendRequest, ResourceRequest } from "../contracts/process.ts";
import { openApplication } from "./application.ts";

const parent = process.parentPort;
if (!parent)
  throw new Error("The application backend must be launched by Electron utilityProcess.");

const root = process.argv[2];
if (!root) throw new Error("The application data directory is required.");

const rootDev = process.argv[5];
const rootIno = process.argv[6];
if (Boolean(rootDev) !== Boolean(rootIno)) throw new Error("应用数据根身份不完整。");
let shutdown = false;
const runtime = openApplication({
  dataRoot: root,
  ...(rootDev && rootIno ? { expectedRoot: { dev: rootDev, ino: rootIno } } : {}),
  publish: (event) => {
    parent.postMessage({ type: "event", event });
  },
  ...(process.argv[3] ? { workerPath: process.argv[3] } : {}),
  ...(process.argv[4] ? { sceneSkillPath: process.argv[4] } : {}),
});

parent.on("message", ({ data }: Electron.MessageEvent) => {
  if (data === BACKEND_SHUTDOWN) {
    if (shutdown) return;
    shutdown = true;
    void runtime
      .then((app) => app.close())
      .then(
        () => process.exit(0),
        () => process.exit(1),
      );
  } else if (data?.type === "request" || data?.type === "resource") {
    const request = data as BackendRequest | ResourceRequest;
    void runtime
      .then(async (app): Promise<unknown> => {
        if (shutdown || request.version !== 1) throw new Error("应用正在退出或协议版本不兼容。");
        return request.type === "resource"
          ? app.resolveResource(request.importId, request.resourceId)
          : app.request(request.method, request.args);
      })
      .then(
        (result) => parent.postMessage({ type: "response", id: request.id, ok: true, result }),
        (error: unknown) =>
          parent.postMessage({
            type: "response",
            id: request.id,
            ok: false,
            error: error instanceof Error ? error.message : "后端操作失败。",
          }),
      );
  }
});

void runtime.then(
  () => {
    if (!shutdown) parent.postMessage(BACKEND_READY);
  },
  () => {
    console.error("Application data initialization failed; private details omitted.");
    process.exit(1);
  },
);
