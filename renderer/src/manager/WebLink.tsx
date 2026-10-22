import type { ComponentProps } from "react";
import { webLink } from "../../../src/shared/web-links.mjs";
export { webLink };
export const externalOpenLabel = () =>
  window.crewWindow?.integratedTitlebar ? "Open in Safari" : "Open in browser";
export function WebLink({
  href,
  children,
  node: _node,
  ...props
}: ComponentProps<"a"> & { node?: unknown }) {
  const url = webLink(href);
  return url ? (
    <a
      {...props}
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title={externalOpenLabel()}
      className={
        props.className ||
        "break-words text-primary underline underline-offset-4"
      }
    >
      {children}
    </a>
  ) : (
    <span>{children}</span>
  );
}
