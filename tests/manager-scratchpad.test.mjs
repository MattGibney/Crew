import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ManagerScratchpad } from '../manager-scratchpad.mjs';

async function fixture(t, options = {}) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'crew-scratchpad-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  return { stateDir, pad: new ManagerScratchpad({ stateDir, ...options }) };
}
const commitment = (id, extra = {}) => ({ id, title: `Explicit request ${id}`, status: 'pending', ...extra });

test('scratchpad retains four distinct commitments, notes and actual delegation references across restart', async t => {
  const changes = [];
  const { pad, stateDir } = await fixture(t, { now: () => '2026-10-21T10:00:00.000Z', onChange: state => changes.push(state) });
  assert.deepEqual(await pad.snapshot(), { schemaVersion: 1, revision: 0, updatedAt: null, commitments: [], notes: [], decisions: [], questions: [] });
  const first = await pad.update({ expectedRevision: 0, commitments: ['one', 'two', 'three', 'four'].map(id => commitment(id)), notes: ['Customer prefers a brief update.'], decisions: ['Use the existing project.'], questions: ['Which deployment window?'] });
  assert.equal(first.commitments.length, 4);
  const delegated = first.commitments.map(item => item.id === 'two' ? { ...item, status: 'delegated', nextAction: 'Review the worker result.', nextReviewAt: '2026-10-21T10:10:00Z', references: { taskId: 'task_123', runId: 'run_123', ticketUrl: 'https://github.com/example/repo/issues/26' } } : item);
  const second = await pad.update({ expectedRevision: 1, commitments: delegated });
  assert.equal(second.commitments[1].status, 'delegated');
  assert.equal(second.commitments[1].nextReviewAt, '2026-10-21T10:10:00.000Z');
  assert.deepEqual(second.notes, first.notes);
  assert.equal(second.updatedAt, '2026-10-21T10:00:00.000Z');
  assert.deepEqual(await new ManagerScratchpad({ stateDir }).snapshot(), second);
  assert.equal(changes.length, 2);
  changes[1].notes.push('Observer mutation');
  second.commitments[0].title = 'Caller mutation';
  assert.equal((await pad.snapshot()).commitments[0].title, 'Explicit request one');
  assert.deepEqual((await pad.snapshot()).notes, first.notes);
  assert.equal((await stat(pad.file)).mode & 0o777, 0o600);
});

test('meaningful changes only, stale revisions fail and partial updates preserve sections', async t => {
  let notified = 0;
  const { pad } = await fixture(t, { onChange: () => { notified++; } });
  const first = await pad.update({ expectedRevision: 0, commitments: [commitment('first')] });
  const before = await readFile(pad.file, 'utf8');
  assert.deepEqual(await pad.update({ expectedRevision: 1, commitments: first.commitments }), first);
  assert.equal(await readFile(pad.file, 'utf8'), before);
  assert.equal(notified, 1);
  await assert.rejects(pad.update({ expectedRevision: 0, notes: ['Stale note'] }), /changed/);
  const done = await pad.update({ expectedRevision: 1, commitments: [commitment('first', { status: 'completed', outcome: 'Reviewed passing evidence.', nextAction: 'Tell the user.' })], notes: ['Corrected fact'] });
  assert.equal(done.revision, 2);
  assert.equal(done.commitments[0].outcome, 'Reviewed passing evidence.');
  assert.deepEqual((await pad.update({ expectedRevision: 2, notes: [] })).notes, []);
});

test('concurrent instances cannot overwrite a commitment update at the same revision', async t => {
  const { pad, stateDir } = await fixture(t);
  const other = new ManagerScratchpad({ stateDir });
  const results = await Promise.allSettled([pad.update({ expectedRevision: 0, commitments: [commitment('first')] }), other.update({ expectedRevision: 0, commitments: [commitment('second')] })]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.match(results.find(result => result.status === 'rejected').reason.message, /changed/);
  assert.equal((await pad.snapshot()).revision, 1);
  assert.deepEqual((await readdir(stateDir)).filter(name => name.includes('.tmp') || name.includes('lock')), []);
});

test('project state directories isolate notes and corrupt saved evidence is never replaced', async t => {
  const { pad, stateDir } = await fixture(t);
  const { pad: other } = await fixture(t);
  await pad.update({ expectedRevision: 0, notes: ['Project A'] });
  assert.deepEqual((await other.snapshot()).notes, []);
  for (const raw of ['{broken', JSON.stringify({ schemaVersion: 2 }), JSON.stringify({ schemaVersion: 1, revision: 1, updatedAt: 'yesterday', commitments: [], notes: [], decisions: [], questions: [] })]) {
    await writeFile(pad.file, raw);
    await assert.rejects(pad.snapshot(), /Malformed/);
    await assert.rejects(new ManagerScratchpad({ stateDir }).update({ expectedRevision: 1, notes: ['Replacement'] }), /Malformed/);
    assert.equal(await readFile(pad.file, 'utf8'), raw);
  }
});

test('invalid, oversized or ambiguous updates leave existing notes unchanged', async t => {
  const { pad } = await fixture(t);
  await pad.update({ expectedRevision: 0, notes: ['Keep this'] });
  const invalid = [
    { expectedRevision: 1, hiddenReasoning: 'No' },
    { notes: [] },
    { expectedRevision: 1, notes: [''] },
    { expectedRevision: 1, decisions: new Array(201).fill('A') },
    { expectedRevision: 1, questions: ['x'.repeat(4001)] },
    { expectedRevision: 1, commitments: [commitment('a'), commitment('a')] },
    { expectedRevision: 1, commitments: [commitment('a', { status: 'running' })] },
    { expectedRevision: 1, commitments: [commitment('a', { nextReviewAt: 'tomorrow' })] },
    { expectedRevision: 1, commitments: [commitment('a', { references: { ticketUrl: 'javascript:alert(1)' } })] },
    { expectedRevision: 1, notes: new Array(100).fill('x'.repeat(4000)) },
  ];
  for (const input of invalid) await assert.rejects(pad.update(input));
  assert.equal((await pad.snapshot()).revision, 1);
  assert.deepEqual((await pad.snapshot()).notes, ['Keep this']);
});

test('notification failure does not misreport committed storage as failed', async t => {
  const { pad } = await fixture(t, { onChange: () => { throw Error('Listener failed'); } });
  assert.equal((await pad.update({ expectedRevision: 0, questions: ['Need a decision'] })).revision, 1);
  assert.deepEqual((await pad.snapshot()).questions, ['Need a decision']);
});
