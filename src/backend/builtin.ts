import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { alignmentPlugin } from "../../resources/mcp/alignment/builtin.ts";
import { cadPlugin } from "../../resources/mcp/cad/builtin.ts";
import { sceneProfilesPlugin } from "../../resources/mcp/scene-profiles/builtin.ts";
import { viewportPlugin } from "../../resources/mcp/viewport/builtin.ts";
import type { BuiltinCatalog } from "../shared/capabilities.ts";
import { loadBuiltinMcp } from "./mcp/builtin.ts";

export interface BuiltinPaths {
  nativeDirectory?: string;
  cadExecutable?: string;
  alignmentExecutable?: string;
  alignmentServer?: string;
  cadServer?: string;
  viewportServer?: string;
  sceneProfilesServer?: string;
  skillsRoot?: string;
}

export async function loadBuiltins(
  paths: BuiltinPaths,
  temporaryRoot: string,
  imagesRoot = join(temporaryRoot, "skill-images"),
) {
  const skills = new Map<string, string>();
  const skillsRoot =
    paths.skillsRoot ?? fileURLToPath(new URL("../../resources/skills", import.meta.url));
  for (const name of ["scene-building", "scene-alignment"]) {
    try {
      const content = await readFile(join(skillsRoot, name, "SKILL.md"), "utf8");
      if (content.length > 64_000) throw new Error("内置场景技能超过大小限制。");
      skills.set(name, content);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const executable =
    paths.cadExecutable ??
    (paths.nativeDirectory
      ? join(paths.nativeDirectory, `dai-cad-worker${process.platform === "win32" ? ".exe" : ""}`)
      : undefined);
  async function installed(path?: string) {
    if (!path) return false;
    try {
      await access(path, constants.X_OK);
      return (await stat(path)).isFile();
    } catch {
      return false;
    }
  }
  const serverPath =
    paths.cadServer ?? fileURLToPath(new URL("../../resources/mcp/cad/server.ts", import.meta.url));
  const cad = await loadBuiltinMcp(
    {
      ...cadPlugin,
      available: await installed(executable),
      serverPath,
      configuration: executable ? { executable } : {},
    },
    temporaryRoot,
  );
  const alignmentExecutable =
    paths.alignmentExecutable ??
    (paths.nativeDirectory
      ? join(
          paths.nativeDirectory,
          `dai-alignment-worker${process.platform === "win32" ? ".exe" : ""}`,
        )
      : undefined);
  const alignment = await loadBuiltinMcp(
    {
      ...alignmentPlugin,
      sceneStorage: true,
      available: await installed(alignmentExecutable),
      serverPath:
        paths.alignmentServer ??
        fileURLToPath(new URL("../../resources/mcp/alignment/server.ts", import.meta.url)),
      configuration: alignmentExecutable ? { executable: alignmentExecutable } : {},
    },
    temporaryRoot,
  );
  const viewport = await loadBuiltinMcp(
    {
      ...viewportPlugin,
      available: true,
      serverPath:
        paths.viewportServer ??
        fileURLToPath(new URL("../../resources/mcp/viewport/server.ts", import.meta.url)),
      configuration: {},
    },
    temporaryRoot,
  );
  const sceneProfiles = await loadBuiltinMcp(
    {
      ...sceneProfilesPlugin,
      available: true,
      sceneSkills: true,
      serverPath:
        paths.sceneProfilesServer ??
        fileURLToPath(new URL("../../resources/mcp/scene-profiles/server.ts", import.meta.url)),
      configuration: { skillsRoot, imagesRoot },
    },
    temporaryRoot,
  );
  const services = [cad, alignment, viewport, sceneProfiles];
  async function release() {
    const results = await Promise.allSettled(services.map((service) => service.release()));
    const failure = results.find((result) => result.status === "rejected");
    if (failure) throw failure.reason;
  }
  return {
    cad,
    alignment,
    skillsRoot,
    services,
    release,
    close: release,
    skills,
    catalog: {
      servers: services.map((service) => service.descriptor),
      skills: [
        {
          id: "builtin-scene",
          name: "scene-building",
          description: "查询已保存场景，按请求导入 STEP 或继续整机定位。",
          modes: ["scene"],
          automatic: true,
          body: skills.get("scene-building") ?? null,
        },
        {
          id: "builtin-alignment-skill",
          name: "scene-alignment",
          description: "整机旋转、参考系对齐与包围盒归零，保存位置和朝向。",
          modes: ["scene"],
          automatic: true,
          body: skills.get("scene-alignment") ?? null,
        },
      ],
    } satisfies BuiltinCatalog,
  };
}
export type Builtins = Awaited<ReturnType<typeof loadBuiltins>>;
