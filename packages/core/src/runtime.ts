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
