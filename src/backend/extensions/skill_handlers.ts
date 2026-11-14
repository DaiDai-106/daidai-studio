import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { loadSkills, type Skill } from "@earendil-works/pi-coding-agent";
import type { ManagedSkill } from "../../contracts/application.ts";
import type { PluginModule, PluginScope } from "../../contracts/catalog.ts";
import type { Handlers } from "../types.ts";
import { createPackageService } from "./package_service.ts";
import { createSkillService } from "./skill_service.ts";

type IndexedSkill = { info: ManagedSkill; skill: Skill };

function indexed(
  skill: Skill,
  source: ManagedSkill["source"],
  owner?: { source: string; scope: PluginScope },
): IndexedSkill {
  const id = createHash("sha256").update(`${source}\0${skill.filePath}`).digest("hex");
  return {
    info: {
      id,
      name: skill.name,
      description: skill.description,
      source,
      editable: source === "user",
      ...(owner ? { ownerSource: owner.source, ownerScope: owner.scope } : {}),
    },
    skill,
  };
}

export function createSkillHandlers(options: {
  dataRoot: string;
  changed?: () => Promise<void> | void;
}): Handlers<
  | "skill.library.list"
  | "skill.library.read"
  | "skill.library.create"
  | "skill.library.save"
  | "skill.library.import"
> {
  const managed = createSkillService({ dataRoot: options.dataRoot });

  // 个人技能的列表与读取不能因 Pi 包配置损坏而失效。
  const userSkills = async () =>
    (await managed.list()).skills.map((skill) => indexed(skill, "user"));

  async function packageSkills(moduleId: PluginModule = "coding"): Promise<IndexedSkill[]> {
    const packages = createPackageService({
      dataRoot: options.dataRoot,
      moduleId,
    });
    const resources = await packages.resolve();
    const { skills } = loadSkills({
      cwd: options.dataRoot,
      agentDir: join(options.dataRoot, "agent"),
      skillPaths: resources.skills.filter((item) => item.enabled).map((item) => item.path),
      includeDefaults: false,
    });
    return skills.map((skill) => {
      const resource = resources.skills.find(
        (r) => skill.filePath === r.path || skill.filePath.startsWith(`${r.path}${sep}`),
      );
      return indexed(
        skill,
        "package",
        resource
          ? {
              source: resource.metadata.source,
              scope: resource.metadata.scope === "user" ? "global" : "module",
            }
          : undefined,
      );
    });
  }

  return {
    async "skill.library.list"({ moduleId, userOnly }) {
      const own = await userSkills();
      return (userOnly ? own : [...own, ...(await packageSkills(moduleId))]).map(
        (item) => item.info,
      );
    },

    async "skill.library.read"({ id, moduleId }) {
      const matches = (entry: IndexedSkill) => entry.info.id === id;
      const item =
        (await userSkills()).find(matches) ?? (await packageSkills(moduleId)).find(matches);
      if (!item) throw new Error("技能不存在或未启用。");
      return readFile(item.skill.filePath, "utf8");
    },

    async "skill.library.create"({ name, text }) {
      await options.changed?.();
      const skill = await managed.create(name, text);
      return indexed(skill, "user").info;
    },

    async "skill.library.save"({ name, text }) {
      await options.changed?.();
      const skill = await managed.save(name, text);
      return indexed(skill, "user").info;
    },

    async "skill.library.import"({ path }) {
      await options.changed?.();
      const skill = await managed.importDirectory(path);
      return indexed(skill, "user").info;
    },
  };
}
