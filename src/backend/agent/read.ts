import { isAbsolute, resolve } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createReadTool } from "@earendil-works/pi-durable/tools";
import { localFile } from "../artifacts/files.ts";
import type { Artifacts } from "../artifacts/store.ts";
import type { Placements } from "../projects/placements.ts";
import { getSceneContext, sceneFailure } from "./scene.ts";
import type { RunContext } from "./types.ts";

// Pi owns reading/streaming/truncation. The environment adds only desktop path authorization.
class SceneReadEnv extends NodeExecutionEnv {
  private readonly project: string;
  private readonly sceneRoot: string;
  private readonly allowed: Set<string>;
  constructor(project: string, sceneRoot: string, allowed: Set<string>) {
    super({ cwd: project });
    this.project = project;
    this.sceneRoot = sceneRoot;
    this.allowed = allowed;
  }
  override async openBinaryReader(
    path: string,
    _options: { noFollow?: boolean } | undefined,
    context: Context,
  ) {
    const absolute = resolve(this.project, path);
    if (!this.allowed.has(absolute))
      throw new Error("read 只能读取当前模型已登记的对象目录、参照、清单、特征和定位文件。");
    await localFile(this.sceneRoot, absolute);
    return super.openBinaryReader(absolute, { noFollow: true }, context);
  }
}
export function createSceneReadTool(
  target: () => RunContext,
  artifacts: Artifacts,
  placements: Placements,
) {
  const read = createReadTool();
  return {
    ...read,
    description: `${read.description} For saved scene details, use the exact paths from scene-context.files. Object catalogue pages fit one complete read; references map object IDs to sourceKey and feature line ranges. The manifest is rendering data. Saved files remain usable after CAD document release.`,
    parameters: {
      ...read.parameters,
      properties: {
        ...read.parameters.properties,
        path: {
          ...read.parameters.properties.path,
          description:
            "Exact absolute local path supplied by the latest scene-context.files; copy it unchanged.",
        },
        offset: {
          ...read.parameters.properties.offset,
          description:
            "Omit for complete catalogue pages. For CAD features use the object's exact features.startLine, then Pi's continuation offset if truncated.",
        },
        limit: {
          ...read.parameters.properties.limit,
          description:
            "Omit for complete catalogue pages. For CAD features use the object's exact features.count; do not guess short slices of the manifest.",
        },
      },
    },
    async execute(
      args: Parameters<typeof read.execute>[0],
      api: Parameters<typeof read.execute>[1],
      context: Context,
    ) {
      const run = target();
      if (String(api.conversationId) !== run.conversationId)
        throw new Error("read 没有有效的本轮目标。");
      const scene = await getSceneContext(run, artifacts, placements);
      const files = scene.files;
      const paths = new Set(
        (files
          ? [
              files.manifest,
              files.features,
              files.placement,
              ...files.objects.map((page) => page.path),
              ...files.references.map((page) => page.path),
            ]
          : []
        )
          .filter((path): path is string => typeof path === "string")
          .map((path) => resolve(path)),
      );
      if (!isAbsolute(args.path) || !paths.has(resolve(args.path))) {
        const error = sceneFailure(
          !isAbsolute(args.path)
            ? "ABSOLUTE_PATH_REQUIRED"
            : scene.currentDisplay
              ? "READ_PATH_NOT_AUTHORIZED"
              : "NO_CURRENT_DISPLAY",
          !isAbsolute(args.path)
            ? "read 需要本机绝对路径，请原样使用 scene.files 中的完整路径；不要使用相对路径、file URI 或自行拼接目录。"
            : scene.currentDisplay
              ? "路径不属于当前显示模型。请使用 scene.files 中的确切路径；不要猜测路径、读取历史版本或重新导入 STEP 来修复权限。"
              : "当前来源尚无已发布模型，请先核对选中的 STEP；这不是文件读取权限批准请求。",
          scene,
        );
        return { isError: true, output: [{ type: "text" as const, text: JSON.stringify(error) }] };
      }
      return read.execute(
        args,
        {
          ...api,
          env: new SceneReadEnv(run.project.path, await artifacts.directory(run.project.id), paths),
        },
        context,
      );
    },
  };
}
