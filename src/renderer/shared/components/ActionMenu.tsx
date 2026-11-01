import * as Menu from "@radix-ui/react-dropdown-menu";
import { type ReactElement, useContext, useState } from "react";
import { DialogContainerContext } from "../logic/DialogContext.ts";
import { Icon, type IconName } from "./Icon.tsx";

type Action = {
  id?: string;
  label: string;
  onSelect: () => void;
  icon?: IconName;
  description?: string;
  selected?: boolean;
  disabled?: boolean;
  danger?: boolean;
  confirmLabel?: string;
};

export function ActionMenu({
  label,
  actions,
  trigger,
  side = "bottom",
}: {
  label: string;
  actions: Action[];
  trigger?: ReactElement;
  side?: "top" | "bottom";
}) {
  const container = useContext(DialogContainerContext);
  const [confirming, setConfirming] = useState<string | null>(null);
  return (
    <Menu.Root modal={false} onOpenChange={() => setConfirming(null)}>
      <Menu.Trigger asChild>
        {trigger ?? (
          <button type="button" className="icon-button menu-trigger" aria-label={label}>
            <Icon name="more" size={16} />
          </button>
        )}
      </Menu.Trigger>
      <Menu.Portal container={container}>
        <Menu.Content
          className="action-menu"
          aria-label={label}
          side={side}
          align="end"
          sideOffset={8}
          collisionPadding={12}
        >
          {actions.map((action) => (
            <Menu.Item
              className="menu-option"
              key={action.id ?? action.label}
              textValue={action.label}
              disabled={action.disabled}
              aria-current={action.selected || undefined}
              data-danger={action.danger || undefined}
              onSelect={(event) => {
                const key = action.id ?? action.label;
                if (action.confirmLabel && confirming !== key) {
                  event.preventDefault();
                  setConfirming(key);
                  return;
                }
                setConfirming(null);
                action.onSelect();
              }}
            >
              {action.icon && <Icon name={action.icon} size={17} />}
              <span className="menu-option-copy">
                <span>
                  {confirming === (action.id ?? action.label) ? action.confirmLabel : action.label}
                </span>
                {action.description && <small>{action.description}</small>}
              </span>
              {action.selected && <Icon name="check" size={15} />}
            </Menu.Item>
          ))}
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}
