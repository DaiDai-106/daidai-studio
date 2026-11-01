export interface ManagedRuntime {
  dispose(): Promise<void>;
}

export interface ToolDescription {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolCallOptions {
  signal?: AbortSignal;
}

export interface RuntimeTool extends ToolDescription {
  execute(input: unknown, options: ToolCallOptions): Promise<unknown>;
}

/** 工具实现留在 Runtime 内，模型只看到名称、说明和参数格式。 */
export function createToolRegistry() {
  const tools = new Map<string, RuntimeTool>();
  return {
    register(tool: RuntimeTool): void {
      if (!/^[a-z][a-z0-9_]*$/.test(tool.name)) throw new Error(`Invalid tool name: ${tool.name}`);
      if (tools.has(tool.name)) throw new Error(`Duplicate tool: ${tool.name}`);
      tools.set(tool.name, tool);
    },

    list(): ToolDescription[] {
      return [...tools.values()].map(({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema,
      }));
    },

    async call(name: string, input: unknown, options: ToolCallOptions = {}): Promise<unknown> {
      options.signal?.throwIfAborted();
      const tool = tools.get(name);
      if (!tool) throw new Error(`Unknown tool: ${name}`);
      return tool.execute(input, options);
    },
  };
}

interface Entry<T> {
  runtime: Promise<T>;
  closing?: Promise<void>;
}

/** 同一项目共享 Runtime；工作目录可以相同，不能作为项目身份。 */
export function createRuntimeManager<T extends ManagedRuntime>(
  factory: (projectId: string) => T | Promise<T>,
) {
  const entries = new Map<string, Entry<T>>();
  let closing: Promise<void> | undefined;

  async function get(projectId: string): Promise<T> {
    if (closing) throw new Error("Runtime manager is closed");
    if (!projectId.trim()) throw new Error("Project ID is required");

    let entry = entries.get(projectId);
    if (entry?.closing) {
      await entry.closing;
      return get(projectId);
    }

    if (!entry) {
      entry = { runtime: Promise.resolve().then(() => factory(projectId)) };
      entries.set(projectId, entry);
    }

    try {
      return await entry.runtime;
    } catch (error) {
      if (entries.get(projectId) === entry && !entry.closing) entries.delete(projectId);
      throw error;
    }
  }

  async function release(projectId: string): Promise<void> {
    const entry = entries.get(projectId);
    if (!entry) return;
    entry.closing ??= (async () => {
      try {
        await (await entry.runtime).dispose();
      } finally {
        if (entries.get(projectId) === entry) entries.delete(projectId);
      }
    })();
    await entry.closing;
  }

  function dispose(): Promise<void> {
    closing ??= (async () => {
      const results = await Promise.allSettled([...entries.keys()].map(release));
      const failures = results.filter(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (failures.length)
        throw new AggregateError(
          failures.map((failure) => failure.reason),
          "Runtime cleanup failed",
        );
    })();
    return closing;
  }

  return { get, release, dispose };
}
