import { defineExtension, section } from "@earendil-works/pi-durable";
import { Value } from "typebox/value";
import { sceneProfiles } from "../../../resources/mcp/scene-profiles/catalog.ts";
import {
  SelectProfileSchema,
  SelectStepSchema,
} from "../../../resources/mcp/scene-profiles/contract.ts";
import {
  CaptureInputSchema,
  captureRequestMethod,
} from "../../../resources/mcp/viewport/contract.ts";
import type { ApplicationEvent } from "../../shared/application.ts";
import type { Artifacts } from "../artifacts/store.ts";
import type { Builtins } from "../builtin.ts";
import { authorizeStepPath } from "../projects/files.ts";
import type { Placements } from "../projects/placements.ts";
import { fileHash } from "../projects/source.ts";
import { registerMcpTool } from "./mcpTool.ts";
import { createSceneReadTool } from "./read.ts";
import { getSceneContext, sceneFailure } from "./scene.ts";
import { createShell } from "./shell.ts";
import type { RunContext } from "./types.ts";
import { createPlacementUndo } from "./undoPlacement.ts";
import { createViewportCapture } from "./viewport.ts";

export function createBuiltinAgent(
  builtins: Builtins,
  target: () => RunContext,
  artifacts: Artifacts,
  placements: Placements,
  projects: Pick<
    import("../projects/handlers.ts").Projects,
    "setSceneProfile" | "sceneProfile" | "prepareStepSelection"
  >,
  sceneSkill: {
    prepare(run: RunContext, name: string, body: string): string;
    apply(run: RunContext, body: string): void;
  },
  publish: (event: ApplicationEvent) => void,
) {
  async function prepareSceneProfile(run: RunContext, sourceId: string) {
    // sourceId comes from the path lookup before it is selected. This is
    // important for an existing STEP that has a source-scoped override.
    const selection = await projects.sceneProfile(run.project.id, sourceId);
    if (!selection)
      return {
        id: null,
        scope: null,
        skillAvailable: false,
        body: null,
      };
    const skill = (await sceneProfiles(builtins.skillsRoot, run.sceneSkills ?? [])).find(
      (item) => item.id === selection.id,
    );
    return {
      id: selection.id,
      scope: selection.scope,
      skillAvailable: !!skill?.body,
      body: sceneSkill.prepare(run, skill?.name ?? selection.id, skill?.body ?? ""),
    };
  }
  const viewport = createViewportCapture(target, artifacts, placements, publish);
  const tools = builtins.services.flatMap((service) =>
    service.tools.map((tool) =>
      registerMcpTool({
        name: tool.name,
        serverName: service.descriptor.name,
        tool,
        ...(service.descriptor.id === "builtin.viewport" || tool.name === "scene_read_skill_image"
          ? { maxOutputBytes: 7_000_000 }
          : {}),
        async prepareDisplay(artifact, signal) {
          const run = target();
          const connection = await service.open(
            { ...run.project, sceneRoot: await artifacts.directory(run.project.id) },
            signal,
          );
          return artifacts.prepare(artifact, connection, run, signal);
        },
        preparePlacement: (value) => placements.prepare(value, target()),
        target(id) {
          if (target().conversationId !== id) throw new Error("此工具没有有效的本轮目标。");
        },
        async invoke(args, context) {
          try {
            const run = target();
            if (service.descriptor.id === "builtin.alignment") {
              const scene = await getSceneContext(run, artifacts, placements);
              if (!scene.currentDisplay || scene.currentDisplay.importId !== args.importId) {
                const result = sceneFailure(
                  scene.currentDisplay ? "SCENE_TARGET_CHANGED" : "NO_CURRENT_DISPLAY",
                  scene.currentDisplay
                    ? "请求使用了历史 importId；当前模型已经发布。请使用 scene.currentDisplay 的 importId 和 revision，不要重新导入，也不要自动重试旧参数。"
                    : "当前所选来源没有已发布模型，请核对 STEP 关联后再决定是否导入。",
                  scene,
                );
                return {
                  isError: true,
                  content: [{ type: "text", text: JSON.stringify(result) }],
                  structuredContent: result,
                };
              }
            }
            if (tool.name === "cad_import_step" && !run.source)
              throw new Error(
                run.sourceId
                  ? "当前选中的 STEP 无法读取，请检查文件是否存在。"
                  : "当前对话尚未选择 STEP。请先调用 scene_list_steps 并选择文件；多个文件时询问用户。",
              );
            if (tool.name === "cad_import_step")
              await authorizeStepPath(run.project.path, run.source, args.path, context.signal);
            const connection = await service.open(
              {
                ...run.project,
                sceneRoot: await artifacts.directory(run.project.id),
                sceneSkills: run.sceneSkills ?? [],
              },
              context.signal,
            );
            const removeHandler =
              service.descriptor.id === "builtin.viewport"
                ? connection.client.setRequestHandler(
                    captureRequestMethod,
                    async (params, request) => {
                      if (!Value.Check(CaptureInputSchema, params))
                        throw new Error("无效的视口请求。");
                      return { capture: await viewport.capture(params, request.signal) };
                    },
                  )
                : undefined;
            try {
              const result = await connection.client.callTool(tool.name, args, {
                signal: context.signal,
                timeoutMs: 300_000,
                onProgress: (value) => {
                  if (value.message) void context.progress(value.message).catch(() => {});
                },
              });
              if (
                service.descriptor.id === "builtin.scene-profiles" &&
                !result.isError &&
                result._meta?.["dai/scene-step"] !== undefined
              ) {
                context.signal.throwIfAborted();
                const selection = result._meta["dai/scene-step"];
                if (!Value.Check(SelectStepSchema, selection))
                  throw new Error("无效的 STEP 选择。");
                if (run.sourceId)
                  throw new Error(
                    "当前对话已有选中的 STEP；请先使用当前文件，或让用户在界面切换。",
                  );
                const pending = await projects.prepareStepSelection(
                  run.conversationId,
                  selection.relativePath,
                );
                const file = pending.file;
                const source = pending.source;
                if (!file || !source) throw new Error("STEP 选择失败。");
                const hash = await fileHash(file.path, 512 * 1024 * 1024, context.signal);
                const profile = await prepareSceneProfile(run, source.id);
                context.signal.throwIfAborted();

                // This is the durable side-effect boundary. An abort before or
                // during the transaction leaves the selection unchanged; an
                // abort racing after it commits must keep the run/UI in sync.
                await pending.commit(context.signal);
                run.sourceId = source.id;
                run.selectedSourcePath = file.path;
                run.source = { ...source, path: file.path, sha256: hash.sha256 };
                run.sceneProfileId = profile.id;
                run.sceneProfileScope = profile.scope;
                run.sceneProfileSkillAvailable = profile.skillAvailable;
                publish({ type: "workspace" });
                // If cancellation won the race after the durable commit, the
                // session may already have ended. The persisted selection and
                // workspace event above remain authoritative in that case.
                if (profile.body) {
                  try {
                    sceneSkill.apply(run, profile.body);
                  } catch (error) {
                    if (!context.signal.aborted) throw error;
                  }
                }
                const data = {
                  relativePath: file.relativePath,
                  selectedSourcePath: file.path,
                  sourceId: source.id,
                };
                return {
                  content: [{ type: "text" as const, text: JSON.stringify(data) }],
                  structuredContent: data,
                };
              }
              if (
                service.descriptor.id === "builtin.scene-profiles" &&
                !result.isError &&
                result._meta?.["dai/scene-profile"] !== undefined
              ) {
                context.signal.throwIfAborted();
                const selection = result._meta["dai/scene-profile"];
                if (!Value.Check(SelectProfileSchema, selection))
                  throw new Error("无效的场景类型选择。");
                const data = result.structuredContent as
                  | { name?: string; skill?: string; skillAvailable?: boolean }
                  | undefined;
                if (
                  !data ||
                  typeof data.name !== "string" ||
                  (data.skill !== undefined && typeof data.skill !== "string")
                )
                  throw new Error("无效的场景技能内容。");
                const prepared = sceneSkill.prepare(run, data.name, data.skill ?? "");
                context.signal.throwIfAborted();
                const effective = await projects.setSceneProfile(
                  run.project.id,
                  run.sourceId,
                  selection.profileId,
                  selection.scope,
                );
                if (effective?.id !== selection.profileId) {
                  return {
                    isError: true,
                    content: [
                      {
                        type: "text" as const,
                        text: `项目场景已更新，但当前 STEP 仍使用独立场景 ${effective?.id ?? "未知"}；请根据用户意图选择是否切换该 STEP。`,
                      },
                    ],
                  };
                }
                run.sceneProfileId = effective.id;
                run.sceneProfileScope = effective.scope;
                run.sceneProfileSkillAvailable = data.skillAvailable === true;
                sceneSkill.apply(run, prepared);
              }
              return result;
            } finally {
              removeHandler?.();
            }
          } catch (error) {
            context.signal.throwIfAborted();
            return {
              content: [
                { type: "text", text: error instanceof Error ? error.message : "CAD 调用失败。" },
              ],
              isError: true,
            };
          }
        },
      }),
    ),
  );
  const read = createSceneReadTool(target, artifacts, placements);
  const undo = createPlacementUndo(target, artifacts, placements);
  const shell = createShell(target, publish);
  return {
    shell,
    viewport,
    extension: defineExtension({
      name: "step-import",
      tools: [...tools, undo, read, shell.tool],
      sections: [
        section("scene-building", () => target().skill ?? undefined),
        section("scene-context", async () => {
          return JSON.stringify(await getSceneContext(target(), artifacts, placements));
        }),
      ],
    }),
    tools(enabled: (id: string) => boolean, supportsImages: boolean) {
      const names = new Set(
        builtins.services
          .filter(
            (service) =>
              service.available &&
              enabled(service.descriptor.id) &&
              (service.descriptor.id !== "builtin.viewport" || supportsImages),
          )
          .flatMap((service) =>
            service.tools
              .filter((tool) => supportsImages || tool.name !== "scene_read_skill_image")
              .map((tool) => tool.name),
          ),
      );
      return [
        ...tools.filter((tool) => names.has(tool.name)),
        ...(names.has("alignment_rotate") ? [undo] : []),
        read,
        shell.tool,
      ];
    },
  };
}
