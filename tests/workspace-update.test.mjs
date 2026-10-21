import test from 'node:test';
import assert from 'node:assert/strict';
import { workspaceUpdateActivity, reserveWorkspaceUpdate } from '../desktop/workspace-update.mjs';
const reservationFixture = responses => {
  const calls = [];
  const projects = Object.entries(responses).map(([name, response]) => ({ name, host:{ async updateToken(route) {
    calls.push(`${name}:${route}`);
    const result = response[route];
    if (result instanceof Error) throw result;
    return result;
  } } }));
  const setAdmissionPaused = async paused => { calls.push(`global:${paused}`); };
  return { projects, calls, setAdmissionPaused };
};
const yes = { 'update-prepare':{ reserved:true }, 'update-cancel':{ reserved:false } };

test('activity checks every workspace including hidden active, unknown and unreachable controllers', async () => {
  const calls = [];
  const host = (name, result) => ({ api:async route => { calls.push([name, route]); if (result instanceof Error) throw result; return result; } });
  const result = await workspaceUpdateActivity([
    { name:'Selected', host:host('Selected', { safe:true, reasons:[] }) },
    { name:'Hidden active', host:host('Hidden active', { safe:false, reasons:['Worker is running.'] }) },
    { name:'Unknown', host:host('Unknown', {}) },
    { name:'Offline', host:host('Offline', Error('connection failed')) },
    { name:'Missing' },
    { name:'Last', host:host('Last', { safe:true }) }
  ]);
  assert.equal(result.safe, false);
  assert.deepEqual(result.reasons, [
    'Hidden active: Worker is running.', 'Unknown: activity could not be verified.',
    'Offline: controller activity unavailable. Open project setup and resolve it before updating.',
    'Missing: controller activity unavailable. Open project setup and resolve it before updating.'
  ]);
  assert.deepEqual(calls, ['Selected', 'Hidden active', 'Unknown', 'Offline', 'Last'].map(name => [name, 'update-activity']));
});

test('activity retains named notices from safe and blocked workspaces and rejects contradictory safe evidence', async () => {
  const result = await workspaceUpdateActivity([
    { name:'Alpha', host:{ api:async () => ({ safe:true, notices:['Retained worktree is stopped.', '', null] }) } },
    { name:'Beta', host:{ api:async () => ({ safe:false, reasons:['Runtime is active.'], notices:['Other worker stopped.'] }) } },
    { name:'Contradiction', host:{ api:async () => ({ safe:true, reasons:['Still running.'] }) } }
  ]);
  assert.deepEqual(result.notices, ['Alpha: Retained worktree is stopped.', 'Beta: Other worker stopped.']);
  assert.deepEqual(result.reasons, ['Beta: Runtime is active.', 'Contradiction: Still running.']);
  assert.equal(result.safe, false);
  const safe = await workspaceUpdateActivity([{ name:'Idle', host:{ api:async () => ({ safe:true }) } }]);
  assert.deepEqual(safe, { safe:true, reasons:[], notices:[] });
  assert.equal((await workspaceUpdateActivity([])).safe, false);
  assert.equal((await workspaceUpdateActivity(null)).safe, false);
});

test('successful reservation pauses global admission before every workspace and retains every reservation', async () => {
  const f = reservationFixture({ Alpha:yes, Hidden:yes, Last:yes });
  assert.deepEqual(await reserveWorkspaceUpdate(f.projects, f), { reserved:true });
  assert.deepEqual(f.calls, ['global:true', 'Alpha:update-prepare', 'Hidden:update-prepare', 'Last:update-prepare']);
});

test('false partial reservation stops preparation, rolls back confirmed projects only, then unpauses globally', async () => {
  const f = reservationFixture({ Alpha:yes, Beta:yes, Blocked:{ 'update-prepare':{ reserved:false, reasons:['A turn started.'] } }, Unreached:yes });
  await assert.rejects(reserveWorkspaceUpdate(f.projects, f), /Blocked: A turn started/);
  assert.deepEqual(f.calls, ['global:true', 'Alpha:update-prepare', 'Beta:update-prepare', 'Blocked:update-prepare', 'Beta:update-cancel', 'Alpha:update-cancel', 'global:false']);
});

