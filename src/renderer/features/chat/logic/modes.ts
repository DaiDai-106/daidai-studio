export const modes = [
  {
    id: "general",
    label: "通用对话",
    icon: "chat",
    description: "日常交流与项目讨论",
  },
  {
    id: "scene",
    label: "场景搭建",
    icon: "box",
    description: "中央查看场景，右侧继续对话",
  },
  {
    id: "robot",
    label: "Dai Robotics",
    icon: "model",
    description: "对话协作，查看机器人设备状态",
  },
] as const;

export type Mode = (typeof modes)[number]["id"];

export function modeLabel(id: Mode): string {
  return modes.find((mode) => mode.id === id)?.label ?? id;
}
