import { defineDoc, defineDocFamily } from "@earendil-works/pi-durable";
import type { ConversationInfo } from "../../shared/application.ts";
import type { StepSourceInfo } from "../../shared/projects.ts";

type ProjectRecord = {
  id: string;
  name: string;
  path: string;
  hidden?: boolean;
  currentSourceId?: string;
};
type ConversationRecord = Omit<ConversationInfo, "source" | "thinkingLevel"> & {
  selectedSourceId?: string;
  deletedAt?: string;
};

// Persisted flags stay in the backend; only this public projection crosses IPC.
export function conversationInfo(
  record: ConversationRecord,
  source: StepSourceInfo | null = null,
  thinkingLevel: import("../../shared/application.ts").ThinkingLevel = "off",
): ConversationInfo {
  return {
    id: record.id,
    projectId: record.projectId,
    title: record.title,
    mode: record.mode,
    modelId: record.modelId,
    thinkingLevel,
    draft: record.draft,
    archived: record.archived,
    interrupted: record.interrupted,
    source,
  };
}

// Omission means visible, so existing version-1 project records remain compatible.
export const ProjectDoc = defineDocFamily<ProjectRecord, Omit<ProjectRecord, "hidden">>({
  kind: "app.project",
  version: 1,
  scope: "session",
  family: true,
  initial: (seed) => seed,
});
export type StepSourceRecord = StepSourceInfo;
export const StepSourceDoc = defineDocFamily<StepSourceRecord, StepSourceInfo>({
  kind: "app.projectStep",
  version: 1,
  scope: "session",
  family: true,
  initial: (seed) => seed,
});
// Missing deletedAt keeps existing version-1 records accessible.
export const ConversationDoc = defineDoc<ConversationRecord>({
  kind: "app.conversation",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({
    id: "",
    projectId: "",
    title: "新建对话",
    mode: "general",
    modelId: "",
    draft: "",
    archived: false,
    interrupted: false,
  }),
});
