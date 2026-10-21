import { attentionKeys } from '../../../attention-keys.mjs';
export { attentionKeys } from '../../../attention-keys.mjs';

// Survives SSE reconnect and reload and window reopening. Storage is scoped to this
// loopback origin (one configured project); unavailable storage falls back safely.
export function createAttentionSounds(play, storage) {
  const key = 'crew.attention-sounds.v1';
  let seen;
  try { const saved = JSON.parse(storage?.getItem(key) || '[]'); seen = new Set(Array.isArray(saved) ? saved.filter(value => typeof value === 'string') : []); }
  catch { seen = new Set(); }
  return (work, orchestration, workerApprovals) => {
    let fresh = false;
    for (const id of attentionKeys(work, orchestration, workerApprovals)) if (!seen.has(id)) { seen.add(id); fresh = true; }
    if (!fresh) return;
    // One chime for a snapshot containing several new requests; no sound storm.
    // Retain all IDs for this instance, so old replay cannot sound again.
    try { storage?.setItem(key, JSON.stringify([...seen])); } catch { /* In-memory dedup still applies. */ }
    play('attention');
  };
}
