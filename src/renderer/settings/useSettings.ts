import type { SkillConfig } from "../../shared/capabilities.ts";
import type { ApplicationState } from "../application/useApplication.ts";
import type { Capability, McpServer, Skill, Theme } from "../types.ts";
import { mcpConfig, mcpServer } from "./connectionConfig.ts";
import { availableModels } from "./models.ts";

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
  function persistToggles(previous: Capability[], next: Capability[]) {
    const changed = next.filter(
      (item) =>
        item.builtin && previous.some((old) => old.id === item.id && old.enabled !== item.enabled),
    );
    if (!changed.length) return;
    void application.run(async () => {
      for (const item of changed) {
        if (
          item.id !== "builtin.cad" &&
          item.id !== "builtin-scene" &&
          item.id !== "builtin.alignment" &&
          item.id !== "builtin-alignment-skill"
        )
          throw new Error("未知内置能力。");
        await application.api.setCapabilityEnabled(item.id, item.enabled);
      }
      await application.refresh();
    });
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
    setServers: (items: McpServer[]) => {
      persistToggles(servers, items);
      const previous = new Map(servers.map((server) => [server.id, server]));
      const changed = items.filter((server) => {
        const old = previous.get(server.id);
        return (
          !server.builtin &&
          (!old || JSON.stringify(mcpConfig(old)) !== JSON.stringify(mcpConfig(server)))
        );
      });
      const removed = servers.filter(
        (server) => !server.builtin && !items.some((item) => item.id === server.id),
      );
      if (!changed.length && !removed.length) return;
      void application.run(async () => {
        for (const server of changed) await application.api.saveMcp(mcpConfig(server));
        for (const server of removed) await application.api.removeMcp(server.id);
        await application.refresh();
      });
    },
    inspectServer: (server: McpServer, projectId: string) =>
      application.api.inspectMcp(mcpConfig(server), projectId),
    cancelInspection: (id: string) => application.api.cancelMcpInspection(id),
    skills,
    setSkills: (items: Skill[]) => {
      persistToggles(skills, items);
      function config(skill: Skill): SkillConfig {
        return {
          id: skill.id,
          name: skill.name,
          description: skill.description,
          body: skill.body,
          enabled: skill.enabled,
          scope: skill.scope,
          modes: skill.modes,
        };
      }
      const previous = new Map(skills.map((skill) => [skill.id, skill]));
      const changed = items.filter((skill) => {
        if (skill.builtin) return false;
        const old = previous.get(skill.id);
        return !old || JSON.stringify(config(old)) !== JSON.stringify(config(skill));
      });
      const removed = skills.filter(
        (skill) => !skill.builtin && !items.some((item) => item.id === skill.id),
      );
      if (!changed.length && !removed.length) return;
      void application.run(async () => {
        for (const skill of changed) await application.api.saveSkill(config(skill));
        for (const skill of removed) await application.api.removeSkill(skill.id);
        await application.refresh();
      });
    },
  };
}
