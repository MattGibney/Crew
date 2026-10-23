import type { ComponentProps } from "react";
import { cn } from "cn";

export interface OnlineStatusProps extends Omit<
  ComponentProps<"span">,
  "children"
> {
  online: boolean;
  /** Optional resource-specific label, such as Connected. */
  label?: string;
}

/** Availability display only; callers determine whether the resource is online. */
export function OnlineStatus({
  online,
  label,
  className,
  ...props
}: OnlineStatusProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 whitespace-nowrap",
        className,
      )}
      {...props}
    >
      <span
        aria-hidden="true"
        className={cn(
          "flex size-4 shrink-0 items-center justify-center rounded-full",
          online ? "bg-green-500/10" : "bg-gray-400/10",
        )}
      >
        <span
          className={cn(
            "size-2.5 rounded-full",
            online ? "bg-green-500" : "bg-gray-400",
          )}
        />
      </span>
      {label ?? (online ? "Online" : "Offline")}
    </span>
  );
}
