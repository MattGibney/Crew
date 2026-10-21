// Keep native macOS controls above the branding in the integrated header.
export function projectWindowChrome(platform = process.platform) {
  return platform === 'darwin'
    ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 12 } }
    : {};
}
