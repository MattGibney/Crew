import { randomUUID } from 'node:crypto';
import { conversationMessage, presentUserMessage } from './conversation.mjs';

// Presentation-only projection. Identity always comes from the protocol, never text.
export function createConversationTimeline() {
  const messages = new Map(), promotions = new Map(), activeFlat = new Map();
  let nextPosition = 0;
  const position = value => { const resolved = Number.isFinite(value) ? value : nextPosition++; nextPosition = Math.max(nextPosition, resolved + 1); return resolved; };
  function put(message, options = {}) {
    if (!message?.id) return;
    const old = messages.get(message.id);
    // Late starts/deltas must not reopen a committed item.
    if (old?.status === 'complete' && options.status === 'streaming') return;
    if (message.text === '' && old?.text) {
      message = { ...message, text: old.text };
      options = { ...options, status: options.status === 'streaming' ? old.status : old.status === 'complete' ? 'complete' : 'partial' };
    }
    const promoted = promotions.get(message.id);
    // The backing native exchange and the speech transcript are distinct
    // artifacts. Only the delegation envelope and exact turn establish origin;
    // text equality, proximity and a voice session do not establish a link.
    const delegated = message.source !== 'voice' && message.turnId &&
      (message.presentation === 'realtime-input-v1' || message.origin === 'realtime-delegation' ||
        [...messages.values()].some(entry => entry.turnId === message.turnId && entry.origin === 'realtime-delegation'));
    if (delegated) {
      message = { ...message, origin: 'realtime-delegation' };
      // The native input may arrive after its assistant output.
      for (const [id, entry] of messages) if (entry.turnId === message.turnId && entry.source !== 'voice') messages.set(id, { ...entry, origin: 'realtime-delegation' });
    }
    messages.set(message.id, { ...old, ...message, ...(promoted ? { promotionId: promoted.id } : {}), status: options.status || 'complete', position: promoted?.position ?? (Number.isFinite(options.position) ? position(options.position) : old?.position ?? position()) });
  }
  function record(item, turnId, options = {}) {
    const message = conversationMessage(item, turnId);
    if (message?.role === 'user' && !messages.has(item.id) && !Number.isFinite(options.position)) {
      const first = [...messages.values()].find(entry => entry.turnId === turnId && entry.source !== 'voice');
      if (first) options = { ...options, position: first.position - 0.001 };
    }
    put(message, options);
  }
  function realtime(item, options = {}) {
    if (item.type === 'transcriptSegment') put({ id: item.id, role: item.role, text: item.text, source: 'voice' }, options);
    else if (item.type === 'bemItemPromoted') {
      const existing = promotions.get(item.itemId);
      // A single native item is referenced by several presentation fragments.
      if (existing && (existing.id !== item.id || !Number.isFinite(options.position))) return;
      const at = position(options.position); promotions.set(item.itemId, { id: item.id, position: at });
      const message = messages.get(item.itemId); if (message) messages.set(item.itemId, { ...message, promotionId: item.id, position: at });
    } else if (item.type === 'realtimeSessionClosed') partial();
    else if (Number.isFinite(options.position)) position(options.position);
  }
  function delta(itemId, text) {
    const message = messages.get(itemId);
    if (message?.status === 'streaming' && typeof text === 'string') messages.set(itemId, { ...message, text: message.text + text });
  }
  function flat(role, text, { done = false } = {}) {
    if (!['user', 'assistant'].includes(role) || typeof text !== 'string') return;
    let id = activeFlat.get(role);
    if (!id) { id = `voice-${randomUUID()}`; activeFlat.set(role, id); put({ id, role, text: '', source: 'voice' }, { status: 'streaming' }); }
    const previous = messages.get(id);
    put({ ...previous, text: done ? text : previous.text + text }, { status: done ? 'complete' : 'streaming' });
    if (done) activeFlat.delete(role);
  }
  function partial({ voiceOnly = true } = {}) { for (const [id, message] of messages) if (message.status === 'streaming' && (!voiceOnly || message.source === 'voice')) messages.set(id, { ...message, status: 'partial' }); activeFlat.clear(); }
  function resumeTurn(turnId, saved = []) {
    for (const entry of saved) {
      const message = messages.get(entry.id);
      if (message?.turnId !== turnId || message.role !== 'assistant' || !['streaming', 'partial'].includes(entry.status)) continue;
      const text = entry.text?.startsWith(message.text) ? entry.text : message.text;
      messages.set(entry.id, { ...message, text, status: 'streaming' });
    }
  }
  const snapshot = () => {
    const ordered = [...messages.values()].sort((a, b) => a.position - b.position);
    if (ordered.length > 400) {
      const discard = ordered.filter(message => message.status !== 'streaming').slice(0, ordered.length - 400);
      for (const message of discard) { messages.delete(message.id); promotions.delete(message.id); }
    }
    while (promotions.size > 400) promotions.delete(promotions.keys().next().value);
    return ordered.filter(message => messages.has(message.id)).slice(-200);
  };
  function restore(entries) {
    for (const entry of entries || []) if (entry && typeof entry.id === 'string' && ['user', 'assistant'].includes(entry.role) && typeof entry.text === 'string') {
      if (typeof entry.promotionId === 'string' && entry.promotionId && Number.isFinite(entry.position)) promotions.set(entry.id, { id: entry.promotionId, position: entry.position });
      put(presentUserMessage(entry), { status: entry.status === 'streaming' ? 'partial' : entry.status, position: entry.position });
    }
  }
  function restoreProvenance(entries) {
    // Canonical content/status/order wins. Carry only presentation provenance
    // from an exact journal item/turn/actor match (the bridge validates thread).
    for (const saved of entries || []) {
      if (!saved || typeof saved.id !== 'string') continue;
      const current = messages.get(saved.id);
      if (saved.origin !== 'realtime-delegation' || !saved.turnId || current?.turnId !== saved.turnId || current.role !== saved.role || current.source === 'voice' || saved.source === 'voice') continue;
      put({ ...current, origin: saved.origin }, { status: current.status, position: current.position });
    }
  }
  return { record, realtime, delta, flat, partial, snapshot, restore, restoreProvenance, resumeTurn };
}
