import test from 'node:test';
import assert from 'node:assert/strict';
import { createSounds, createCallCues, CUES } from './sounds.js';
import { attentionKeys, createAttentionSounds } from './attention-sounds.js';

test('only explicit human action evidence qualifies, with exact question/run correlation', () => {
  const work = { threadId: 'manager', approvals: [{ id: 'approval' }], items: [{ attention: { id: 'decision', message: 'Choose account' } }], messages: [{ role: 'assistant', text: 'Done. Any questions?' }], status: 'failed' };
  const task = { id: 'worker', runId: 'run', status: 'awaiting_answer', question: { id: 'q', runId: 'run' } };
  assert.equal(attentionKeys(work, { tasks: [task] }).length, 3);
  for (const extra of [{ answer: { questionId: 'q' } }, { runId: 'other' }, { status: 'running' }]) assert.equal(attentionKeys({}, { tasks: [{ ...task, ...extra }] }).length, 0);
  for (const status of ['completed', 'failed', 'blocked', 'running']) assert.deepEqual(attentionKeys({ messages: work.messages, status }, { tasks: [{ status, attention: [{ kind: status, id: 'event' }] }] }), []);
});

test('attention is once per identity across snapshots, SSE replay and reload; new run can sound', () => {
  let stored; const storage = { getItem: () => stored, setItem: (_, value) => { stored = value; } };
  const played = [], play = kind => played.push(kind);
  let observe = createAttentionSounds(play, storage);
  const work = { threadId: 'manager', approvals: [{ id: 'a' }, { id: 'b' }] };
  observe(work); observe(work); observe({}); observe(work);
  observe = createAttentionSounds(play, storage); observe(work);
  assert.deepEqual(played, ['attention']);
  observe({ ...work, threadId: 'different' });
  const task = { id: 'task', status: 'awaiting_answer', runId: 'run', question: { runId: 'run', id: 'q' } };
  observe({}, { tasks: [task] }); observe({}, { tasks: [task] });
  observe({}, { tasks: [{ ...task, runId: 'run2', question: { ...task.question, runId: 'run2' } }] });
  assert.equal(played.length, 4);
});

test('call cues follow connection, explicit mute/unmute and teardown once', () => {
  const played = [], cues = createCallCues(kind => played.push(kind));
  cues.ended(); cues.connected(); cues.connected(); cues.input(true); // automatic open mic: no unmute cue
  cues.requestInput(); cues.input(false); cues.input(false);
  cues.requestInput(); cues.input(false, true); cues.input(true); cues.input(true);
  cues.ended(); cues.input(false); cues.ended();
  assert.deepEqual(played, ['connected', 'muted', 'unmuted', 'ended']);
  cues.connected(); cues.requestInput(); cues.input(false, true); cues.input(false); // denied/canceled capture
  cues.ended();
  assert.deepEqual(played.slice(4), ['connected', 'ended']);
});

test('PTT and permission failure do not pretend a mute or unmute succeeded', () => {
  const played = [], cues = createCallCues(kind => played.push(kind));
  cues.connected(); cues.input(true); cues.input(false); cues.requestInput(); cues.input(false, true); cues.input(false);
  assert.deepEqual(played, ['connected']);
});

test('original earcons schedule output-only envelopes and release all resources', async () => {
  const scheduled = [], nodes = [], states = [];
  const audio = { state: 'suspended', currentTime: 1, destination: {}, async resume() { this.state = 'running'; }, async close() { this.state = 'closed'; }, createOscillator() {
    const node = { frequency: {}, connect() {}, disconnect() { this.disconnected = true; }, start(time) { scheduled.push([this.frequency.value, time]); }, stop() {} }; nodes.push(node); return node;
  }, createGain() { const node = { gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() { this.disconnected = true; } }; nodes.push(node); return node; } };
  const sounds = createSounds({ context: () => audio, onUnavailable: value => states.push(value) });
  sounds.play('attention'); assert.equal(scheduled.length, 0);
  sounds.unlock(); await Promise.resolve();
  for (const kind of Object.keys(CUES)) sounds.play(kind);
  assert.equal(scheduled.length, 10); assert.ok(states.includes(true)); assert.equal(states.at(-1), false);
  sounds.dispose(); assert.equal(audio.state, 'closed'); assert.ok(nodes.every(node => node.disconnected));
  sounds.play('connected'); assert.equal(scheduled.length, 10);
});

test('new approval incarnation or turn can reuse a transport request ID without being silenced', () => {
 const sounds = [], observe = createAttentionSounds(kind => sounds.push(kind));
 const work = {threadId:'manager', approvals:[{id:'1',attentionId:'first-incarnation'}]};
 observe(work); observe(work); observe({...work,approvals:[{id:'1',attentionId:'second-incarnation'}]});
 assert.equal(sounds.length,2);
 observe({threadId:'manager',approvals:[{id:'2',params:{turnId:'turn-a'}}]});
 observe({threadId:'manager',approvals:[{id:'2',params:{turnId:'turn-b'}}]});
 assert.equal(sounds.length,4);
});

const workerApproval = (extra = {}) => ({ status: 'pending', taskId: 'worker-task', runId: 'worker-run', threadId: 'native-worker-thread', turnId: 'native-worker-turn', requestId: 17, method: 'item/commandExecution/requestApproval', ...extra });
test('worker native approvals sound once across timeline deltas, reconnect and renderer reload', () => {
 let stored; const storage = { getItem: () => stored, setItem: (_, value) => { stored = value; } };
 const played = [], play = cue => played.push(cue), task = { id: 'worker-task', runId: 'worker-run' };
 let observe = createAttentionSounds(play, storage);
 observe({}, { tasks: [task] }, [workerApproval()]);
 observe({ messages: [{ id: 'timeline-delta', text: 'ordinary progress' }] }, { tasks: [task] }, [workerApproval({ params: { reason: 'same request updated' } })]);
 observe({}, { tasks: [task] }, []); observe({}, { tasks: [task] }, [workerApproval()]);
 observe = createAttentionSounds(play, storage); observe({}, { tasks: [task] }, [workerApproval()]);
 assert.deepEqual(played, ['attention']);
 observe({}, { tasks: [task] }, [workerApproval({ requestId: '17' })]);
 assert.equal(played.length, 2, 'native numeric and string request IDs are different');
 observe({}, { tasks: [{ ...task, runId: 'worker-run-new' }] }, [workerApproval({ runId: 'worker-run-new' })]);
 assert.equal(played.length, 3);
});
test('only genuinely pending current-run worker requests qualify, including nullable-turn connector requests', () => {
 const view = { tasks: [{ id: 'worker-task', runId: 'worker-run' }] };
 for (const status of ['decided', 'delivered', 'delivery-unknown', 'resolved', 'stale', undefined]) assert.deepEqual(attentionKeys({}, view, [workerApproval({ status })]), []);
 assert.deepEqual(attentionKeys({}, view, [null, {}, workerApproval({ runId: 'old-run' }), workerApproval({ turnId: null }), workerApproval({ requestId: {} })]), []);
 for (const status of ['completed', 'stopped', 'paused', 'disposed', 'failed']) assert.deepEqual(attentionKeys({}, { tasks: [{ ...view.tasks[0], status }] }, [workerApproval()]), []);
 const connector = workerApproval({ turnId: null, method: 'mcpServer/elicitation/request' });
 const keys = attentionKeys({}, view, [connector]);
 assert.equal(keys.length, 1); assert.deepEqual(JSON.parse(keys[0]), ['worker-approval', 'worker-task', 'worker-run', 'native-worker-thread', null, 17]);
});
