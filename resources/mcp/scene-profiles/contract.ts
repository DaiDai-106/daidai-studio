import { Type } from "typebox";
import { SkillImageSchema } from "../../../src/shared/capabilities.ts";

export const SceneSkillSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 200 }),
    name: Type.String({ minLength: 1, maxLength: 100 }),
    description: Type.String({ minLength: 1, maxLength: 1000 }),
    body: Type.String({ minLength: 1, maxLength: 32000 }),
    sceneProfile: Type.String({ minLength: 1, maxLength: 100 }),
    images: Type.Optional(Type.Array(SkillImageSchema, { maxItems: 30 })),
  },
  { additionalProperties: false },
);
export const ReadSkillImageSchema = Type.Object(
  {
    skillId: Type.String({ minLength: 1, maxLength: 200 }),
    path: Type.String({ minLength: 1, maxLength: 200 }),
  },
  { additionalProperties: false },
);
export const SelectProfileSchema = Type.Object(
  {
    profileId: Type.String({ minLength: 1, maxLength: 100 }),
    scope: Type.Union([Type.Literal("project"), Type.Literal("source")]),
  },
  { additionalProperties: false },
);
export const SelectStepSchema = Type.Object(
  { relativePath: Type.String({ minLength: 1, maxLength: 4096 }) },
  { additionalProperties: false },
);
export const sceneProfileTools = [
  {
    name: "scene_list_steps",
    description:
      "List STEP files in the current project. If the complete list has exactly one file, it can be selected for the user's scene task; otherwise ask which file to use unless the user identified one.",
    inputSchema: { type: "object" as const, properties: {}, additionalProperties: false },
  },
  {
    name: "scene_select_step",
    description:
      "Select a project STEP for the current scene when no STEP is selected. Use an exact project-relative path from scene_list_steps or one explicitly provided by the user; the path is validated before selection. This only selects the source and does not import it.",
    inputSchema: { ...SelectStepSchema, type: "object" as const },
  },
  {
    name: "scene_list_profiles",
    description:
      "List available business scenes and whether they have a matching skill. Does not inspect or modify the scene.",
    inputSchema: { type: "object" as const, properties: {}, additionalProperties: false },
  },
  {
    name: "scene_read_skill_image",
    description:
      "Read one reference image attached to a scene skill. Use the skillId and image path supplied with the skill; call only when the image helps the task.",
    inputSchema: { ...ReadSkillImageSchema, type: "object" as const },
  },
  {
    name: "scene_select_profile",
    description:
      "Select a business scene explicitly specified by the user and load its available skill. Use project scope by default; use source only when the user says this STEP has a different scene. Never choose from a guess.",
    inputSchema: { ...SelectProfileSchema, type: "object" as const },
  },
];
