import { Plug } from "lucide-react";
import { siGithub, siGmail, siLinear } from "simple-icons";
import slackLogo from "@/assets/services/slack.png";
import { cn } from "@/lib/utils";

const icons = { github: siGithub, gmail: siGmail, linear: siLinear };

/** Decorative brand mark; pair with a visible service name for accessibility. */
export function ServiceLogo({
  service,
  className,
}: {
  service: string;
  className?: string;
}) {
  const key = service.trim().toLowerCase();
  const classes = cn("size-5 shrink-0", className);
  if (key === "slack") {
    return (
      <img
        src={slackLogo}
        alt=""
        aria-hidden="true"
        className={cn(classes, "object-contain")}
      />
    );
  }
  const icon = Object.hasOwn(icons, key)
    ? icons[key as keyof typeof icons]
    : undefined;
  if (!icon) return <Plug aria-hidden="true" className={classes} />;
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      className={cn(classes, key === "github" && "text-foreground")}
      fill={key === "github" ? "currentColor" : `#${icon.hex}`}
    >
      <path d={icon.path} />
    </svg>
  );
}
