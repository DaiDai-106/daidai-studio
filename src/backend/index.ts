import { fileURLToPath } from "node:url";
import { BACKEND_READY, BACKEND_SHUTDOWN } from "../shared/desktop.ts";
import type { BackendRequest, ResourceRequest, VaultResponse } from "../shared/process.ts";
import { openRuntime } from "./runtime.ts";

const parent = process.parentPort;
if (!parent)
  throw new Error("The application backend must be launched by Electron utilityProcess.");

const root = process.argv[2];
if (!root) throw new Error("The application data directory is required.");

const secureStorage = process.argv[3] === "secure";
const vaultRequests = new Map<
  string,
  { resolve: (value: string) => void; reject: (reason: Error) => void }
>();

function vault(action: "read" | "write", value?: string) {
  return new Promise<string>((resolve, reject) => {
    const id = crypto.randomUUID();
    vaultRequests.set(id, { resolve, reject });
    parent.postMessage({ type: "vault", id, action, ...(value === undefined ? {} : { value }) });
  });
}

let shutdown = false;
const runtime = openRuntime(
  root,
  {
    available: secureStorage,
    read: () => vault("read"),
    write: async (value) => {
      await vault("write", value);
    },
  },
  (event) => {
    parent.postMessage({ type: "event", event });
  },
  {
    cadServer: fileURLToPath(new URL("./cad-mcp.js", import.meta.url)),
    alignmentServer: fileURLToPath(new URL("./alignment-mcp.js", import.meta.url)),
    viewportServer: fileURLToPath(new URL("./viewport-mcp.js", import.meta.url)),
    sceneProfilesServer: fileURLToPath(new URL("./scene-profiles-mcp.js", import.meta.url)),
    ...(process.argv[4] ? { nativeDirectory: process.argv[4] } : {}),
    ...(process.argv[5] ? { skillsRoot: process.argv[5] } : {}),
  },
);

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
  } else if (data?.type === "vault-result") {
    const response = data as VaultResponse;
    const request = vaultRequests.get(response.id);
    if (!request) return;
    vaultRequests.delete(response.id);
    if (response.ok) request.resolve(response.value);
    else request.reject(new Error(response.error));
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