test('missing or thrown reservation fails meaningfully and rolls back successful reservations', async () => {
  const f = reservationFixture({ Alpha:yes, Offline:{ 'update-prepare':Error('connection lost') }, Last:yes });
  await assert.rejects(reserveWorkspaceUpdate(f.projects, f), /Offline: update reservation failed \(connection lost\)/);
  assert.deepEqual(f.calls, ['global:true', 'Alpha:update-prepare', 'Offline:update-prepare', 'Alpha:update-cancel', 'global:false']);
  const missing = reservationFixture({ Alpha:yes }); missing.projects.push({ name:'Unavailable' });
  await assert.rejects(reserveWorkspaceUpdate(missing.projects, missing), /Unavailable: controller is unavailable/);
  assert.deepEqual(missing.calls, ['global:true', 'Alpha:update-prepare', 'Alpha:update-cancel', 'global:false']);
});

test('unconfirmed rollback preserves global pause, attempts remaining rollbacks and includes original blocker', async () => {
  for (const cancel of [undefined, { reserved:true }, Error('offline')]) {
    const f = reservationFixture({ Alpha:yes, Beta:{ ...yes, 'update-cancel':cancel }, Blocked:{ 'update-prepare':{ reserved:false, reasons:['Approval pending.'] } } });
    await assert.rejects(reserveWorkspaceUpdate(f.projects, f), error => {
      assert.match(error.message, /Blocked: Approval pending/);
      assert.match(error.message, /Beta: update cancellation could not be confirmed/);
      assert.match(error.message, /Global worker admission remains paused/);
      return true;
    });
    assert.deepEqual(f.calls, ['global:true', 'Alpha:update-prepare', 'Beta:update-prepare', 'Blocked:update-prepare', 'Beta:update-cancel', 'Alpha:update-cancel']);
  }
});

test('failed global barrier never prepares workspaces; failed global resume preserves the original error', async () => {
  const f = reservationFixture({ Alpha:yes });
  await assert.rejects(reserveWorkspaceUpdate(f.projects, { setAdmissionPaused:async () => { throw Error('cannot persist pause'); } }), /cannot persist pause/);
  assert.deepEqual(f.calls, []);
  const blocked = reservationFixture({ Blocked:{ 'update-prepare':{ reserved:false, reasons:['Working.'] } } });
  await assert.rejects(reserveWorkspaceUpdate(blocked.projects, { setAdmissionPaused:async paused => {
    blocked.calls.push(`global:${paused}`); if (!paused) throw Error('disk unavailable');
  } }), error => {
    assert.match(error.message, /Blocked: Working/); assert.match(error.message, /disk unavailable/);
    assert.match(error.message, /remains paused/); return true;
  });
  assert.deepEqual(blocked.calls, ['global:true', 'Blocked:update-prepare', 'global:false']);
});

test('an unconfirmed first reservation is rejected without canceling a barrier it never confirmed', async () => {
  const f = reservationFixture({ Unconfirmed:{ 'update-prepare':{ reserved:'true' } }, Last:yes });
  await assert.rejects(reserveWorkspaceUpdate(f.projects, f), /Unconfirmed: update reservation was not confirmed/);
  assert.deepEqual(f.calls, ['global:true', 'Unconfirmed:update-prepare', 'global:false']);
  await assert.rejects(reserveWorkspaceUpdate([], f), /without registered workspaces/);
  await assert.rejects(reserveWorkspaceUpdate(f.projects), /admission control is unavailable/);
});

