import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { createMcpFixture } from "./mcp-service.ts";

async function handleHttp(
  transport: WebStandardStreamableHTTPServerTransport,
  request: IncomingMessage,
  response: ServerResponse,
) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers))
    if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(",") : value);
  let body = "";
  request.setEncoding("utf8");
  for await (const chunk of request) body += chunk;
  const result = await transport.handleRequest(
    new Request(`http://${request.headers.host}${request.url}`, {
      method: request.method ?? "GET",
      headers,
      ...(body ? { body } : {}),
    }),
  );
  response.statusCode = result.status;
  result.headers.forEach((value, name) => {
    response.setHeader(name, value);
  });
  const reader = result.body?.getReader();
  if (reader) {
    response.once("close", () => {
      void reader.cancel().catch(() => {});
    });
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      response.write(chunk.value);
    }
  }
  response.end();
}

// Only Node HTTP adaptation lives here; the official SDK owns MCP and session behavior.
export async function serveMcpHttp(tools?: Tool[]) {
  type Session = {
    service: ReturnType<typeof createMcpFixture>;
    transport: WebStandardStreamableHTTPServerTransport;
  };
  const sessions = new Map<string, Session>(),
    owned = new Set<Session>();
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  let deleted = 0;
  const http = createServer((request, response) => {
    void (async () => {
      const id = request.headers["mcp-session-id"];
      let session = typeof id === "string" ? sessions.get(id) : undefined;
      if (!session && !id && request.method === "POST") {
        const service = createMcpFixture((name, args) => {
          calls.push({ name, args });
        }, tools);
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          enableJsonResponse: true,
          onsessioninitialized: (id) => {
            if (session) sessions.set(id, session);
          },
          onsessionclosed: (id) => {
            deleted++;
            sessions.delete(id);
          },
        });
        session = { service, transport };
        owned.add(session);
        await service.server.connect(transport);
      }
      if (!session) {
        response.writeHead(404).end();
        return;
      }
      await handleHttp(session.transport, request, response);
    })().catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (!address || typeof address === "string")
    throw new Error("MCP test HTTP server did not start.");
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    calls,
    get deleted() {
      return deleted;
    },
    async close() {
      await Promise.all([...owned].map((session) => session.service.close()));
      http.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        http.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
