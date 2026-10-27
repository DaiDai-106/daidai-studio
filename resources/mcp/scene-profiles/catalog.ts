import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Static } from "typebox";
import type { SceneSkillSchema } from "./contract.ts";

export type SceneSkill = Static<typeof SceneSkillSchema>;
const profiles = [
  { id: "steel-structure", name: "型钢场景", description: "型钢、吊环与地脚。" },
  { id: "bevel-cutting", name: "坡口切割场景", description: "坡口与切割相关场景。" },
  { id: "welding", name: "焊接场景", description: "焊接相关场景。" },
  { id: "robot-body", name: "机器人本体场景", description: "机器人本体相关场景。" },
];

export async function sceneProfiles(skillsRoot: string, skills: readonly SceneSkill[]) {
  let steel = "";
  try {
    steel = await readFile(join(skillsRoot, "steel-structure", "SKILL.md"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const customProfiles = [...new Set(skills.map((skill) => skill.sceneProfile))]
    .filter((id) => !profiles.some((profile) => profile.id === id))
    .map((id) => ({
      id,
      name: id,
      description:
        skills.find((skill) => skill.sceneProfile === id)?.description ?? "用户配置的业务场景。",
    }));
  return [...profiles, ...customProfiles].map((profile) => {
    const custom = skills.filter((skill) => skill.sceneProfile === profile.id);
    const references = custom.length
      ? custom.map((skill) => ({ id: skill.id, images: skill.images ?? [] }))
      : profile.id === "steel-structure" && steel
        ? [
            {
              id: "builtin:steel-structure",
              images: [{ name: "正确布局参考图", path: "images/upright-reference.png" }],
            },
          ]
        : [];
    const body = custom.length
      ? custom.map((skill) => `# ${skill.name}\n${skill.description}\n\n${skill.body}`).join("\n\n")
      : profile.id === "steel-structure"
        ? steel
        : "";
    const imageList = references
      .flatMap((skill) =>
        skill.images.map((image) => `- skillId: ${skill.id}; path: ${image.path}; ${image.name}`),
      )
      .join("\n");
    return {
      ...profile,
      body: imageList
        ? `${body}\n\n参考图片（按需调用 scene_read_skill_image）：\n${imageList}`
        : body,
      references,
    };
  });
}
