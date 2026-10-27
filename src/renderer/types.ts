// UI projections reuse application metadata and capability configuration.
import type { Mode } from "./workbench/modes.ts";

export type { Theme } from "../shared/desktop.ts";
export type { Mode } from "./workbench/modes.ts";
export type Project = import("../shared/application.ts").ProjectInfo;
export type Model = import("../shared/application.ts").ModelChoice;
export type Message = import("../shared/application.ts").MessageInfo;
export type Conversation = import("../shared/application.ts").ConversationInfo & {
  messages: Message[];
};
export type CapabilityScope = import("../shared/capabilities.ts").CapabilityScope;

// Shared applicability; display labels are derived rather than stored as scope values.
export interface Capability {
  id: string;
  name: string;
  builtin: boolean;
  enabled: boolean;
  scope: CapabilityScope;
  modes: Mode[];
}

export interface McpServer extends Capability {
  description?: string;
  tools?: McpToolSummary[];
  available?: boolean;
  transport: "stdio" | "http";
  target: string;
  args: string[];
  secrets?: { name: string; value?: string }[];
  timeout: number;
  checked: boolean;
}

export interface Skill extends Capability {
  description: string;
  body: string;
  automatic?: boolean;
  sceneProfile?: string;
  images?: import("../shared/capabilities.ts").SkillImage[];
}

export interface McpToolSummary {
  name: string;
  description?: string;
}
