import {
  McpClient,
  type McpClientOptions,
  type McpTransport,
  StdioTransport,
  type StdioTransportOptions,
  StreamableHttpTransport,
  type StreamableHttpTransportOptions,
} from "@earendil-works/pi-mcp";
// Built-in plugins use the same standard endpoints as configured external services.
export type McpEndpoint =
  | { kind: "stdio"; options: StdioTransportOptions }
  | { kind: "http"; options: StreamableHttpTransportOptions };

export interface McpConnectionOptions {
  client?: McpClientOptions;
  /** Cancels connection establishment only; tool calls take their own signal. */
  signal?: AbortSignal;
}

export interface McpConnection {
  client: McpClient;
  close(): Promise<void>;
}

// Pi owns transport shutdown. This facade only makes all callers await the same
// shutdown, including when client.close() has already begun outside this module.
function ownTransport(transport: McpTransport): McpTransport {
  let closing: Promise<void> | undefined;
  return {
    start: () => transport.start(),
    send: (message, options) => transport.send(message, options),
    onMessage: (listener) => transport.onMessage(listener),
    onError: (listener) => transport.onError(listener),
    onClose: (listener) => transport.onClose(listener),
    setProtocolVersion: (version) => transport.setProtocolVersion?.(version),
    close() {
      closing ??= Promise.resolve().then(() => transport.close());
      return closing;
    },
  };
}

// Discovery and calls stay on the Pi client; no second tool registry or RPC API.
export async function openMcpConnection(
  endpoint: McpEndpoint,
  options: McpConnectionOptions = {},
): Promise<McpConnection> {
  options.signal?.throwIfAborted();
  const client = new McpClient(options.client ?? { name: "dai", version: "0.1.0" });
  let transport: McpTransport | undefined;
  let closing: Promise<void> | undefined;
  function close() {
    closing ??= Promise.resolve().then(async () => {
      try {
        await client.close();
      } finally {
        await transport?.close();
      }
    });
    return closing;
  }
  function disconnected() {
    void close().catch(() => console.error("MCP connection cleanup failed."));
  }
  client.onClose(disconnected);
  options.signal?.addEventListener("abort", disconnected, { once: true });
  try {
    switch (endpoint.kind) {
      case "stdio":
        transport = ownTransport(new StdioTransport(endpoint.options));
        break;
      case "http":
        transport = ownTransport(new StreamableHttpTransport(endpoint.options));
        break;
    }
    options.signal?.throwIfAborted();
    await client.connect(transport);
    options.signal?.throwIfAborted();
    return { client, close };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "MCP connection and cleanup failed.");
    }
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", disconnected);
  }
}
