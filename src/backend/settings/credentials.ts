import {
  type Credential,
  type CredentialStore,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai";

export type StoredProvider = import("../../shared/application.ts").ProviderConfig & {
  secretRef: string;
};
export interface VaultPort {
  read(): Promise<string>;
  write(value: string): Promise<void>;
  available: boolean;
}

export async function createCredentials(
  vault: VaultPort,
  providers: () => readonly StoredProvider[],
  extraReferences: () => readonly string[] = () => [],
) {
  const memory = new InMemoryCredentialStore();
  let persisted: Record<string, Credential> = JSON.parse(await vault.read());
  if (!persisted || typeof persisted !== "object" || Array.isArray(persisted))
    throw new Error("凭据存储格式无效。");
  for (const [key, credential] of Object.entries(persisted)) {
    if (!credential || !["api_key", "oauth"].includes(credential.type))
      throw new Error("凭据存储格式无效。");
    await memory.modify(key, async () => credential);
  }
  let writes = Promise.resolve();
  function persist(key: string, credential?: Credential) {
    const write = writes.then(async () => {
      const next = { ...persisted };
      if (credential) next[key] = credential;
      else delete next[key];
      await vault.write(JSON.stringify(next));
      persisted = next;
    });
    writes = write.catch(() => {});
    return write;
  }
  const reference = (id: string) => providers().find((provider) => provider.id === id)?.secretRef;
  const store: CredentialStore = {
    read: async (id, options) => {
      const key = reference(id);
      return key ? memory.read(key, options) : undefined;
    },
    list: async (options) => {
      const result = [];
      for (const provider of providers()) {
        const credential = provider.secretRef
          ? await memory.read(provider.secretRef, options)
          : undefined;
        if (credential) result.push({ providerId: provider.id, type: credential.type });
      }
      return result;
    },
    modify: async (id, change, options) => {
      const key = reference(id);
      if (!key) throw new Error("该服务尚未配置认证。");
      return memory.modify(
        key,
        async (current) => {
          const next = await change(current);
          if (next && Object.hasOwn(persisted, key)) await persist(key, next);
          return next;
        },
        options,
      );
    },
    delete: async (id, options) => {
      const key = reference(id);
      if (key) {
        if (Object.hasOwn(persisted, key)) await persist(key);
        await memory.delete(key, options);
      }
    },
  };
  return {
    store,
    async stage(credential: Credential, save: boolean) {
      if (save && !vault.available) throw new Error("系统安全存储不可用，请选择仅本次使用凭据。");
      const key = crypto.randomUUID();
      if (save) await persist(key, credential);
      await memory.modify(key, async () => credential);
      return key;
    },
    readReference: (key: string) => memory.read(key),
    async remove(key: string) {
      if (!key) return;
      if (Object.hasOwn(persisted, key)) await persist(key);
      await memory.delete(key);
    },
    async prune() {
      // A crash between staging a credential and committing settings can leave an
      // unreferenced secret. Reconcile against the committed document on startup.
      const referenced = new Set([
        ...providers().map((provider) => provider.secretRef),
        ...extraReferences(),
      ]);
      for (const key of Object.keys(persisted))
        if (!referenced.has(key)) {
          await persist(key);
          await memory.delete(key);
        }
    },
    temporary: (key: string) => !!key && !Object.hasOwn(persisted, key),
    has: async (id: string) => !!(await store.read(id)),
  };
}
export type Credentials = Awaited<ReturnType<typeof createCredentials>>;
