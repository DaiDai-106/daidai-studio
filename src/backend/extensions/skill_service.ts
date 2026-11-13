import { randomUUID } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { loadSkillsFromDir, type Skill } from "@earendil-works/pi-coding-agent";

function checkName(name: string): void {
  if (name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw new Error("Skill 名称只能包含小写字母、数字和连字符。");
  }
}

async function rejectLinks(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error("导入的 Skill 不能包含符号链接。");
  if (info.isDirectory()) {
    for (const entry of await readdir(path)) await rejectLinks(join(path, entry));
  } else if (!info.isFile()) {
    throw new Error("Skill 目录只能包含普通文件和目录。");
  }
}

function inspectSkill(dir: string, name?: string): Skill {
  const found = loadSkillsFromDir({ dir, source: "dai-user" });
  const skill = found.skills.find((item) => item.baseDir === dir);
  if (!skill || (name && skill.name !== name)) {
    throw new Error("无效的 SKILL.md：需要名称和描述，且名称必须与目录一致。");
  }

  checkName(skill.name);
  if (found.diagnostics.length) {
    throw new Error(found.diagnostics.map((item) => item.message).join("\n"));
  }
  return skill;
}

/** 用户 Skill 保存在 Dai 数据根；包内 Skill 由包管理器只读发现。
 *  导入技能目录
 *
 *
 */
export function createSkillService({ dataRoot }: { dataRoot: string }) {
  if (!isAbsolute(dataRoot)) throw new Error("数据目录必须是绝对路径。");
  const skillsRoot = join(dataRoot, "data", "skills");

  async function ownedSkillDirectory(name: string): Promise<string> {
    checkName(name);
    const dir = join(skillsRoot, name);
    const info = await lstat(dir);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("无效的 Skill 目录。");
    const file = await lstat(join(dir, "SKILL.md"));
    if (file.isSymbolicLink() || !file.isFile()) throw new Error("无效的 SKILL.md。");
    return dir;
  }

  async function validateSkillText(name: string, text: string): Promise<void> {
    checkName(name);
    await mkdir(skillsRoot, { recursive: true, mode: 0o700 });
    const temp = await mkdtemp(join(skillsRoot, ".validate-"));
    try {
      const dir = join(temp, name);
      await mkdir(dir);
      await writeFile(join(dir, "SKILL.md"), text, { mode: 0o600 });
      inspectSkill(dir, name);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }

  return {
    async list() {
      return loadSkillsFromDir({ dir: skillsRoot, source: "dai-user" });
    },

    async read(name: string): Promise<string> {
      return readFile(join(await ownedSkillDirectory(name), "SKILL.md"), "utf8");
    },

    async create(name: string, text: string): Promise<Skill> {
      await validateSkillText(name, text);
      const dir = join(skillsRoot, name);
      try {
        await mkdir(dir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Skill 已存在。");
        throw error;
      }
      try {
        await writeFile(join(dir, "SKILL.md"), text, { mode: 0o600, flag: "wx" });
        return inspectSkill(dir, name);
      } catch (error) {
        await rm(dir, { recursive: true, force: true });
        throw error;
      }
    },

    async save(name: string, text: string): Promise<Skill> {
      const dir = await ownedSkillDirectory(name);
      await validateSkillText(name, text);
      const temporary = join(dir, `.SKILL-${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, text, { mode: 0o600, flag: "wx" });
        await rename(temporary, join(dir, "SKILL.md"));
      } finally {
        await rm(temporary, { force: true });
      }
      return inspectSkill(dir, name);
    },

    async importDirectory(source: string): Promise<Skill> {
      if (!isAbsolute(source)) throw new Error("Skill 来源必须是绝对路径。");
      const sourceInfo = await lstat(source);
      if (sourceInfo.isSymbolicLink()) throw new Error("导入的 Skill 不能包含符号链接。");
      if (!sourceInfo.isDirectory()) throw new Error("Skill 来源必须是目录。");

      await mkdir(skillsRoot, { recursive: true, mode: 0o700 });
      const distance = relative(await realpath(source), await realpath(skillsRoot));
      if (
        distance === "" ||
        (!isAbsolute(distance) && distance !== ".." && !distance.startsWith(`..${sep}`))
      ) {
        throw new Error("Skill 来源不能包含 Dai 的 Skill 存储目录。");
      }
      await rejectLinks(source);
      const skill = inspectSkill(source);
      const text = await readFile(join(source, "SKILL.md"), "utf8");
      await validateSkillText(skill.name, text);
      const dir = join(skillsRoot, skill.name);

      try {
        await mkdir(dir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Skill 已存在。");
        throw error;
      }
      try {
        // 最后写 SKILL.md，避免半完成的目录被资源发现器当作有效 Skill。
        for (const entry of await readdir(source)) {
          if (entry !== "SKILL.md") {
            await cp(join(source, entry), join(dir, entry), {
              recursive: true,
              errorOnExist: true,
              force: false,
            });
          }
        }
        await writeFile(join(dir, "SKILL.md"), text, { mode: 0o600, flag: "wx" });
        return inspectSkill(dir, skill.name);
      } catch (error) {
        await rm(dir, { recursive: true, force: true });
        throw error;
      }
    },
  };
}
