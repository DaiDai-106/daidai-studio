export const PREVIEW_OPEN_CHANNEL = "preview:open";
export const PREVIEW_OPEN_FILE_CHANNEL = "preview:open-file";
export const PREVIEW_SHOW_CHANNEL = "preview:show";
export const PREVIEW_CONTROL_CHANNEL = "preview:control";
export const PREVIEW_EVENT_CHANNEL = "preview:event";

export type PreviewBounds = { x: number; y: number; width: number; height: number };
export type PreviewAction = "back" | "forward" | "reload" | "close";
export type PreviewEvent = {
  projectId: string;
  tabId: string;
  status: "loading" | "ready" | "error";
  url: string;
  canGoBack: boolean;
  canGoForward: boolean;
  error?: string;
};

export interface PreviewBridge {
  open(projectId: string, tabId: string, url: string): Promise<void>;
  openFile(projectId: string, tabId: string, path: string): Promise<void>;
  show(projectId: string, tabId: string, bounds: PreviewBounds | null): Promise<void>;
  control(projectId: string, tabId: string, action: PreviewAction): Promise<void>;
  subscribe(listener: (event: PreviewEvent) => void): () => void;
}
