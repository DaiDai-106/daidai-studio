import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { extname } from "node:path";
import {
  directoryHandlesAvailable,
  openDirectoryRoot,
  readFileResource,
} from "../../../shared/node/file_access.ts";

const MAX_RESOURCE = 8 * 1024 * 1024;
const mediaTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};

function pathParts(path: string) {
  const parts = path.split("/");
  if (
    !path ||
    parts.some(
      (part) => !part || part.startsWith(".") || part.includes("\0") || part.includes("\\"),
    )
  )
    throw new Error("预览文件路径无效。");
  return parts;
}

/** 临时服务只暴露明确授权的项目目录，不跟随符号链接。 */
export async function createStaticPreview(rootPath: string, entry: string) {
  if (!directoryHandlesAvailable) throw new Error("当前系统暂不支持本地 HTML 预览。");
  const parts = pathParts(entry);
  if (![".html", ".htm"].includes(extname(entry).toLowerCase()))
    throw new Error("请选择项目中的 HTML 文件。");
  const root = await openDirectoryRoot(rootPath);
  try {
    await readFileResource(root.handle, parts, MAX_RESOURCE);
  } catch (error) {
    await root.handle.close();
    throw error;
  }
  const token = randomBytes(24).toString("hex");
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405).end();
        return;
      }
      let resource: string[];
      try {
        const url = new URL(request.url ?? "", "http://127.0.0.1");
        const segments = url.pathname
          .split("/")
          .slice(1)
          .map((part) => decodeURIComponent(part));
        if (segments.shift() !== token || segments.some((part) => part.includes("/")))
          throw new Error("无权访问。");
        resource = pathParts(segments.join("/"));
        const data = await readFileResource(root.handle, resource, MAX_RESOURCE);
        response.setHeader(
          "Content-Type",
          mediaTypes[extname(resource.at(-1) ?? "").toLowerCase()] ?? "application/octet-stream",
        );
        response.setHeader("X-Content-Type-Options", "nosniff");
        response.setHeader("Cache-Control", "no-store");
        response.setHeader(
          "Content-Security-Policy",
          "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'self'",
        );
        response.writeHead(200);
        response.end(request.method === "HEAD" ? undefined : data);
      } catch {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("资源不可用。");
      }
    })();
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("无法启动静态预览服务。");
    const url = `http://127.0.0.1:${address.port}/${token}/${parts.map(encodeURIComponent).join("/")}`;
    return {
      url,
      close() {
        server.close();
        server.closeAllConnections();
        void root.handle.close();
      },
    };
  } catch (error) {
    server.close();
    await root.handle.close();
    throw error;
  }
}
