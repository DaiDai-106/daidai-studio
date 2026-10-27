import { createHash } from "node:crypto";
import type { SkillConfig } from "../../shared/capabilities.ts";

export function selectSkills(
  skills: readonly SkillConfig[],
  mode: "general" | "scene",
  projectId: string,
) {
  const selected = skills.filter(
    (skill) =>
      skill.enabled &&
      !skill.sceneProfile &&
      skill.modes.includes(mode) &&
      (skill.scope.kind === "global" || skill.scope.projectId === projectId),
  );
  const body = selected
    .map((skill) => `# ${skill.name}\n${skill.description}\n\n${skill.body}`)
    .join("\n\n");
  if (Buffer.byteLength(body) > 64_000)
    throw new Error("当前模式启用的技能说明超过 64 KB，请停用部分技能后重试。");
  return {
    body: body || null,
    metadata: selected.map(({ id, body, name, description }) => ({
      id,
      hash: createHash("sha256").update(JSON.stringify({ name, description, body })).digest("hex"),
    })),
  };
}
