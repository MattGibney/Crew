import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveManagerVoice } from './manager-voice.ts';
const catalog = { voices: [{ id: 'cove' }, { id: 'maple' }], defaultVoice: 'cove' };
test('legacy project partition preference migrates once without overriding an explicit default profile', async () => {
  const values = new Map([['crew.voice.v3', 'maple']]), calls = [];
  const storage = { getItem: key => values.get(key), removeItem: key => values.delete(key) };
  const save = async input => { calls.push(input); return { voice: input.voice, configured: true, version: 'saved' }; };
  const result = await resolveManagerVoice({ catalog, profile: { voice: null, configured: false, version: 'original' }, storage, save });
  assert.equal(result.selected, 'maple'); assert.deepEqual(calls, [{ voice: 'maple', expectedVersion: 'original' }]); assert.equal(values.size, 0);
  values.set('crew.voice.v3', 'maple');
  const explicit = await resolveManagerVoice({ catalog, profile: { voice: null, configured: true, version: 'explicit' }, storage, save });
  assert.equal(explicit.selected, 'cove'); assert.equal(calls.length, 1);
});
test('unavailable voices fall back honestly and failed migration retains the prior preference', async () => {
  const profile = { voice: null, configured: false, version: 'original' };
  let removed = false;
  const storage = { getItem: () => 'maple', removeItem: () => { removed = true; } };
  await assert.rejects(resolveManagerVoice({ catalog, profile, storage, save: async () => { throw Error('Profile changed'); } }), /Profile changed/);
  assert.equal(removed, false);
  const fallback = await resolveManagerVoice({ catalog, profile: { voice: 'retired', configured: true }, storage, save: async () => { throw Error('must not save'); } });
  assert.equal(fallback.selected, 'cove'); assert.equal(fallback.unavailable, true);
});
