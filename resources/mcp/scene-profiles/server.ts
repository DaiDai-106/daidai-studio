import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { sceneProfiles } from "./catalog.ts";
import {
  ReadSkillImageSchema,
  SceneSkillSchema,
  SelectProfileSchema,
  SelectStepSchema,
  sceneProfileTools,
} from "./contract.ts";
import { readSkillImage } from "./images.ts";
import { listSteps, resolveStepPath } from "./steps.ts";

const Config = Type.Object(
  {
    stagingRoot: Type.String(),
    skillsRoot: Type.String(),
    imagesRoot: Type.String(),
    projectRoot: Type.Optional(Type.String()),
    sceneSkills: Type.Optional(Type.Array(SceneSkillSchema)),
  },
  { additionalProperties: false },
);
const path = process.argv[2];
if (!path) throw new Error("Missing scene profile configuration.");
const config: unknown = JSON.parse(await readFile(path, "utf8"));
if (
  !Value.Check(Config, config) ||
  !isAbsolute(config.skillsRoot) ||
  !isAbsolute(config.imagesRoot) ||
  (config.projectRoot !== undefined && !isAbsolute(config.projectRoot))
)
  throw new Error("Invalid scene profile configuration.");
const profiles = await sceneProfiles(config.skillsRoot, config.sceneSkills ?? []);
const server = new Server(
  { name: "scene-profiles-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: sceneProfileTools }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "scene_list_steps") {
    if (!config.projectRoot)
      return { isError: true, content: [{ type: "text" as const, text: "没有当前项目。" }] };
    const data = await listSteps(config.projectRoot);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(data) }],
      structuredContent: data,
    };
  }
  if (request.params.name === "scene_list_profiles") {
    const data = {
      profiles: profiles.map(({ body, references: _references, ...profile }) => ({
        ...profile,
        skillAvailable: !!body,
      })),
    };
    return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
  }
  const args = request.params.arguments ?? {};
  if (request.params.name === "scene_select_step") {
    if (!Value.Check(SelectStepSchema, args))
      throw new McpError(ErrorCode.InvalidParams, "Invalid STEP selection.");
    if (!config.projectRoot)
      return {
        isError: true,
        content: [{ type: "text" as const, text: "没有当前项目。" }],
      };
    try {
      const selection = await resolveStepPath(config.projectRoot, args.relativePath);
      return {
        content: [{ type: "text" as const, text: "正在选择 STEP。" }],
        _meta: { "dai/scene-step": { relativePath: selection.relativePath } },
      };
    } catch {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: "项目中没有该 STEP，或路径不在当前项目内。请提供有效的 STEP 相对路径。",
          },
        ],
      };
    }
  }
  if (request.params.name === "scene_read_skill_image") {
    if (!Value.Check(ReadSkillImageSchema, args))
      throw new McpError(ErrorCode.InvalidParams, "Invalid skill image.");
    const reference = profiles
      .flatMap((profile) => profile.references)
      .find(
        (skill) =>
          skill.id === args.skillId && skill.images.some((image) => image.path === args.path),
      );
    if (!reference)
      return {
        isError: true,
        content: [{ type: "text" as const, text: "未找到该技能的参考图片。" }],
      };
    try {
      const image =
        args.skillId === "builtin:steel-structure"
          ? {
              mimeType: "image/png" as const,
              data: (
                await readFile(join(config.skillsRoot, "steel-structure", args.path))
              ).toString("base64"),
            }
          : await readSkillImage(config.imagesRoot, args.skillId, args.path);
      return {
        content: [
          {
            type: "text" as const,
            text: `技能参考图：${reference.images.find((item) => item.path === args.path)?.name}`,
          },
          { type: "image" as const, ...image },
        ],
      };
    } catch {
      return { isError: true, content: [{ type: "text" as const, text: "参考图片无法读取。" }] };
    }
  }
  if (request.params.name !== "scene_select_profile" || !Value.Check(SelectProfileSchema, args))
    throw new McpError(ErrorCode.InvalidParams, "Invalid scene profile selection.");
  const profile = profiles.find((item) => item.id === args.profileId);
  if (!profile)
    return { isError: true, content: [{ type: "text", text: "未知场景类型，请先查看场景列表。" }] };
  if (Buffer.byteLength(profile.body) > 60_000)
    return {
      isError: true,
      content: [{ type: "text", text: "该场景的技能说明超过 60 KB，请精简后重试。" }],
    };
  const data = {
    profileId: profile.id,
    name: profile.name,
    scope: args.scope,
    skillAvailable: !!profile.body,
    ...(profile.body ? { skill: profile.body } : {}),
  };
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
    structuredContent: data,
    _meta: { "dai/scene-profile": { profileId: profile.id, scope: args.scope } },
  };
});
await server.connect(new StdioServerTransport());
process.stdin.once("end", () => void server.close());
