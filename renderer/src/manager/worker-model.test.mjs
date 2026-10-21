import test from 'node:test';
import assert from 'node:assert/strict';
import { formatElapsed, groupWorkers, workerActionRequest, workerActions, workerTiming } from './worker-model.js';
const at = '2026-10-21T12:00:00.000Z', now = Date.parse(at);
const worker = overrides => ({ id: 'task-example', ticket: 'AI-014', status: 'running', runId: 'run-one', brief: 'Read-only audit', attention: [], lifecycleRequests: [], ...overrides });
test('every task and worktree remains reachable; attention, pending actions and live processes stay active', () => {
  const tasks = Array.from({ length: 20 }, (_, index) => worker({ id: `task-${index}`, status: 'completed', worktree: `/tmp/${index}`, updatedAt: at }));
  tasks.push(worker({ id: 'paused', status: 'paused' }), worker({ id: 'question', status: 'stopped', attention: [{ id: 'q' }] }), worker({ id: 'pending', status: 'stopped', lifecycleRequests: [{ status: 'pending' }] }), worker({ id: 'live', status: 'failed', execution: { live: true } }));
  const groups = groupWorkers(tasks);
  assert.equal(groups.history.length, 20); assert.equal(groups.retained, 20);
  assert.deepEqual(groups.active.map(task => task.id), ['paused', 'question', 'pending', 'live']);
  assert.equal(new Set([...groups.active, ...groups.history].map(task => task.id)).size, tasks.length);
});
test('execution timing requires real matching timestamps; stale liveness and missing end stay unavailable', () => {
  const execution = { runId: 'run-one', live: true, startedAt: new Date(now - 123000).toISOString(), observedAt: at };
  assert.deepEqual(workerTiming(worker({ execution }), now), { live: true, elapsed: 123000, observedAt: at });
  assert.equal(workerTiming(worker({ execution }), now + 16000).live, null);
  assert.equal(workerTiming(worker({ execution }), now + 16000).elapsed, null);
  assert.equal(workerTiming(worker({ execution: { ...execution, live: false } }), now).elapsed, null);
  assert.equal(workerTiming(worker({ execution: { ...execution, runId: 'old-run' } }), now).live, null);
  assert.equal(workerTiming(worker({ execution: { ...execution, live: false, endedAt: at } }), now).elapsed, 123000);
  assert.equal(workerTiming(worker({ status: 'completed', updatedAt: at }), now).elapsed, null);
  assert.equal(formatElapsed(123000), '2m 3s'); assert.equal(formatElapsed(3660000), '1h 1m'); assert.equal(formatElapsed(NaN), null);
});
test('worker actions target one explicit run and reuse correlation instead of dispatching directly', () => {
  const request = workerActionRequest(worker({}), 'pause', 'stable-action-id');
  assert.equal(request.requestId, 'stable-action-id');
  assert.ok(request.text.startsWith('CREW_WORKER_ACTION\n'));
  assert.ok(request.text.includes('"taskId":"task-example"'));
  assert.ok(request.text.includes('"expectedRunId":"run-one"'));
  assert.ok(request.text.includes('"actionId":"stable-action-id"'));
  assert.deepEqual(workerActionRequest(worker({}), 'pause', 'stable-action-id'), request);
  assert.throws(() => workerActionRequest(worker({ status: 'disposed' }), 'resume'));
  assert.throws(() => workerActionRequest(worker({ lifecycleRequests: [{ status: 'processing' }] }), 'stop'));
  assert.deepEqual(workerActions(worker({ status: 'failed', execution: { live: true } })), ['pause', 'stop']);
  assert.deepEqual(workerActions(worker({ status: 'paused', question: { id: 'q', runId: 'run-one' } })), ['dispose']);
  assert.deepEqual(workerActions(worker({ status: 'paused', question: { id: 'q', runId: 'run-one' }, answer: { questionId: 'q' } })), ['resume', 'dispose']);
});
