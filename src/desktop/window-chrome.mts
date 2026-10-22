import type { BrowserWindowConstructorOptions } from "electron";
// Keep native macOS controls above the branding in the integrated header.
export function projectWindowChrome(
  platform: NodeJS.Platform = process.platform,
): Pick<
  BrowserWindowConstructorOptions,
  "titleBarStyle" | "trafficLightPosition"
> {
  return platform === "darwin"
    ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 16, y: 12 } }
    : {};
}