import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkspaceUpdateReservation } from '../desktop/workspace-update.mjs';
async function journalFixture(t, responses = { Alpha:yes, Beta:yes }) {
  const dir = await mkdtemp(join(tmpdir(), 'crew-idle-update-'));
  t.after(() => rm(dir, { recursive:true, force:true }));
  const f = reservationFixture(responses);
  f.projects.forEach((project, index) => { project.id = `project-${index}`; project.host.api = async route => { f.calls.push(`${project.name}:${route}`); return { safe:true }; }; });
  const path = join(dir, 'idle-update.json');
  const options = { path, currentVersion:'1.1.0', projects:() => f.projects, setAdmissionPaused:f.setAdmissionPaused, ownerAlive:() => false };
  return { ...f, path, options, make:overrides => createWorkspaceUpdateReservation({ ...options, ...overrides }), journal:{ version:1, ownerPid:987654, targetVersion:'1.1.0', projectIds:f.projects.map(project => project.id) } };
}

test('prepare persists a private versioned journal before global pause and holds it through native restart', async t => {
  const f = await journalFixture(t);
  const coordinator = f.make({ currentVersion:'1.0.0', setAdmissionPaused:async paused => {
    assert.equal(JSON.parse(await readFile(f.path, 'utf8')).targetVersion, '1.1.0');
    f.calls.push(`global:${paused}`);
  } });
  assert.deepEqual(await coordinator.prepare('1.1.0'), { reserved:true });
  const journal = JSON.parse(await readFile(f.path, 'utf8'));
  assert.deepEqual(journal, { ...f.journal, ownerPid:process.pid });
  assert.equal((await stat(f.path)).mode & 0o777, 0o600);
  assert.deepEqual(f.calls, ['global:true', 'Alpha:update-prepare', 'Beta:update-prepare']);
  await assert.rejects(coordinator.prepare('1.2.0'), /previous idle-update reservation/);
  assert.deepEqual(JSON.parse(await readFile(f.path, 'utf8')), journal);
});

test('prepare removes only a fully rolled back journal, retaining unknown rollback and unknown global pause', async t => {
  const clean = await journalFixture(t, { Alpha:yes, Blocked:{ 'update-prepare':{ reserved:false, reasons:['Busy.'] } } });
  await assert.rejects(clean.make().prepare('1.2.0'), /Blocked: Busy/);
  await assert.rejects(readFile(clean.path), { code:'ENOENT' });
  assert.equal(clean.calls.at(-1), 'global:false');
  const uncertain = await journalFixture(t, { Alpha:{ ...yes, 'update-cancel':{ reserved:true } }, Blocked:{ 'update-prepare':{ reserved:false } } });
  await assert.rejects(uncertain.make().prepare('1.2.0'), /remains paused/);
  assert.equal(JSON.parse(await readFile(uncertain.path, 'utf8')).targetVersion, '1.2.0');
  assert.ok(!uncertain.calls.includes('global:false'));
  const pause = await journalFixture(t);
  await assert.rejects(pause.make({ setAdmissionPaused:async () => { throw Error('pause write uncertain'); } }).prepare('1.2.0'), /pause write uncertain/);
  assert.ok(await readFile(pause.path));
  assert.deepEqual(pause.calls, []);
});

test('cancel confirms every project token before releasing admission and deleting this owners journal', async t => {
  const f = await journalFixture(t), coordinator = f.make();
  await coordinator.prepare('1.2.0'); f.calls.length = 0;
  assert.deepEqual(await coordinator.cancel(), { canceled:true });
  assert.deepEqual(f.calls, ['Alpha:update-cancel', 'Beta:update-cancel', 'global:false']);
  await assert.rejects(readFile(f.path), { code:'ENOENT' });
  assert.deepEqual(await coordinator.cancel(), { canceled:false });
  assert.equal(f.calls.length, 3);
});

test('cancel checks all controllers and preserves journal and pause if any response is unconfirmed', async t => {
  const f = await journalFixture(t, { Alpha:{ ...yes, 'update-cancel':{} }, Beta:yes });
  await writeFile(f.path, JSON.stringify(f.journal));
  await assert.rejects(f.make().cancel(), /Alpha: cancellation was not confirmed/);
  assert.deepEqual(f.calls, ['Alpha:update-cancel', 'Beta:update-cancel']);
  assert.deepEqual(JSON.parse(await readFile(f.path, 'utf8')), f.journal);
});

