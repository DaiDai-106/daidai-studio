import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type Credential,
  type CredentialStore,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai";

export type StoredProvider = import("../../contracts/application.ts").ProviderConfig & {
  secretRef: string;
};

export async function createCredentials(
  dataRoot: string,
  providers: () => readonly StoredProvider[],
) {
  const memory = new InMemoryCredentialStore();
  const path = join(dataRoot, "auth.json");
  let persisted: Record<string, Credential>;
  try {
    persisted = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    persisted = {};
  }
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
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, {
          mode: 0o600,
          flag: "wx",
        });
        await rename(temporary, path);
      } finally {
        await rm(temporary, { force: true });
      }
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
    async readApplicationSecret(key: string): Promise<string | undefined> {
      const credential = await memory.read(key);
      return credential?.type === "api_key" ? credential.key : undefined;
    },

    async writeApplicationSecret(key: string, value: string): Promise<void> {
      const credential: Credential = { type: "api_key", key: value };
      await persist(key, credential);
      await memory.modify(key, async () => credential);
    },

    async stage(credential: Credential) {
      const key = crypto.randomUUID();
      await persist(key, credential);
      await memory.modify(key, async () => credential);
      return key;
    },

    async remove(key: string) {
      if (!key) return;
      if (Object.hasOwn(persisted, key)) await persist(key);
      await memory.delete(key);
    },

    has: async (id: string) => !!(await store.read(id)),
  };
}

export type Credentials = Awaited<ReturnType<typeof createCredentials>>;
