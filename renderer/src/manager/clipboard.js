// Electron's media-only permission policy intentionally rejects browser clipboard writes.
// The isolated preload provides a bounded native write action in the desktop app.
export async function copyText(text) {
  if (window.crewWindow?.copyText) await window.crewWindow.copyText(text);
  else await navigator.clipboard.writeText(text);
}
