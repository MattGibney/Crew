import { useEffect, useState } from "react";

// Shared across projects and agents at the application's persistent renderer origin.
const key = "crew.ui.conversationSidebarWidth";
function parseWidth(value: string | null): number | null {
  if (value === null) return null;
  const width = Number(value);
  return Number.isFinite(width) && width >= 280 && width <= 720
    ? Math.round(width)
    : null;
}
function savedWidth(): number | null {
  try {
    return parseWidth(localStorage.getItem(key));
  } catch {
    return null;
  }
}
export function useSidebarWidth() {
  const [width, setWidth] = useState<number | null>(savedWidth);
  useEffect(() => {
    try {
      if (width === null) localStorage.removeItem(key);
      else localStorage.setItem(key, String(width));
    } catch {
      // A restricted storage environment must not prevent resizing this window.
    }
  }, [width]);
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (
        event.storageArea === localStorage &&
        (event.key === key || event.key === null)
      )
        setWidth(parseWidth(event.newValue));
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, []);
  return [width, setWidth] as const;
}
