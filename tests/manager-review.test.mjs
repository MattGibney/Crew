import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ManagerReview, managerReviewContext } from '../runtime/manager/reviews/scheduler.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => resolve = done); return { promise, resolve }; };
async function fixture(t, overrides = {}) {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crew-review-'));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  const state = {
    at: 0, calls: [],
    snapshot: { enabled: true, idle: true, voiceConnected: false, held: false,
      scratchpad: { commitments: [{ id: 'commitment-1', status: 'pending', title: 'Review delegated change', nextAction: 'Check result', references: { taskId: 'worker-task-1', runId: 'run-1' } }] },
      tasks: [{ id: 'worker-task-1', runId: 'run-1', status: 'running', reports: [] }] },
  };
  const options = { stateDir, now: () => state.at, intervalMs: 100,
    getSnapshot: async () => structuredClone(state.snapshot),
    runReview: async context => { state.calls.push(context); return { accepted: true }; }, ...overrides };
  const review = new ManagerReview(options);
  t.after(() => review.stop());
  return { state, review, options };
}

test('waits ten-minute interval, reviews explicit work once and preserves checkpoint across restart', async t => {
  const { state, review, options } = await fixture(t);
  assert.equal((await review.tick()).reason, 'interval');
  state.at = 100;
  assert.equal((await review.tick()).reviewed, true);
  state.at = 200;
  assert.equal((await review.tick()).reason, 'unchanged');
  const restarted = new ManagerReview(options);
  t.after(() => restarted.stop());
  state.at = 300;
  assert.equal((await restarted.tick()).reason, 'unchanged');
  assert.equal(state.calls.length, 1);
});

test('stopped, busy, held or connected managers remain untouched', async t => {
  const { state, review } = await fixture(t);
  for (const patch of [{ enabled: false }, { idle: false }, { held: true }, { voiceConnected: true }]) {
    const previous = state.snapshot;
    state.snapshot = { ...previous, ...patch }; state.at += 100;
    assert.equal((await review.tick()).reason, 'ineligible');
    state.snapshot = previous;
  }
  assert.deepEqual(state.calls, []);
});

test('notes, decisions, questions and completed commitments do not start unrelated work', async t => {
  const { state, review } = await fixture(t);
  state.snapshot.scratchpad = { notes: ['Explore a feature'], questions: ['Should we build it?'], decisions: ['Later'], commitments: [] };
  state.at = 100; assert.equal((await review.tick()).reason, 'empty');
  state.snapshot.scratchpad.commitments = [{ id: 'done', status: 'completed' }];
  state.at = 200; assert.equal((await review.tick()).reason, 'empty');
  assert.equal(state.calls.length, 0);
});

test('associated worker evidence changes trigger review; unrelated workers do not', async t => {
  const { state, review } = await fixture(t);
  state.at = 100; await review.tick();
  state.snapshot.tasks.push({ id: 'unrelated', runId: 'another', status: 'completed', reports: [{ kind: 'result', message: 'Other work' }] });
  state.at = 200; assert.equal((await review.tick()).reason, 'unchanged');
  state.snapshot.tasks[0].status = 'completed';
  state.snapshot.tasks[0].reports.push({ reportId: 'result-1', runId: 'run-1', kind: 'result', message: 'Tests passed' });
  state.at = 300; assert.equal((await review.tick()).reviewed, true);
  state.at = 400; assert.equal((await review.tick()).reason, 'unchanged');
  assert.equal(state.calls.length, 2);
});

test('nextReviewAt crossing is meaningful even when saved work is unchanged', async t => {
  const { state, review } = await fixture(t);
  state.snapshot.scratchpad.commitments[0].nextReviewAt = new Date(250).toISOString();
  state.at = 100; assert.equal((await review.tick()).reason, 'empty');
  state.at = 200; assert.equal((await review.tick()).reason, 'empty');
  assert.equal(state.calls.length, 0);
  state.at = 300; assert.equal((await review.tick()).reviewed, true);
  state.at = 400; assert.equal((await review.tick()).reason, 'unchanged');
});

test('overlapping ticks and stop during checkpoint admission cannot start a turn', async t => {
  const barrier = deferred();
  let reads = 0;
  const { state, review } = await fixture(t, { getSnapshot: async () => {
    reads++;
    if (reads === 1) { await barrier.promise; }
    return structuredClone(state.snapshot);
  } });
  state.at = 100;
  const tick = review.tick();
  assert.equal((await review.tick()).reason, 'busy');
  state.snapshot.enabled = false;
  barrier.resolve();
  assert.equal((await tick).reason, 'ineligible');
  assert.equal(state.calls.length, 0);
});

test('fresh post-checkpoint snapshot prevents a stopped manager or new conversation turn', async t => {
  const { state, review } = await fixture(t);
  let reads = 0;
  review.getSnapshot = async () => {
    reads++;
    return { ...structuredClone(state.snapshot), ...(reads > 1 ? { idle: false } : {}) };
  };
  state.at = 100;
  assert.equal((await review.tick()).reason, 'changed');
  assert.equal(state.calls.length, 0);
  review.getSnapshot = async () => structuredClone(state.snapshot);
  state.at = 200;
  assert.equal((await review.tick()).reviewed, true);
});

test('definite admission rejection retries after interval; uncertain delivery never replays', async t => {
  const { state, review, options } = await fixture(t);
  review.runReview = async () => ({ accepted: false });
  state.at = 100; assert.equal((await review.tick()).reason, 'rejected');
  state.at = 150; assert.equal((await review.tick()).reason, 'interval');
  review.runReview = async () => { throw new Error('Connection lost after send'); };
  state.at = 200; await assert.rejects(review.tick(), /Connection lost/);
  const restarted = new ManagerReview(options);
  state.at = 300;
  assert.equal((await restarted.tick()).reason, 'unchanged');
  assert.equal(state.calls.length, 0);
});

