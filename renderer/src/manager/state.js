export const EMPTY_WORK = { approvals: [], connectors: [], items: [], messages: [], status: 'preparing' };
export const EMPTY_TRANSCRIPT = { items: [], open: {}, nextId: 1 };
export function transcriptReducer(state, event) {
  if (event.type === 'reset') return EMPTY_TRANSCRIPT;
  const existing = state.open[event.role];
  const id = existing ?? state.nextId;
  const items = existing == null
    ? [...state.items, { id, role: event.role, text: event.text || '' }]
    : state.items.map(item => item.id === id ? { ...item, text: event.done ? event.text || '' : item.text + (event.text || '') } : item);
  const open = { ...state.open };
  if (event.done) delete open[event.role]; else open[event.role] = id;
  return { items, open, nextId: existing == null ? state.nextId + 1 : state.nextId };
}
export function chooseVoice(catalog, saved) {
  return catalog.voices.some(voice => voice.id === saved) ? saved : catalog.defaultVoice;
}
export function connectorVerificationURL(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null; }
  catch { return null; }
}
