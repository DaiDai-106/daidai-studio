import { isUtf8 } from "node:buffer";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  maxSceneAssetBytes,
  maxSceneWarnings,
  maxStepBytes,
  SceneOriginSchema,
  type SceneRobot,
} from "../../contracts/scene.ts";
import { object } from "../../contracts/schema.ts";
import { isStepFile } from "../../shared/scene/step_attachment.ts";
import { readProjectFile } from "../projects/project_access.ts";
import { zeroOrigin } from "./document.ts";
import { createMeshBatch } from "./stl.ts";

const run = promisify(execFile);
const partId = Type.String({ pattern: "^part-[0-9]{1,3}$" });
const channel = Type.Number({ minimum: 0, maximum: 1 });
const partName = Type.String({ minLength: 1, maxLength: 1000 });
const assemblySchema = object({
  version: Type.Literal(1),
  meshUnit: Type.Literal("mm"),
  omissions: Type.Optional(
    Type.Array(object({ part: partName, faces: Type.Integer({ minimum: 1 }) }), { maxItems: 511 }),
  ),
  occurrences: Type.Array(
    object({
      id: partId,
      parentId: Type.Union([partId, Type.Null()]),
      name: partName,
      origin: SceneOriginSchema,
      mesh: Type.Optional(Type.String({ pattern: "^mesh-[0-9]{1,3}\\.stl$" })),
      color: Type.Optional(Type.Tuple([channel, channel, channel, channel])),
    }),
    { minItems: 1, maxItems: 511 },
  ),
});

async function convert(
  source: string,
  directory: string,
  signal: AbortSignal,
  workerDirectory: string,
  gbk: boolean,
) {
  const executable = join(
    workerDirectory,
    process.platform === "win32" ? "cad-import.exe" : "cad-import",
  );
  try {
    await run(executable, [source, directory, ...(gbk ? ["--gbk"] : [])], {
      cwd: dirname(source),
      signal,
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    });
  } catch (cause) {
    signal.throwIfAborted();
    const error = cause as NodeJS.ErrnoException & { stderr?: string; killed?: boolean };
    const detail = error.stderr?.match(/^CAD_IMPORT_ERROR:(.{1,500})/m)?.[1];
    if (error.code === "ENOENT" || error.code === "EACCES")
      throw new Error("STEP 解析程序不可用。请检查应用安装是否完整。");
    if (detail) throw new Error(detail);
    throw new Error(error.killed ? "STEP 解析超时或日志超出限制。" : "STEP 解析进程异常退出。");
  }
}

function hasGbkFileName(input: Buffer) {
  // Some legacy CAD exporters write the header name and product names as raw GBK.
  const header = input.subarray(0, 16_384).toString("latin1").split("ENDSEC;", 1)[0] ?? "";
  const name = /^\s*FILE_NAME\s*\(\s*'((?:''|[^'])*)'/im.exec(header)?.[1];
  if (!name) return false;
  const bytes = Buffer.from(name, "latin1");
  if (isUtf8(bytes)) return false;
  try {
    return /\p{Script=Han}{3}/u.test(new TextDecoder("gbk", { fatal: true }).decode(bytes));
  } catch {
    return false;
  }
}

function sceneName(value: string, fallback: string, maxLength = 90) {
  return (
    Array.from(value.replace(/\p{Cc}/gu, " ").trim())
      .slice(0, maxLength)
      .join("") || fallback
  );
}

export async function readStepSource(path: string, signal: AbortSignal) {
  signal.throwIfAborted();
  if (!isAbsolute(path) || !isStepFile(path)) throw new Error("请选择 .step 或 .stp 文件。");
  const data = await readProjectFile(
    await realpath(dirname(path)),
    [basename(path)],
    maxStepBytes,
    signal,
  );
  if (!data.length) throw new Error("STEP 文件为空。");
  return data;
}

export async function loadStepAssembly(
  path: string,
  signal: AbortSignal,
  workerDirectory = fileURLToPath(new URL("../../../modules/scene/runtime", import.meta.url)),
) {
  signal.throwIfAborted();
  const staging = await mkdtemp(join(await realpath(tmpdir()), "dai-step-"));
  try {
    const source = join(staging, "source.step");
    const output = join(staging, "assembly");
    const input = await readStepSource(path, signal);
    await writeFile(source, input, { signal, mode: 0o600, flag: "wx" });
    await convert(source, output, signal, workerDirectory, hasGbkFileName(input));
    const raw = await readProjectFile(staging, ["assembly", "assembly.json"], 1_048_576, signal);
    const assembly: unknown = JSON.parse(raw.toString("utf8"));
    if (!Value.Check(assemblySchema, assembly)) throw new Error("STEP 解析结果格式无效。");
    const rootLinkId = "cad-root";
    const robot: SceneRobot = {
      name: sceneName(basename(path, extname(path)), "STEP 装配"),
      rootLinkId,
      links: [{ id: rootLinkId, name: "base_link", visuals: [] }],
      joints: [],
    };
    const names = new Set(["base_link"]);
    const batch = createMeshBatch();
    const meshes = new Map<string, string>();
    for (const part of assembly.occurrences) {
      signal.throwIfAborted();
      const label = sceneName(part.name, part.id);
      let name = label;
      for (let index = 2; names.has(name); index++) name = `${label}_${index}`;
      names.add(name);
      const visuals: SceneRobot["links"][number]["visuals"] = [];
      if (part.mesh) {
        let asset = meshes.get(part.mesh);
        if (!asset) {
          asset = batch.add(
            await readProjectFile(staging, ["assembly", part.mesh], maxSceneAssetBytes, signal),
          );
          meshes.set(part.mesh, asset);
        }
        visuals.push({
          origin: zeroOrigin(),
          geometry: { type: "mesh", asset, scale: [0.001, 0.001, 0.001] },
          ...(part.color ? { color: part.color } : {}),
        });
      }
      robot.links.push({ id: part.id, name, visuals });
      robot.joints.push({
        id: `joint-${part.id}`,
        name: `joint_${name}`,
        type: "fixed",
        parentId: part.parentId ?? rootLinkId,
        childId: part.id,
        origin: part.origin,
        axis: [1, 0, 0],
        position: 0,
      });
    }
    if (!batch.assets.size) throw new Error("STEP 装配没有可显示的网格。");
    const omissions = Map.groupBy(assembly.omissions ?? [], ({ part }) =>
      sceneName(part, "未命名零件", 75),
    );
    const warnings = [...omissions].slice(0, maxSceneWarnings - 2).map(([part, entries]) => {
      const faces = entries.reduce((total, entry) => total + entry.faces, 0);
      return `零件「${part}」已跳过 ${faces} 个无法网格化的曲面。`;
    });
    if (omissions.size > warnings.length) {
      warnings.push(`另有 ${omissions.size - warnings.length} 组零件跳过了部分曲面。`);
    }
    return {
      robot,
      assets: batch.assets,
      warnings,
    };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
