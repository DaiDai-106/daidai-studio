import * as Primitive from "@radix-ui/react-tooltip";
import { type ReactElement, useContext } from "react";
import { DialogContainerContext } from "./DialogContext.ts";

export function Tooltip({
  label,
  shortcut,
  children,
}: {
  label: string;
  shortcut?: string;
  children: ReactElement;
}) {
  const container = useContext(DialogContainerContext);
  return (
    <Primitive.Root>
      <Primitive.Trigger asChild>{children}</Primitive.Trigger>
      <Primitive.Portal container={container}>
        <Primitive.Content className="tooltip" sideOffset={8} collisionPadding={12}>
          {label}
          {shortcut && <kbd>{shortcut}</kbd>}
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
