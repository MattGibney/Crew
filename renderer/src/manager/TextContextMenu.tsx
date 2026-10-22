import { useRef, useState } from "react";
import type { ReactElement } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { copyText } from "./clipboard.js";
import { externalOpenLabel, webLink } from "./WebLink.js";

/** Snapshot selection before menu focus changes; never turn read-only text into an editor. */
export function TextContextMenu({ children }: { children: ReactElement }) {
  const [context, setContext] = useState({ text: "", link: "" });
  const [status, setStatus] = useState("");
  const previousFocus = useRef<HTMLElement | null>(null);
  const selection = useRef<Range | null>(null);
  const copy = async (text: string) => {
    try {
      await copyText(text);
      setStatus("Copied");
    } catch {
      setStatus("Could not copy. Try the keyboard copy shortcut.");
    }
  };
  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={children}
        onTouchStart={(event) => event.preventBaseUIHandler()}
        onKeyDown={(event) => {
          if (
            event.key !== "ContextMenu" &&
            !(event.shiftKey && event.key === "F10")
          )
            return;
          const target =
            event.target instanceof HTMLElement ? event.target : null;
          if (
            !target ||
            target.closest(
              "input,textarea,[contenteditable]:not([contenteditable='false'])",
            )
          )
            return;
          if (
            !webLink(target.closest("a")?.getAttribute("href")) &&
            !window.getSelection()?.toString()
          )
            return;
          event.preventDefault();
          const rect = target.getBoundingClientRect();
          target.dispatchEvent(
            new MouseEvent("contextmenu", {
              bubbles: true,
              cancelable: true,
              button: 2,
              clientX: rect.left,
              clientY: rect.bottom,
            }),
          );
        }}
        onContextMenu={(event) => {
          const target = event.target instanceof Element ? event.target : null;
          // Native browser/Electron edit menus preserve caret, undo, paste and React drafts.
          if (
            target?.closest(
              "input,textarea,[contenteditable]:not([contenteditable='false'])",
            )
          ) {
            event.preventBaseUIHandler();
            // Base UI also suppresses document contextmenu events inside its trigger.
            event.stopPropagation();
            return;
          }
          const selected = window.getSelection();
          const text = selected?.toString() || "";
          const link =
            webLink(target?.closest("a")?.getAttribute("href")) || "";
          if (!text && !link) {
            event.preventBaseUIHandler();
            // Base UI also suppresses document contextmenu events inside its trigger.
            event.stopPropagation();
            return;
          }
          previousFocus.current =
            document.activeElement instanceof HTMLElement
              ? document.activeElement
              : null;
          selection.current = selected?.rangeCount
            ? selected.getRangeAt(0).cloneRange()
            : null;
          setContext({ text, link });
          setStatus("");
        }}
      />
      <ContextMenuContent
        aria-label="Text and link actions"
        finalFocus={() => {
          previousFocus.current?.focus({ preventScroll: true });
          if (selection.current) {
            const selected = window.getSelection();
            selected?.removeAllRanges();
            selected?.addRange(selection.current);
          }
          return false;
        }}
      >
        {context.text && (
          <ContextMenuItem onClick={() => void copy(context.text)}>
            Copy
          </ContextMenuItem>
        )}
        {context.link && (
          <>
            <ContextMenuItem onClick={() => void copy(context.link)}>
              Copy link
            </ContextMenuItem>
            <ContextMenuItem
              onClick={() =>
                window.open(context.link, "_blank", "noopener,noreferrer")
              }
            >
              {externalOpenLabel()}
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
      <span role="status" className="sr-only">
        {status}
      </span>
    </ContextMenu>
  );
}
