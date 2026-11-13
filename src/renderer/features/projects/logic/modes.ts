import type { ConversationMode as Mode } from "../../../../contracts/capabilities.ts";

export const modes = [
  {
    id: "coding",
    label: "Coding",
    icon: "chat",
  },
  {
    id: "scene",
    label: "场景搭建",
    icon: "box",
  },
  {
    id: "robot",
    label: "Dai Robotics",
    icon: "model",
  },
] as const;

export function modeLabel(id: Mode): string {
  return modes.find((mode) => mode.id === id)?.label ?? id;
}
