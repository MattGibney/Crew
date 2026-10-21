import test from 'node:test';
import assert from 'node:assert/strict';
import { EMPTY_TRANSCRIPT, chooseVoice, connectorVerificationURL, transcriptReducer, visibleWorkers } from './state.js';

test('transcript deltas accumulate in first-arrival order and final text replaces the partial turn', () => {
  const initial = structuredClone(EMPTY_TRANSCRIPT);
  let state = transcriptReducer(initial, { role: 'user', text: 'Inspect ', done: false });
  state = transcriptReducer(state, { role: 'assistant', text: 'I can ', done: false });
  state = transcriptReducer(state, { role: 'user', text: 'the ticket', done: false });
  assert.deepEqual(state.items.map(item => [item.role, item.text]), [['user', 'Inspect the ticket'], ['assistant', 'I can ']]);
  state = transcriptReducer(state, { role: 'user', text: 'Inspect the agreed ticket.', done: true });
  assert.equal(state.items[0].text, 'Inspect the agreed ticket.');
  state = transcriptReducer(state, { role: 'assistant', text: 'help.', done: false });
  state = transcriptReducer(state, { role: 'assistant', text: 'I can help.', done: true });
  assert.deepEqual(state.items.map(item => [item.role, item.text]), [['user', 'Inspect the agreed ticket.'], ['assistant', 'I can help.']]);
  assert.deepEqual(initial, EMPTY_TRANSCRIPT);
});
test('completed turns get new stable identities and reset removes partial-turn state', () => {
  let state = transcriptReducer(EMPTY_TRANSCRIPT, { role: 'assistant', text: 'First answer.', done: true });
  const firstId = state.items[0].id;
  state = transcriptReducer(state, { role: 'assistant', text: 'Second ', done: false });
  state = transcriptReducer(state, { role: 'assistant', text: 'answer.', done: false });
  assert.notEqual(state.items[1].id, firstId);
  assert.equal(state.items[1].text, 'Second answer.');
  state = transcriptReducer(state, { type: 'reset' });
  assert.deepEqual(state, EMPTY_TRANSCRIPT);
  const fresh = transcriptReducer(state, { role: 'user', text: 'New call.', done: true });
  assert.equal(fresh.items.length, 1); assert.equal(fresh.items[0].text, 'New call.');
});
test('saved voice is used only while advertised; unavailable and absent choices resolve to actual catalog default', () => {
  const catalog = { defaultVoice: 'cove', voices: [{ id: 'cove' }, { id: 'juniper' }] };
  assert.equal(chooseVoice(catalog, 'juniper'), 'juniper');
  assert.equal(chooseVoice(catalog, 'removed-voice'), 'cove');
  assert.equal(chooseVoice(catalog, null), 'cove');
});
test('connector verification accepts only credential-free HTTPS destinations', () => {
  assert.equal(connectorVerificationURL('https://example.com/verify?code=one'), 'https://example.com/verify?code=one');
  for (const value of ['javascript:alert(1)', 'data:text/html,test', 'file:///tmp/config', 'http://example.com', 'https://user:secret@example.com', '//example.com', undefined]) assert.equal(connectorVerificationURL(value), null);
});
test('all active workers remain visible with only the last three terminal workers', () => {
  const tasks = [{ id: 'old', status: 'completed' }, { id: 'active', status: 'running' }, { id: 'failed', status: 'failed' }, { id: 'paused', status: 'paused' }, { id: 'stopped', status: 'stopped' }, { id: 'queued', status: 'queued' }];
  assert.deepEqual(visibleWorkers(tasks).map(task => task.id), ['active', 'queued', 'failed', 'paused', 'stopped']);
  assert.equal(tasks[0].id, 'old');
});
