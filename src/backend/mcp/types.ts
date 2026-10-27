export interface ToolInvocation {
  signal: AbortSignal;
  progress(phase: string): Promise<void>;
}

// A bundled plugin's executable entry and trusted launch data; no SDK server factories.
export interface BuiltinMcpDefinition {
  id: string;
  name: string;
  description: string;
  modes: ("general" | "scene")[];
  available: boolean;
  serverPath: string;
  configuration: object;
  sceneStorage?: boolean;
  toolDescriptions?: Readonly<Record<string, string>>;
}
