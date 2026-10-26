import { pathToFileURL } from "node:url";
import { net, protocol } from "electron";
import type { ResourceLocation } from "../../shared/process.ts";

export function installResourceProtocol(
  resolve: (importId: string, resourceId: string) => Promise<ResourceLocation>,
  origin: string,
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
      const file =
        request.method === "HEAD"
          ? null
          : await net.fetch(pathToFileURL(resource.path).href, { signal: request.signal });
      if (file && !file.ok) throw new Error("Resource unavailable");
      return new Response(file?.body ?? null, {
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
}
