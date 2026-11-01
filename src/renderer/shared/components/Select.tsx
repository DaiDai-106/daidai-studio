import * as Menu from "@radix-ui/react-dropdown-menu";
import { type ComponentProps, useContext } from "react";
import { DialogChangeContext, DialogContainerContext } from "../logic/DialogContext.ts";
import { Icon } from "./Icon.tsx";

type Props<T extends string> = Pick<
  ComponentProps<typeof Menu.Trigger>,
  "id" | "aria-label" | "aria-describedby" | "disabled"
> & {
  value: T;
  onValueChange?: (value: T) => void;
  options: readonly { value: T; label: string; disabled?: boolean }[];
};

export function Select<T extends string>({ value, onValueChange, options, ...trigger }: Props<T>) {
  const container = useContext(DialogContainerContext);
  const markChanged = useContext(DialogChangeContext);
  const selected = options.find((option) => option.value === value);
  return (
    <Menu.Root modal={false}>
      <Menu.Trigger {...trigger} className="select-trigger">
        <span>{selected?.label ?? "请选择"}</span>
        <Icon name="chevron-down" size={14} />
      </Menu.Trigger>
      <Menu.Portal container={container}>
        <Menu.Content className="select-content" align="end" sideOffset={6} collisionPadding={12}>
          <Menu.RadioGroup
            value={value}
            onValueChange={(selectedValue) => {
              const option = options.find((item) => item.value === selectedValue);
              if (option && option.value !== value) {
                markChanged();
                onValueChange?.(option.value);
              }
            }}
          >
            {options.map((option) => (
              <Menu.RadioItem
                key={option.value}
                value={option.value}
                disabled={option.disabled ?? false}
                className="select-option"
              >
                <span>{option.label}</span>
                <Menu.ItemIndicator>
                  <Icon name="check" size={15} />
                </Menu.ItemIndicator>
              </Menu.RadioItem>
            ))}
          </Menu.RadioGroup>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}
