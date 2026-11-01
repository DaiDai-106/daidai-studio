import type { McpExtensionOptions } from "@earendil-works/pi-coding-agent";
import type { McpOAuthState } from "@earendil-works/pi-mcp/oauth";

type Storage = { read(): Promise<string | undefined>; write(value: string): Promise<void> };

/** MCP 的 OAuth 状态由宿主保存到 Dai 数据目录。 */
export async function createPackageMcpCredentials(storage?: Storage) {
  const saved = await storage?.read();
  const parsed: unknown = saved ? JSON.parse(saved) : [];
  if (
    !Array.isArray(parsed) ||
    parsed.some(
      (entry) =>
        !Array.isArray(entry) ||
        typeof entry[0] !== "string" ||
        !entry[1] ||
        typeof entry[1] !== "object",
    )
  )
    throw new Error("第三方包认证状态格式无效。");
  const states = new Map<string, McpOAuthState>(parsed);
  const queues = new Map<string, Promise<void>>();
  const key = (name: string, url: string) => JSON.stringify([name, url]);
  let writes = Promise.resolve();
  let failure: unknown;

  function persist() {
    const snapshot = JSON.stringify([...states]);
    const next = writes.then(() => storage?.write(snapshot));
    writes = next.then(
      () => {
        failure = undefined;
      },
      (error: unknown) => {
        failure = error;
      },
    );
    return next;
  }

  const store = {
    forServer(name: string, url: string) {
      const id = key(name, url);
      return {
        load: () => states.get(id),
        async save(state: McpOAuthState) {
          states.set(id, structuredClone(state));
          await persist();
        },

        async withRefreshLock<T>(run: () => Promise<T>): Promise<T> {
          const previous = queues.get(id) ?? Promise.resolve();
          let unlock!: () => void;
          const current = new Promise<void>((done) => {
            unlock = done;
          });
          queues.set(id, current);
          await previous;
          try {
            return await run();
          } finally {
            unlock();
            if (queues.get(id) === current) queues.delete(id);
          }
        },
      };
    },
    tokens: (name: string, url: string) => states.get(key(name, url))?.tokens,
    remove(name: string, url: string) {
      const removed = states.delete(key(name, url));
      if (removed) void persist().catch(() => {});
      return removed;
    },
  };

  return {
    // Pi 的选项使用带私有字段的具体类；此对象实现其公开方法。
    credentials: store as unknown as NonNullable<McpExtensionOptions["credentials"]>,
    async flush() {
      await writes;
      if (failure) throw failure;
    },
  };
}