test('projects have independent checkpoints and corrupt checkpoint fails closed', async t => {
  const first = await fixture(t), second = await fixture(t);
  first.state.at = 100; await first.review.tick();
  second.state.at = 100; assert.equal((await second.review.tick()).reviewed, true);
  await fs.writeFile(first.review.file, '{}');
  const restarted = new ManagerReview(first.options);
  first.state.at = 200;
  await assert.rejects(restarted.tick(), /Invalid manager review checkpoint/);
});

test('stable ordering does not create another review', () => {
  const snapshot = { scratchpad: { commitments: [{ id: 'b', status: 'pending' }, { id: 'a', status: 'pending' }] } };
  const before = managerReviewContext(snapshot, 100).fingerprint;
  snapshot.scratchpad.commitments.reverse();
  assert.equal(managerReviewContext(snapshot, 100).fingerprint, before);
});

 test('different worker run and old reports are excluded from current evidence', () => {
  const snapshot = { scratchpad: { commitments: [{ id: 'a', status: 'delegated', references: { taskId: 'task-a', runId: 'run-1' } }] }, tasks: [{ id: 'task-a', runId: 'run-2', status: 'completed' }] };
  assert.deepEqual(managerReviewContext(snapshot, 0).tasks, []);
  snapshot.tasks[0] = { id: 'task-a', runId: 'run-1', status: 'running', reports: [{ runId: 'old-run', message: 'Old result' }] };
  assert.deepEqual(managerReviewContext(snapshot, 0).tasks[0].reports, []);
 });


test('stop cancels an already waiting snapshot and start cannot revive that old tick', async t => {
  const barrier = deferred();
  const { state, review } = await fixture(t);
  review.getSnapshot = async () => { await barrier.promise; return structuredClone(state.snapshot); };
  state.at = 100;
  const pending = review.tick();
  await new Promise(resolve => setImmediate(resolve));
  review.stop(); review.start(); barrier.resolve();
  assert.equal((await pending).reason, 'stopped');
  assert.equal(state.calls.length, 0);
  state.at = 200;
  assert.equal((await review.tick()).reviewed, true);
  review.stop(); state.at = 300;
  assert.equal((await review.tick()).reason, 'stopped');
});

test('stop during post-checkpoint snapshot prevents invoking native admission and permits explicit restart', async t => {
  const barrier = deferred();
  const { state, review } = await fixture(t);
  let reads = 0;
  review.getSnapshot = async () => { if (++reads === 2) await barrier.promise; return structuredClone(state.snapshot); };
  state.at = 100;
  const pending = review.tick();
  while (reads < 2) await new Promise(resolve => setImmediate(resolve));
  review.stop(); barrier.resolve();
  assert.equal((await pending).reason, 'stopped');
  assert.equal(state.calls.length, 0);
  review.start(); state.at = 200;
  assert.equal((await review.tick()).reviewed, true);
});


test('controller attention correlates by its existing run-prefixed identity', () => {
  const snapshot = { scratchpad: { commitments: [{ id: 'a', status: 'delegated', references: { taskId: 'task-a', runId: 'run-1' } }] }, tasks: [{ id: 'task-a', runId: 'run-1', status: 'completed', attention: [{ id: 'run-1:completion', kind: 'completion' }, { id: 'old-run:completion', kind: 'completion' }] }] };
  assert.deepEqual(managerReviewContext(snapshot, 0).tasks[0].attention, [{ id: 'run-1:completion', kind: 'completion' }]);
});


test('new matching worker evidence warrants one review before a scheduled future check', async t => {
  const { state, review } = await fixture(t);
  state.snapshot.scratchpad.commitments[0].nextReviewAt = new Date(1000).toISOString();
  state.at = 100; assert.equal((await review.tick()).reason, 'empty');
  state.snapshot.tasks[0].reports = [{ reportId: 'report-1', runId: 'run-1', kind: 'question', message: 'Choose an account' }];
  state.at = 200; assert.equal((await review.tick()).reviewed, true);
  assert.equal(state.calls[0].commitments[0].reviewDue, false);
  state.at = 300; assert.equal((await review.tick()).reason, 'unchanged');
  assert.equal(state.calls.length, 1);
});

test('unrelated or old-run evidence cannot bring a future-only check forward', async t => {
  const { state, review } = await fixture(t);
  state.snapshot.scratchpad.commitments[0].nextReviewAt = new Date(1000).toISOString();
  state.snapshot.tasks[0].reports = [{ reportId: 'old', runId: 'old-run', kind: 'result', message: 'Old result' }];
  state.snapshot.tasks.push({ id: 'unrelated', runId: 'run-1', result: { message: 'Other result' } });
  state.at = 100; assert.equal((await review.tick()).reason, 'empty');
  state.snapshot.tasks[0].runId = 'old-run';
  state.snapshot.tasks[0].result = { message: 'Old result' };
  state.at = 200; assert.equal((await review.tick()).reason, 'empty');
  assert.equal(state.calls.length, 0);
});

test('due commitments do not pull future commitments and their workers into review context', () => {
  const snapshot = { scratchpad: { commitments: [
    { id: 'now', status: 'pending' },
    { id: 'later', status: 'delegated', nextReviewAt: new Date(1000).toISOString(), references: { taskId: 'worker', runId: 'run' } },
  ] }, tasks: [{ id: 'worker', runId: 'run', status: 'running', reports: [] }] };
  const context = managerReviewContext(snapshot, 100);
  assert.deepEqual(context.commitments.map(item => item.id), ['now']);
  assert.deepEqual(context.tasks, []);
});
