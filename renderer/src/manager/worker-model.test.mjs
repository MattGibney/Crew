import test from 'node:test';
import assert from 'node:assert/strict';
import { formatElapsed, groupWorkers, workerActionRequest, workerActions, workerProgress, workerStatus, workerTiming } from './worker-model.ts';
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
  assert.deepEqual(workerActions(worker({ status: 'paused', question: { id: 'q', runId: 'run-one' } })), ['resume', 'dispose']);
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
 const {workerRecoveryReviewRequest}=await import('./worker-model.ts');
 const retired=worker({status:'disposed',retirement:{reason:'worktree-already-missing',cleanupVerified:false}});
 assert.equal(workerStatus(retired),'Retired');assert.match(workerProgress(retired),/cleanup unverified/);assert.deepEqual(workerActions(retired),[]);
 const request=workerRecoveryReviewRequest(worker({status:'failed',worktree:'/fixture/worker'}));assert.match(request,/"taskId":"task-example"/);assert.match(request,/"expectedRunId":"run-one"/);assert.match(request,/review only/);assert.match(request,/explicitly approve/);
 assert.throws(()=>workerRecoveryReviewRequest(worker({status:'running',worktree:'/fixture/worker'})));
});

test('follow-up cards show current assignment, keep pending direction visible and do not reuse an earlier result', async () => {
  const { currentAssignment, queuedAssignments, workerFollowupRequest, canDiscussFollowup } = await import('./worker-model.ts');
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
  assert.match(discussion,/CREW_WORKER_DIRECTION/);
  assert.match(discussion,/assign_worker_followup/);
  assert.doesNotMatch(discussion,/ask me for the new brief and explicit scope authorization/);
  assert.equal(canDiscussFollowup({ ...task, status: 'disposed' }), false);
  assert.throws(() => workerFollowupRequest({ ...task, worktree: null }));
  assert.equal(currentAssignment(worker({})).brief, 'Read-only audit');
});

test('legacy follow-up selection uses initial identity; held completed follow-ups surface recovery and explicit resume', async () => {
  const { currentAssignment, workerFollowupRequest } = await import('./worker-model.ts');
  const legacy = worker({ worktree: '/retained/worker', status: 'completed', result: { message: 'Research complete' } });
  assert.equal(currentAssignment(legacy).id, 'initial');
  assert.match(workerFollowupRequest(legacy), /CREW_WORKER_DIRECTION/);
  assert.deepEqual(workerActions(legacy), ['resume', 'dispose']);
  const queued = { ...legacy, currentAssignmentId: 'initial', assignments: [
    { id: 'initial', status: 'completed', result: legacy.result },
    { id: 'implementation', status: 'queued' },
  ] };
  for (const followupWait of ['Native transport unavailable', 'Retained worktree is missing']) {
    const task = { ...queued, followupWait };
    assert.equal(workerProgress(task), followupWait);
    assert.deepEqual(workerActions(task), ['resume', 'dispose']);
    assert.match(workerActionRequest(task, 'resume', 'resume-followup-action').text, /"expectedRunId":"run-one"/);
  }
  assert.equal(workerProgress({ ...legacy, followupWait: 'Stale wait without a pending assignment' }), 'Research complete');
  assert.deepEqual(workerActions({ ...queued, lifecycleRequests: [{ status: 'processing' }] }), []);
  assert.deepEqual(workerActions({ ...queued, execution: { live: true } }), ['pause', 'stop']);
});

test('archive projections retain unfinished cleanup and history without leaking archive into counts', async () => {
  const { workspaceWorkers, archivedWorkers, workerSelectionRemoved } = await import('./worker-model.ts');
  const tasks = ['completed', 'paused', 'stopped', 'failed', 'disposed', 'removed'].map(status => worker({ id: status, projectId: 'one', status, worktree: '/retained', attention: [{ id: 'old' }] }));
  tasks.push(worker({ id: 'pending', status: 'disposed', projectId: 'one', lifecycleRequests: [{ action: 'dispose', status: 'processing' }] }));
  tasks.push(worker({ id: 'live', status: 'disposed', projectId: 'one', execution: { live: true } }));
  tasks.push(worker({ id: 'other', status: 'disposed', projectId: 'two', archivedAt: at }));
  tasks.find(t => t.id === 'disposed').archivedAt = at;
  const visible = ['completed', 'paused', 'stopped', 'failed', 'pending', 'live'];
  assert.deepEqual(workspaceWorkers(tasks).map(t => t.id), visible);
  assert.deepEqual(workspaceWorkers(JSON.parse(JSON.stringify(tasks))).map(t => t.id), visible);
  assert.deepEqual(archivedWorkers(tasks, 'one').map(t => t.id), ['disposed', 'removed']);
  assert.deepEqual(archivedWorkers(tasks, null), []);
  assert.equal(workerSelectionRemoved(tasks, 'disposed'), true);
  assert.equal(workerSelectionRemoved(tasks, 'completed'), false);
  assert.equal(workerSelectionRemoved(tasks, 'unknown'), false);
  assert.equal(groupWorkers(tasks).history.some(t => t.status === 'disposed' && t.id !== 'pending' && t.id !== 'live'), false);
  assert.deepEqual(workerActions(tasks.find(t => t.id === 'removed')), []);
  assert.equal(tasks.find(t => t.id === 'disposed').attention.length, 1, 'Historical evidence is not deleted');
});


