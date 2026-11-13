import {
  Archive,
  ArrowLeft,
  ArrowUp,
  Axis3D,
  Bot,
  Box,
  Check,
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  House,
  Image,
  Info,
  Keyboard,
  LoaderCircle,
  Maximize,
  MessageSquare,
  MessageSquarePlus,
  MoreHorizontal,
  PanelLeft,
  Pencil,
  Plug,
  Plus,
  RefreshCw,
  Search,
  Settings,
  SlidersHorizontal,
  Square,
  X,
} from "lucide-react";
import { Tooltip } from "./tooltip.tsx";

const icons = {
  plus: Plus,
  home: House,
  stop: Square,
  axes: Axis3D,
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
  archive: Archive,
  check: Check,
  more: MoreHorizontal,
  refresh: RefreshCw,
  file: FileText,
  keyboard: Keyboard,
  loading: LoaderCircle,
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
  disabled,
  expanded,
  controls,
}: {
  icon: IconName;
  label: string;
  shortcut?: string;
  onClick: () => void;
  disabled?: boolean;
  expanded?: boolean;
  controls?: string;
}) {
  return (
    <Tooltip label={label} {...(shortcut ? { shortcut } : {})}>
      <button
        type="button"
        className="icon-button"
        aria-label={label}
        aria-expanded={expanded}
        aria-controls={controls}
        onClick={onClick}
        disabled={disabled}
      >
        <Icon name={icon} />
      </button>
    </Tooltip>
  );
}
