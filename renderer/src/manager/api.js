// Same-origin backend contract. No direct Codex credentials or model calls in the renderer.
export async function api(path, body = {}) {
  const response = await fetch(`/api/${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error || `Request failed (${response.status}).`);
    error.account = result.account;
    throw error;
  }
  return result;
}
export const errorText = error => error?.message || String(error);
export function endVoiceBeacon() {
  try { navigator.sendBeacon?.('/api/disconnect', new Blob(['{}'], { type: 'application/json' })); }
  catch { /* Closing the event stream also stops backend voice. */ }
}
