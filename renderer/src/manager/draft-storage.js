// Electron gives each project its own persistent session partition and controller origin.
// Store only an unsent draft here; never submit or turn restored text into work.
const KEY = 'crew.manager.draft.v1';
export function projectDraftStorage() {
  try { return window.localStorage; } catch { return null; }
}
export function readDraft(storage) {
  try { return (storage.getItem(KEY) || '').slice(0, 8000); }
  catch { return ''; }
}
export function writeDraft(storage, value) {
  try {
    if (value) storage.setItem(KEY, value.slice(0, 8000));
    else storage.removeItem(KEY);
  } catch { /* Draft remains usable in memory when local storage is unavailable. */ }
}