test('same installed target and dead owner recover only after every workspace is freshly idle', async t => {
  const f = await journalFixture(t);
  await writeFile(f.path, JSON.stringify(f.journal));
  assert.deepEqual(await f.make().recover(), { recovered:true });
  assert.deepEqual(f.calls, ['global:true', 'Alpha:update-activity', 'Beta:update-activity', 'global:false']);
  await assert.rejects(readFile(f.path), { code:'ENOENT' });
  f.calls.length = 0;
  assert.deepEqual(await f.make().recover(), { recovered:false });
  assert.deepEqual(f.calls, []);
});

test('interrupted old-version update, foreign projects, live owner, malformed journal and unknown activity retain hold', async t => {
  const f = await journalFixture(t);
  const cases = [
    { bytes:JSON.stringify(f.journal), overrides:{ currentVersion:'1.0.0' }, message:/targeted 1.1.0.*app is 1.0.0/ },
    { bytes:JSON.stringify({ ...f.journal, projectIds:['foreign-project'] }), message:/different set of projects/ },
    { bytes:JSON.stringify(f.journal), overrides:{ ownerAlive:() => true }, message:/live Crew process/ },
    { bytes:'{invalid', message:/malformed/ },
    { bytes:'null', message:/malformed/ },
    { bytes:JSON.stringify({ ...f.journal, ownerPid:0 }), message:/malformed/ },
    { bytes:JSON.stringify({ ...f.journal, projectIds:['project-0', 'project-0'] }), message:/malformed/ }
  ];
  for (const item of cases) {
    f.calls.length = 0; await writeFile(f.path, item.bytes);
    const result = await f.make(item.overrides).recover();
    assert.equal(result.blocked, true); assert.equal(result.recovered, false); assert.match(result.error, item.message);
    assert.deepEqual(f.calls, ['global:true']);
    assert.equal(await readFile(f.path, 'utf8'), item.bytes);
  }
  await writeFile(f.path, JSON.stringify(f.journal)); f.calls.length = 0;
  f.projects[1].host.api = async route => { f.calls.push(`Beta:${route}`); return { safe:false, reasons:['Worker ownership unknown.'] }; };
  const result = await f.make().recover();
  assert.equal(result.blocked, true); assert.match(result.error, /Beta: Worker ownership unknown/);
  assert.deepEqual(f.calls, ['global:true', 'Alpha:update-activity', 'Beta:update-activity']);
  assert.ok(await readFile(f.path));
});

test('foreign live owner prevents cancel; current owner may cancel without a false liveness block', async t => {
  const f = await journalFixture(t);
  await writeFile(f.path, JSON.stringify(f.journal));
  await assert.rejects(f.make({ ownerAlive:() => true }).cancel(), /Another live Crew process/);
  assert.deepEqual(f.calls, []);
  await writeFile(f.path, JSON.stringify({ ...f.journal, ownerPid:process.pid }));
  await f.make({ ownerAlive:() => true }).cancel();
  assert.deepEqual(f.calls, ['Alpha:update-cancel', 'Beta:update-cancel', 'global:false']);
});

test('journal operations queue and a pending prepare cannot be overwritten by concurrent callbacks', async t => {
  const f = await journalFixture(t), coordinator = f.make();
  const results = await Promise.allSettled([coordinator.prepare('1.2.0'), coordinator.prepare('1.3.0'), coordinator.cancel()]);
  assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].status, 'rejected'); assert.equal(results[2].status, 'fulfilled');
  assert.deepEqual(f.calls, ['global:true', 'Alpha:update-prepare', 'Beta:update-prepare', 'Alpha:update-cancel', 'Beta:update-cancel', 'global:false']);
  await assert.rejects(readFile(f.path), { code:'ENOENT' });
});
