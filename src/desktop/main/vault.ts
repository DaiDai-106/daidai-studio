import { readFile, rename, writeFile } from "node:fs/promises";
import { safeStorage } from "electron";

export function createVault(path: string) {
  const available = () =>
    safeStorage.isEncryptionAvailable() &&
    (process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text");
  return {
    available,
    async read(): Promise<string> {
      if (!available()) return "{}";
      try {
        return safeStorage.decryptString(await readFile(path));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return "{}";
        throw new Error("无法解锁已保存的凭据，请检查系统安全存储。");
      }
    },
    async write(value: string): Promise<void> {
      if (!available()) throw new Error("系统安全存储不可用，请选择仅本次使用凭据。");
      const temporary = `${path}.tmp`;
      await writeFile(temporary, safeStorage.encryptString(value), { mode: 0o600 });
      await rename(temporary, path);
    },
  };
}
