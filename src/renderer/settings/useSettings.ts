import type { SkillConfig } from "../../shared/capabilities.ts";
import type { ApplicationState } from "../application/useApplication.ts";
import type { Capability, McpServer, Skill, Theme } from "../types.ts";
import { mcpConfig, mcpServer } from "./connectionConfig.ts";
import { availableModels } from "./models.ts";

function skillConfig(skill: Skill): SkillConfig {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    body: skill.body,
    enabled: skill.enabled,
    scope: skill.scope,
    modes: skill.modes,
    ...(skill.sceneProfile ? { sceneProfile: skill.sceneProfile } : {}),
    ...(skill.images?.length ? { images: skill.images } : {}),
  };
}

export function useSettings(application: ApplicationState) {
  const settings = application.workspace?.settings;
  const servers: McpServer[] = [
    ...(application.workspace?.builtins.servers ?? []).map((server) => ({
      ...server,
      builtin: true,
      enabled: !settings?.disabledCapabilities.includes(server.id),
      scope: { kind: "global" as const },
      transport: "stdio" as const,
      target: "",
      args: [],
      timeout: 120,
      checked: false,
    })),
    ...(settings?.mcpServers ?? []).map(mcpServer),
  ];
  const skills: Skill[] = [
    ...(application.workspace?.builtins.skills ?? []).map((skill) => ({
      ...skill,
      builtin: true,
      enabled: skill.automatic || !settings?.disabledCapabilities.includes(skill.id),
      scope: { kind: "global" as const },
      body: skill.body ?? "",
    })),
    ...(settings?.skills ?? []).map((skill) => ({ ...skill, builtin: false })),
  ];
  async function syncCapabilities<T extends Capability, Config>(
    previous: T[],
    next: T[],
    config: (item: T) => Config,
    save: (item: Config) => Promise<unknown>,
    remove: (id: string) => Promise<unknown>,
  ): Promise<boolean> {
    const toggles = next.filter(
      (item) =>
        item.builtin && previous.some((old) => old.id === item.id && old.enabled !== item.enabled),
    );
    const old = new Map(previous.map((item) => [item.id, item]));
    const changed = next.filter((item) => {
      const previousItem = old.get(item.id);
      return (
        !item.builtin &&
        (!previousItem || JSON.stringify(config(previousItem)) !== JSON.stringify(config(item)))
      );
    });
    const nextIds = new Set(next.map((item) => item.id));
    const removed = previous.filter((item) => !item.builtin && !nextIds.has(item.id));
    if (!toggles.length && !changed.length && !removed.length) return true;
    return (
      (await application.run(async () => {
        // Builtin switches and custom configurations can be updated independently.
        const results = await Promise.allSettled([
          (async () => {
            for (const item of toggles) {
              if (
                item.id !== "builtin.cad" &&
                item.id !== "builtin-scene" &&
                item.id !== "builtin.alignment" &&
                item.id !== "builtin.viewport" &&
                item.id !== "builtin.scene-profiles" &&
                item.id !== "builtin-alignment-skill"
              )
                throw new Error("未知内置能力。");
              await application.api.setCapabilityEnabled(item.id, item.enabled);
            }
          })(),
          (async () => {
            for (const item of changed) await save(config(item));
            for (const item of removed) await remove(item.id);
          })(),
        ]);
        // Refresh even after a partial failure so the UI reflects successful changes.
        const failed = results.find((result) => result.status === "rejected");
        if (failed?.status === "rejected") {
          await application.refresh().catch(() => {});
          throw failed.reason;
        }
        // The mutation is committed already; a refresh failure must not make the editor
        // treat referenced attachments as unsaved and attempt to delete them.
        await application.refresh().catch(application.report);
        return true;
      })) === true
    );
  }
  return {
    providers: settings?.providers ?? [],
    models: availableModels(settings?.providers ?? []),
    theme: settings?.theme ?? "light",
    showThinking: settings?.showThinking ?? true,
    setShowThinking: (showThinking: boolean) => {
      void application.run(() => application.api.updateSettings({ showThinking }));
    },
    defaultModel: settings?.defaultModel ?? "",
    setTheme: (theme: Theme) => {
      void application.run(() => application.api.updateSettings({ theme }));
    },
    setDefaultModel: (defaultModel: string) => {
      void application.run(() => application.api.updateSettings({ defaultModel }));
    },
    updateProviders: () => {
      void application.refresh().catch(application.report);
    },
    servers,
    setServers: (items: McpServer[]) =>
      syncCapabilities(
        servers,
        items,
        mcpConfig,
        application.api.saveMcp,
        application.api.removeMcp,
      ),
    inspectServer: (server: McpServer, projectId: string) =>
      application.api.inspectMcp(mcpConfig(server), projectId),
    cancelInspection: (id: string) => application.api.cancelMcpInspection(id),
    skills,
    setSkills: (items: Skill[]) =>
      syncCapabilities(
        skills,
        items,
        skillConfig,
        application.api.saveSkill,
        application.api.removeSkill,
      ),
  };
}
