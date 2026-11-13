import { mkdir } from "node:fs/promises";
import { join } from "node:path";

// 显示名称不作为项目身份；目录名称仅用于创建用户可见的工作目录。
export function projectDirectoryName(name: string): string {
  const safe = Array.from(name.trim(), (char) =>
    (char.codePointAt(0) ?? 0) < 32 || '<>:"/\\|?*'.includes(char) ? "-" : char,
  )
    // 文件系统通常限制单段 UTF-8 名称的字节数，50 个码点最多占 200 字节。
    .slice(0, 50)
    .join("")
    .replace(/[. ]+$/u, "")
    .trim();
  const value = safe || "项目";
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(value) ? `_${value}` : value;
}

// 只新建目录，不复用或覆盖同名目录；mkdir 的原子 EEXIST 检查避免并发冲突。
export async function createProjectDirectory(root: string, name: string): Promise<string> {
  await mkdir(root, { recursive: true });
  const base = projectDirectoryName(name);
  for (let suffix = 1; suffix <= 10000; suffix++) {
    const directory = join(root, suffix === 1 ? base : `${base}-${suffix}`);
    try {
      await mkdir(directory);
      return directory;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error("无法创建项目文件夹：同名目录过多。请选择其他名称。");
}