test('archive preserves authoritative fixture-only legacy scope without exposing foreign history', async () => {
  const { archivedWorkers } = await import('./worker-model.ts');
  const legacy = { id: 'legacy', status: 'disposed' };
  const foreign = { id: 'foreign', status: 'disposed', projectId: 'other' };
  assert.deepEqual(archivedWorkers([legacy, foreign], 'current', 'fixture'), [legacy]);
  assert.deepEqual(archivedWorkers([legacy, foreign], 'current', 'repository'), []);
});

test('history-only restore is visible and offers no runnable resume or invented environment readiness', () => {
  const restored = worker({ status: 'blocked', worktree: '/removed', archiveRestoration: { requiresRecovery: true }, failure: 'Restore did not recreate the environment.' });
  assert.equal(workerStatus(restored), 'History restored');
  assert.deepEqual(workerActions(restored), ['dispose']);
  assert.equal(workerProgress(restored), 'Restore did not recreate the environment.');
  assert.deepEqual(workerActions({ ...restored, execution: { live: true } }), ['pause', 'stop']);
});


test('history-only restored workers cannot discuss follow-ups or offer retained-worktree recovery', async () => {
  const { canDiscussFollowup, workerFollowupRequest, workerRecoveryReviewRequest } = await import('./worker-model.ts');
  const restored = worker({ status: 'blocked', worktree: '/removed', archiveRestoration: { requiresRecovery: true }, assignments: [{ id: 'queued', status: 'queued' }] });
  assert.equal(canDiscussFollowup(restored), false);
  assert.throws(() => workerFollowupRequest(restored), /no retained worktree available/);
  assert.throws(() => workerRecoveryReviewRequest(restored), /not available/);
  assert.deepEqual(workerActions(restored), ['dispose']);
});

test('retained execution states can resume without a workflow, question or setup gate', () => {
 for (const status of ['completed','awaiting_answer','paused','stopped','failed','blocked']) {
  const task = worker({status,worktree:'/retained/worker',threadId:'native-thread',question:{id:'q',runId:'run-one'},environment:{kind:'project-execution',setupAttempted:true,prepared:false,hooks:[{phase:'setup',status:'failed'}]},workflowState:{value:'Awaiting review'}});
  assert.deepEqual(workerActions(task),['resume','dispose']);
  const request=workerActionRequest(task,'resume','retained-resume-action');
  assert.match(request.text,/"action":"resume"/);
  assert.doesNotMatch(request.text,/Retry_setup|rerunning.*Setup|bootstrap command/);
  assert.throws(()=>workerActionRequest(task,'retry_setup','obsolete-setup-retry'));
 }
 assert.equal(workerProgress(worker({status:'launching',progress:null})), 'Opening worker session.');
});

test('history-only restoration blocks setup retry even when failed setup and queued assignments remain in evidence', () => {
  const task = worker({ status: 'failed', archiveRestoration: { requiresRecovery: true }, assignments: [{ id: 'queued', status: 'queued' }], environment: { kind: 'project-execution', setupAttempted: true, prepared: false, hooks: [{ phase: 'setup', status: 'failed' }] } });
  assert.deepEqual(workerActions(task), ['dispose']);
  assert.match(workerProgress({ ...task, failure: 'History restored; environment recovery is unavailable.', followupWait: 'Waiting to start the next assignment.' }), /History restored/);
  assert.throws(() => workerActionRequest(task, 'retry_setup', 'restored-retry'));
  assert.deepEqual(workerActions({ ...task, execution: { live: true } }), ['pause', 'stop']);
});

test('workflow is explicit visual data and never inferred from execution, report or assignment completion', async () => {
  const { workerWorkflow } = await import('./worker-model.ts');
  for (const status of ['running', 'completed', 'paused', 'failed', 'awaiting_answer']) {
    const task = worker({ status, result: { message: 'The business workflow is done' }, assignments: [{ id: 'initial', status: 'completed' }] });
    assert.equal(workerWorkflow(task), null);
    const workflowState = { value: 'Awaiting client feedback', actor: 'worker', requestId: 'workflow-one', at };
    assert.equal(workerWorkflow({ ...task, workflowState }), 'Awaiting client feedback');
  }
  assert.equal(workerStatus(worker({ status: 'completed' })), 'Turn ended');
  assert.equal(workerWorkflow(worker({ workflowState: { value: '' } })), null);
});
