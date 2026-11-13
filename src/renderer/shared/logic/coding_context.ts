import { createContext } from "react";
import type { FileReference } from "../../../shared/file_references.ts";

/** 聊天只发起明确的打开动作，实际文件仍由后端校验。 */
export const CodingOpenContext = createContext<{
  openUrl: (url: string) => void;
  openFile: (reference: FileReference) => void;
} | null>(null);
