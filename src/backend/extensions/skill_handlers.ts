import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadSkills, type Skill } from "@earendil-works/pi-coding-agent";
import type { ManagedSkill } from "../../contracts/application.ts";
import type { openProjectStore } from "../projects/store.ts";
import type { Handlers } from "../types.ts";
import { createPackageService } from "./package_service.ts";
import { createSkillService } from "./skill_service.ts";

type IndexedSkill = { info: ManagedSkill; skill: Skill };

function indexed(skill: Skill, source: ManagedSkill["source"]): IndexedSkill {
  const id = createHash("sha256").update(`${source}\0${skill.filePath}`).digest("hex");
  return {
    info: {
      id,
      name: skill.name,
      description: skill.description,
      source,
      editable: source === "user",
    },
    skill,
  };
}

export function createSkillHandlers(options: {
  dataRoot: string;
  store: ReturnType<typeof openProjectStore>;
  sceneSkillPath?: string;
  changed?: () => Promise<void> | void;
}): Handlers<
  | "skill.library.list"
  | "skill.library.read"
  | "skill.library.create"
  | "skill.library.save"
  | "skill.library.import"
> {
  const managed = createSkillService({ dataRoot: options.dataRoot });

  async function list(projectId?: string): Promise<IndexedSkill[]> {
    const project = projectId ? options.store.getProject(projectId) : undefined;
    if (projectId && !project) throw new Error("项目不存在。");
    const result = (await managed.list()).skills.map((skill) => indexed(skill, "user"));
    const packages = createPackageService({
      dataRoot: options.dataRoot,
      ...(project ? { projectId: project.id, cwd: project.path } : {}),
    });
    try {
      const resources = await packages.resolve();
      const fromPaths = (paths: string[]) =>
        loadSkills({
          cwd: project?.path ?? options.dataRoot,
          agentDir: join(options.dataRoot, "pi"),
          skillPaths: paths,
          includeDefaults: false,
        }).skills;
      result.push(
        ...fromPaths(resources.skills.filter((item) => item.enabled).map((item) => item.path)).map(
          (skill) => indexed(skill, "package"),
        ),
      );
      if (options.sceneSkillPath && (!project || project.mode === "scene"))
        result.push(
          ...fromPaths([options.sceneSkillPath]).map((skill) => indexed(skill, "builtin")),
        );
    } finally {
      await packages.dispose();
    }
    return result;
  }

  return {
    async "skill.library.list"({ projectId }) {
      return (await list(projectId)).map((item) => item.info);
    },

    async "skill.library.read"({ id, projectId }) {
      const item = (await list(projectId)).find((entry) => entry.info.id === id);
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
