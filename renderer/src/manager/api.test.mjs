import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeApi, decodeManagerEvent } from '../contracts/decode.ts';

test('renderer rejects malformed consumed HTTP payloads before setting UI state', () => {
 assert.throws(() => decodeApi('voices', { voices: [{ id: 42, name: 'Broken' }], defaultVoice: 'broken' }), /Invalid voices response/);
 assert.throws(() => decodeApi('state', { approvals: [], items: [], status: 'idle', messages: [{ role: 'assistant', text: 'Missing native identity' }] }), /Invalid state response/);
 const valid = { voices: [{ id: 'fixture', name: 'Fixture' }], defaultVoice: 'fixture', futureCapability: true };
 assert.equal(decodeApi('voices', valid), valid);
});

test('live decoder remains passive for unknown protocol events and rejects malformed observed state', () => {
 assert.equal(decodeManagerEvent({ type: 'transcript-delta', text: 'Observed only' }), null);
 assert.equal(decodeManagerEvent({ type: 'backend-started' }), null);
 assert.throws(() => decodeManagerEvent({ type: 'worker-approval-state', requests: [{ taskId: 'task', runId: 'run' }] }), /Invalid live event/);
 assert.throws(() => decodeManagerEvent({ type: 'manager-lifecycle', state: { state: 7 } }), /Invalid live event/);
 const notice = { type: 'notice', message: 'Retained work needs review' };
 assert.equal(decodeManagerEvent(notice), notice);
});

test('production nullable lifecycle/update/notes observations remain unavailable rather than malformed', () => {
 const lifecycle = { type: 'manager-lifecycle', state: { state: 'running', error: null, activeVersion: 'version', retainedVersion: 'version' } };
 assert.equal(decodeManagerEvent(lifecycle), lifecycle);
 const updates = { type: 'update-state', status: { phase: 'idle', error: null, workspacePlan: null, plan: null, availableVersion: null } };
 assert.equal(decodeManagerEvent(updates), updates);
 const clearedPlan = { type: 'update-plan-state', plan: null };
 assert.equal(decodeManagerEvent(clearedPlan), clearedPlan);
 const detail = { revision: 2, conversation: [], historyNotice: null, notes: { exists: false, markdown: null, updatedAt: null, path: '/private/task.notes.md' }, links: [] };
 assert.equal(decodeApi('workers/task', detail), detail);
});
