import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cadPlugin } from "../../resources/mcp/cad/builtin.ts";
import type { BuiltinCatalog } from "../shared/capabilities.ts";
import { loadBuiltinMcp } from "./mcp/builtin.ts";

export interface BuiltinPaths {
  nativeDirectory?: string;
  cadExecutable?: string;
  cadServer?: string;
  skillsRoot?: string;
}

export async function loadBuiltins(paths: BuiltinPaths, temporaryRoot: string) {
  const skills = new Map<string, string>();
  if (paths.skillsRoot) {
    try {
      const content = await readFile(join(paths.skillsRoot, "scene-building", "SKILL.md"), "utf8");
      if (content.length > 64_000) throw new Error("内置场景技能超过大小限制。");
      skills.set("scene-building", content);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const executable =
    paths.cadExecutable ??
    (paths.nativeDirectory
      ? join(paths.nativeDirectory, `dai-cad-worker${process.platform === "win32" ? ".exe" : ""}`)
      : undefined);
  let available = false;
  if (executable) {
    try {
      await access(executable, constants.X_OK);
      available = (await stat(executable)).isFile();
    } catch {
      /* Ordinary chat remains available without native geometry. */
    }
  }
  const serverPath =
    paths.cadServer ?? fileURLToPath(new URL("../../resources/mcp/cad/server.ts", import.meta.url));
  const cad = await loadBuiltinMcp(
    {
      ...cadPlugin,
      available,
      serverPath,
      configuration: executable ? { executable } : {},
    },
    temporaryRoot,
  );
  return {
    cad,
    close: () => cad.close(),
    skills,
    catalog: {
      servers: [cad.descriptor],
      skills: [
        {
          id: "builtin-scene",
          name: "scene-building",
          description: "导入选中的 STEP，查询结构并生成真实显示资源。",
          modes: ["scene"],
          body: skills.get("scene-building") ?? null,
        },
      ],
    } satisfies BuiltinCatalog,
  };
}
export type Builtins = Awaited<ReturnType<typeof loadBuiltins>>;
