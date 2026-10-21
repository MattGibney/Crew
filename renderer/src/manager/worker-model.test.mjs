import test from 'node:test';
import assert from 'node:assert/strict';
import { formatElapsed, groupWorkers, workerActionRequest, workerActions, workerProgress, workerStatus, workerTiming } from './worker-model.js';
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

test('queued cards show the controller admission reason without inferring capacity or manager intent', () => {
  for (const status of ['queued', 'resume_queued']) {
    for (const capacityWait of ['Waiting for shared worker capacity', 'Waiting while Crew prepares an update', 'Waiting for the manager to start after reopening']) {
      assert.equal(workerProgress(worker({ status, capacityWait, progress: 'Old running progress', result: { message: 'An earlier run completed' } })), capacityWait);
    }
  }
  assert.equal(workerProgress(worker({ status: 'queued' })), 'Waiting to start.');
  assert.equal(workerProgress(worker({ status: 'resume_queued', capacityWait: ' ' })), 'Waiting to resume.');
  assert.equal(workerProgress(worker({ status: 'running', capacityWait: 'Old waiting reason', progress: 'Actual progress' })), 'Actual progress');
  assert.equal(workerProgress(worker({ status: 'failed', failure: 'Actual failure', capacityWait: 'Old waiting reason' })), 'Actual failure');
});

test('missing worktree retirement is honest history and review requests never authorize a recovery mutation', async()=>{
 const {workerRecoveryReviewRequest}=await import('./worker-model.js');
 const retired=worker({status:'disposed',retirement:{reason:'worktree-already-missing',cleanupVerified:false}});
 assert.equal(workerStatus(retired),'Retired');assert.match(workerProgress(retired),/cleanup unverified/);assert.deepEqual(workerActions(retired),[]);
 const request=workerRecoveryReviewRequest(worker({status:'failed',worktree:'/fixture/worker'}));assert.match(request,/"taskId":"task-example"/);assert.match(request,/"expectedRunId":"run-one"/);assert.match(request,/review only/);assert.match(request,/explicitly approve/);
 assert.throws(()=>workerRecoveryReviewRequest(worker({status:'running',worktree:'/fixture/worker'})));
});

test('follow-up cards show current assignment, keep pending direction visible and do not reuse an earlier result', async () => {
  const { currentAssignment, queuedAssignments, workerFollowupRequest, canDiscussFollowup } = await import('./worker-model.js');
  const task = worker({ worktree: '/retained/worker', result: { message: 'Old research result' }, progress: 'Implementing approved changes', currentAssignmentId: 'implementation', assignments: [
    { id: 'initial', status: 'completed', ticket: 'GH-42', brief: 'Research only', result: { message: 'Old research result' } },
    { id: 'implementation', status: 'active', ticket: 'GH-42', brief: 'Implement approved changes' },
    { id: 'documentation', status: 'queued', ticket: 'GH-42', brief: 'Document approved behavior' },
  ] });
  assert.equal(currentAssignment(task).brief, 'Implement approved changes');
  assert.equal(workerProgress(task), 'Implementing approved changes');
  assert.deepEqual(queuedAssignments(task).map(item => item.id), ['documentation']);
  assert.equal(groupWorkers([{ ...task, status: 'completed' }]).active.length, 1);
  const discussion = workerFollowupRequest(task);
  assert.match(discussion, /"expectedAssignmentId":"implementation"/);
  assert.match(discussion, /"expectedRunId":"run-one"/);
  assert.match(discussion, /does not authorize execution/);
  assert.match(discussion, /ask me for the new brief and explicit scope authorization/);
  assert.equal(canDiscussFollowup({ ...task, status: 'disposed' }), false);
  assert.throws(() => workerFollowupRequest({ ...task, worktree: null }));
  assert.equal(currentAssignment(worker({})).brief, 'Read-only audit');
});

test('legacy follow-up selection uses initial identity; held completed follow-ups surface recovery and explicit resume', async () => {
  const { currentAssignment, workerFollowupRequest } = await import('./worker-model.js');
  const legacy = worker({ worktree: '/retained/worker', status: 'completed', result: { message: 'Research complete' } });
  assert.equal(currentAssignment(legacy).id, 'initial');
  assert.match(workerFollowupRequest(legacy), /"expectedAssignmentId":"initial"/);
  assert.deepEqual(workerActions(legacy), ['dispose']);
  const queued = { ...legacy, currentAssignmentId: 'initial', assignments: [
    { id: 'initial', status: 'completed', result: legacy.result },
    { id: 'implementation', status: 'queued' },
  ] };
  for (const followupWait of ['Waiting for explicit resume after reopening', 'Retained worktree has unreviewed changes', 'Retained worktree is missing; review recovery']) {
    const task = { ...queued, followupWait };
    assert.equal(workerProgress(task), followupWait);
    assert.deepEqual(workerActions(task), ['resume', 'dispose']);
    assert.match(workerActionRequest(task, 'resume', 'resume-followup-action').text, /"expectedRunId":"run-one"/);
  }
  assert.equal(workerProgress({ ...legacy, followupWait: 'Stale wait without a pending assignment' }), 'Research complete');
  assert.deepEqual(workerActions({ ...queued, lifecycleRequests: [{ status: 'processing' }] }), []);
  assert.deepEqual(workerActions({ ...queued, execution: { live: true } }), ['pause', 'stop']);
});
