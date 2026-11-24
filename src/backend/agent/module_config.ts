import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { ProjectInfo } from "../../contracts/application.ts";
import type { createPlanningService } from "../module/planning/service.ts";
import type { createSceneService } from "../module/scene/service.ts";
import type { createExtensionUi } from "./extension_ui.ts";
import { codingPrompt } from "./prompt/coding.ts";
import { planningPrompt } from "./prompt/planning.ts";
import { scenePrompt } from "./prompt/scene.ts";
import type { createShellApproval } from "./shell_approval.ts";
import { createPlanningTools, planningToolNames } from "./tool/planning.ts";
import { createSceneTools, sceneToolNames } from "./tool/scene.ts";

export type AgentModuleConfig = {
  systemPrompt: string;
  extensionFactories: ExtensionFactory[];
  disabledBuiltinExtensions: string[];
  allowPackageExtensions?: true;
  tools?: string[];
  fullAccess?: () => boolean;
  literalFilePaths?: true;
};

const fileReadTools = ["read", "ls", "find", "grep"];
const restrictedBuiltinExtensions = ["mcp", "codemode", "tool-search"];

export function createAgentModuleConfig(
  {
    project,
    conversationId,
    fullAccess = () => false,
  }: {
    project: Pick<ProjectInfo, "id" | "path" | "mode">;
    conversationId: string;
    fullAccess?: () => boolean;
  },
  {
    scene,
    planning,
    extensionUi,
    shellApproval,
  }: {
    scene?: ReturnType<typeof createSceneService>;
    planning?: ReturnType<typeof createPlanningService>;
    extensionUi?: ReturnType<typeof createExtensionUi>;
    shellApproval?: ReturnType<typeof createShellApproval>;
  } = {},
): AgentModuleConfig {
  if (project.mode === "scene") {
    if (!scene) throw new Error("场景工具不可用。");
    return {
      systemPrompt: scenePrompt,
      extensionFactories: [createSceneTools(scene, project.id, fullAccess)],
      disabledBuiltinExtensions: restrictedBuiltinExtensions,
      tools: [...fileReadTools, ...Object.values(sceneToolNames)],
    };
  }

  const shell = shellApproval?.extension(conversationId, fullAccess);
  const shellExtensions = shell ? [shell] : [];
  if (project.mode === "planning") {
    const planningTools =
      planning && extensionUi
        ? createPlanningTools(planning, project, fullAccess, (kind, signal) =>
            extensionUi.choosePlanningSource(conversationId, kind, signal),
          )
        : undefined;
    return {
      systemPrompt: planningPrompt,
      extensionFactories: planningTools ? [planningTools, ...shellExtensions] : shellExtensions,
      disabledBuiltinExtensions: restrictedBuiltinExtensions,
      tools: [
        ...fileReadTools,
        "write",
        "edit",
        ...(shell ? [process.platform === "win32" ? "powershell" : "bash"] : []),
        ...(planningTools ? Object.values(planningToolNames) : []),
      ],
      fullAccess,
      literalFilePaths: true,
    };
  }

  return {
    systemPrompt: codingPrompt,
    extensionFactories: shellExtensions,
    disabledBuiltinExtensions: ["mcp"],
    allowPackageExtensions: true,
    fullAccess,
  };
}
