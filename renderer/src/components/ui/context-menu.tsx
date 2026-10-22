import type * as React from "react";
import { ContextMenu as Primitive } from "@base-ui/react/context-menu";
import { cn } from "cn";

export const ContextMenu = Primitive.Root;
export const ContextMenuTrigger = Primitive.Trigger;
export function ContextMenuContent({
  className,
  ...props
}: React.ComponentProps<typeof Primitive.Popup>) {
  return (
    <Primitive.Portal>
      <Primitive.Positioner
        className="z-50"
        sideOffset={4}
        collisionPadding={8}
      >
        <Primitive.Popup
          data-slot="context-menu-content"
          className={cn(
            "min-w-44 max-w-[calc(100vw-1rem)] rounded-lg border bg-popover p-1 text-popover-foreground shadow-md outline-none",
            className,
          )}
          {...props}
        />
      </Primitive.Positioner>
    </Primitive.Portal>
  );
}
export function ContextMenuItem({
  className,
  ...props
}: React.ComponentProps<typeof Primitive.Item>) {
  return (
    <Primitive.Item
      data-slot="context-menu-item"
      className={cn(
        "flex cursor-default select-none items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}
