import { protocol } from "electron";
import type { ResourceLocation } from "../../contracts/process.ts";
import type { createSceneResourceReader } from "./resourceReader.ts";

// 前端只能读取后端确认过的场景资源，不能通过协议任意访问本地文件。
export function installResourceProtocol(
  resolve: (importId: string, resourceId: string) => Promise<ResourceLocation>,
  origin: string,
  reader: ReturnType<typeof createSceneResourceReader>,
) {
  protocol.handle("dai-resource", async (request) => {
    try {
      const url = new URL(request.url);
      const requestOrigin = request.headers.get("Origin");
      if (
        !["GET", "HEAD"].includes(request.method) ||
        url.username ||
        url.password ||
        url.port ||
        url.search ||
        url.hash ||
        (requestOrigin && requestOrigin !== "null" && requestOrigin !== origin) ||
        !/^[0-9a-f]{64}$/.test(url.hostname) ||
        !/^\/[0-9a-f]{64}$/.test(url.pathname)
      )
        return new Response(null, { status: 403 });
      const resource = await resolve(url.hostname, url.pathname.slice(1));
      const data = await reader.read(resource, url.pathname.slice(1), request.signal);
      return new Response(request.method === "HEAD" ? null : new Uint8Array(data), {
        headers: {
          "Content-Type": resource.mediaType,
          "Content-Length": String(resource.byteLength),
          "Access-Control-Allow-Origin": requestOrigin ?? origin,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch {
      return new Response("Display resource unavailable", { status: 404 });
    }
  });
  return () => reader.close();
}
