import type { Mode } from "../../chat/logic/modes.ts";

export interface ProjectDraft {
  name: string;
  mode: Mode;
  directoryToken?: string;
}
