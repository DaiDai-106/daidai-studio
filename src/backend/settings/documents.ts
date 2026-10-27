import { defineDoc } from "@earendil-works/pi-durable";
import type { McpConfig, SkillConfig } from "../../shared/capabilities.ts";
import type { Theme } from "../../shared/desktop.ts";
import type { StoredProvider } from "./credentials.ts";

export type SettingsRecord = {
  providers: StoredProvider[];
  defaultModel: string;
  theme: Theme;
  showThinking?: boolean;
  deviceId: string;
  disabledCapabilities?: string[];
  skills?: SkillConfig[];
  mcpServers?: McpConfig[];
};

export const SettingsDoc = defineDoc<SettingsRecord>({
  kind: "app.settings",
  version: 1,
  scope: "session",
  initial: () => ({
    providers: [],
    defaultModel: "",
    theme: "light",
    deviceId: crypto.randomUUID(),
  }),
});
