import {
  Archive,
  ArrowLeft,
  ArrowUp,
  Axis3D,
  BookOpen,
  Bot,
  Box,
  Check,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  FileText,
  Folder,
  Grid2X2,
  Image,
  Info,
  Keyboard,
  Layers,
  Maximize,
  MessageSquare,
  MessageSquarePlus,
  Minus,
  MoreHorizontal,
  PanelLeft,
  Pencil,
  Plug,
  Plus,
  RefreshCw,
  Search,
  Server,
  Settings,
  SlidersHorizontal,
  Square,
  Sun,
  X,
} from "lucide-react";
import { Tooltip } from "./Tooltip.tsx";

const icons = {
  plus: Plus,
  stop: Square,
  minus: Minus,
  axes: Axis3D,
  eye: Eye,
  "eye-off": EyeOff,
  grid: Grid2X2,
  layers: Layers,
  fit: Maximize,
  folder: Folder,
  chat: MessageSquare,
  "new-chat": MessageSquarePlus,
  chevron: ChevronRight,
  "chevron-down": ChevronDown,
  settings: Settings,
  sliders: SlidersHorizontal,
  info: Info,
  image: Image,
  panel: PanelLeft,
  edit: Pencil,
  arrow: ArrowUp,
  back: ArrowLeft,
  close: X,
  search: Search,
  box: Box,
  model: Bot,
  tool: Plug,
  server: Server,
  book: BookOpen,
  archive: Archive,
  check: Check,
  more: MoreHorizontal,
  refresh: RefreshCw,
  file: FileText,
  sun: Sun,
  keyboard: Keyboard,
};
export type IconName = keyof typeof icons;

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const Component = icons[name];
  return <Component size={size} strokeWidth={1.65} aria-hidden="true" />;
}

export function IconButton({
  icon,
  label,
  shortcut,
  onClick,
}: {
  icon: IconName;
  label: string;
  shortcut?: string;
  onClick: () => void;
}) {
  return (
    <Tooltip label={label} {...(shortcut ? { shortcut } : {})}>
      <button type="button" className="icon-button" aria-label={label} onClick={onClick}>
        <Icon name={icon} />
      </button>
    </Tooltip>
  );
}
