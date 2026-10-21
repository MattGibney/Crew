export const EMPTY_WORK = { approvals: [], connectors: [], items: [], messages: [], status: 'preparing' };
export function chooseVoice(catalog, saved) {
  return catalog.voices.some(voice => voice.id === saved) ? saved : catalog.defaultVoice;
}
export function connectorVerificationURL(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null; }
  catch { return null; }
}
