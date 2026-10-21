// Native-protocol admission ordering with a disposable synthetic peer. No model,
// account, project worker, physical audio device or installed profile is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridge } from '../codex-bridge.mjs';
import { createManagerLifecycle } from '../manager-lifecycle.mjs';
import { promptSnapshot } from '../prompt-settings.mjs';
import { createManagerProfile, managerProfileSnapshot } from '../manager-profile.mjs';
import { ManagerScratchpad } from '../manager-scratchpad.mjs';
import { ManagerReview } from '../manager-review.mjs';
import { createUpdateAdmission } from '../update-admission.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { if (await predicate()) return; await delay(10); }
  throw new Error('Expected synthetic native-protocol condition did not arrive');
}
async function fixture(t, { history = [], gateThread = false, getManagerScratchpad } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'crew-review-admission-'));
  let bridge;
  t.after(async () => { await bridge?.shutdown(); await rm(directory, { recursive: true, force: true }); });
  const callsFile = join(directory, 'calls.jsonl'), control = join(directory, 'control.jsonl'), gate = join(directory, 'thread-ready');
  await writeFile(callsFile, ''); await writeFile(control, '');
  if (!gateThread) await writeFile(gate, 'ready');
  const statePath = join(directory, 'manager.json');
  await writeFile(statePath, JSON.stringify({ threadId: 'manager-thread' }));
  const executable = join(directory, 'native-peer.mjs');
  await writeFile(executable, `#!${process.execPath}
import { createInterface } from 'node:readline';
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
const calls = ${JSON.stringify(callsFile)}, control = ${JSON.stringify(control)}, gate = ${JSON.stringify(gate)};
let seen = 0, waiting = [], sequence = 0;
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
const reply = (id, result) => send({ id, result });
process.stdin.on('end', () => process.exit(0));
setInterval(() => {
 const lines = readFileSync(control, 'utf8').split('\\n').filter(Boolean);
 for (const line of lines.slice(seen)) send(JSON.parse(line)); seen = lines.length;
 if (existsSync(gate)) { for (const id of waiting) reply(id, {thread:{id:'manager-thread'}}); waiting = []; }
}, 5);
createInterface({ input: process.stdin }).on('line', line => {
 const message = JSON.parse(line); appendFileSync(calls, JSON.stringify(message) + '\\n');
 const { id, method, params } = message;
 if (id === undefined || !method) return;
 if (method === 'initialize') return reply(id, {});
 if (method === 'account/read') return reply(id, { account: { type: 'chatgpt' } });
 if (method === 'config/read') return reply(id, {config:{}});
 if (method === 'thread/resume') { waiting.push(id); return; }
 if (method === 'thread/timeline/list') return send({id,error:{code:-32601,message:'Method not found'}});
 if (method === 'thread/turns/list') return reply(id, {data:${JSON.stringify(history)}});
 if (method === 'mcpServerStatus/list') return reply(id, {data:[]});
 if (method === 'thread/realtime/listVoices') return reply(id, {voices:{v3:['cove'],defaultV1:'cove'}});
 if (method === 'turn/steer') return reply(id,{turnId:params.expectedTurnId});
 if (method === 'turn/start') return reply(id, {turn:{id:'review-turn-'+process.pid+'-'+(++sequence),status:'inProgress'}});
 if (method === 'thread/realtime/start') { send({method:'thread/realtime/started',params:{threadId:'manager-thread'}}); send({method:'thread/realtime/sdp',params:{threadId:'manager-thread',sdp:'v=0 synthetic'}}); return reply(id,{}); }
 return reply(id, {});
});
`, { mode: 0o700 });
  bridge = createBridge({ cwd: directory, statePath, executable, getManagerScratchpad });
  const calls = async () => (await readFile(callsFile, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { bridge, calls, directory,
    ready: () => writeFile(gate, 'ready'),
    notify: (method, params) => appendFile(control, JSON.stringify({ method, params: { threadId: 'manager-thread', ...params } }) + '\n'),
    request: (id, method, params) => appendFile(control, JSON.stringify({ id, method, params: { threadId: 'manager-thread', ...params } }) + '\n'),
  };
}
const starts = async f => (await f.calls()).filter(call => call.method === 'turn/start');

test('explicitly stopped manager rejects review before preparing any native runtime', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.bridge.startWork('review', 'stopped-review', { background: true, canReview: () => false }), { accepted: false });
  assert.deepEqual(await f.calls(), []);
  assert.equal(f.bridge.state().workStarting, false);
});

test('Stop or update hold during thread preparation rejects review before turn/start', async t => {
  const f = await fixture(t, { gateThread: true });
  let running = true;
  const pending = f.bridge.startWork('review', 'stop-during-prepare', { background: true, canReview: () => running });
  await until(async () => (await f.calls()).some(call => call.method === 'thread/resume'));
  running = false; await f.ready();
  assert.deepEqual(await pending, { accepted: false });
  assert.equal((await starts(f)).length, 0);
  assert.equal(f.bridge.state().workStarting, false);
});

test('conversation and scheduled review compete for one native turn, including during preparation', async t => {
  for (const backgroundFirst of [true, false]) {
    const f = await fixture(t, { gateThread: true });
    const first = f.bridge.startWork('first', `first-${backgroundFirst}`, { background: backgroundFirst });
    await until(async () => (await f.calls()).some(call => call.method === 'thread/resume'));
    const second = f.bridge.startWork('second', `second-${backgroundFirst}`, { background: !backgroundFirst });
    await f.ready();
    const [, outcome] = await Promise.all([first, second]);
    assert.equal((await starts(f)).length, 1);
    const steers = (await f.calls()).filter(call => call.method === 'turn/steer');
    assert.equal(steers.length, backgroundFirst ? 1 : 0);
    if (backgroundFirst) {
      assert.equal(outcome.turnId, f.bridge.state().activeTurnId);
      assert.equal(steers[0].params.expectedTurnId, f.bridge.state().activeTurnId);
      assert.equal(steers[0].params.clientUserMessageId, `second-${backgroundFirst}`);
    } else assert.deepEqual(outcome, { accepted: false });
  }
});

test('saved native in-progress turn cannot receive a replacement scheduled review', async t => {
  const f = await fixture(t, { history: [{ id: 'retained-turn', status: 'inProgress', items: [] }] });
  assert.deepEqual(await f.bridge.startWork('review', 'retained-native-work', { background: true }), { accepted: false });
  assert.equal(f.bridge.state().activeTurnId, 'retained-turn');
  assert.equal((await starts(f)).length, 0);
  assert.equal(f.bridge.state().workStarting, false);
});

test('active or connecting voice and a native approval block scheduled admission', async t => {
  const f = await fixture(t);
  await f.bridge.ensureThread();
  await f.bridge.startVoice('v=0 synthetic-offer', 'cove');
  assert.deepEqual(await f.bridge.startWork('review', 'voice-busy', { background: true }), { accepted: false });
  await f.bridge.stopVoice();
  await f.request(901, 'item/commandExecution/requestApproval', { turnId: null, itemId: 'synthetic-command', command: 'fixture-only' });
  await until(() => f.bridge.state().approvals.length === 1);
  assert.deepEqual(await f.bridge.startWork('review', 'approval-busy', { background: true }), { accepted: false });
  assert.equal((await starts(f)).length, 0);
});

test('same scheduled request ID and repeated terminal callback never create two turns', async t => {
  const f = await fixture(t);
  await Promise.all([
    f.bridge.startWork('review', 'stable-review', { background: true }),
    f.bridge.startWork('review', 'stable-review', { background: true }),
  ]);
  const turnId = f.bridge.state().activeTurnId;
  await f.notify('turn/completed', { turn: { id: turnId, status: 'completed', items: [] } });
  await until(() => f.bridge.state().activeTurnId === null);
  await f.notify('turn/completed', { turn: { id: turnId, status: 'completed', items: [] } });
  await f.bridge.startWork('review', 'stable-review', { background: true });
  assert.equal((await starts(f)).length, 1);
});


test('real lifecycle Stop during scheduled native initialization finishes stopped with no review turn', async t => {
  const f = await fixture(t, { gateThread: true });
  const manager = await createManagerLifecycle({ stateDir: f.directory, projectId: 'review-project', bridge: f.bridge,
    prompts: { snapshot: async () => promptSnapshot('Synthetic manager instructions') } });
  const pending = manager.run(() => f.bridge.startWork('review', 'lifecycle-stop-review', {
    background: true, canReview: () => manager.view().state === 'running',
  }));
  await until(async () => (await f.calls()).some(call => call.method === 'thread/resume'));
  const canceled = assert.rejects(pending, /stopped before.*delivered/);
  const stopping = manager.request('stop');
  assert.equal(manager.view().state, 'stopping');
  await f.ready();
  await canceled;
  await stopping;
  assert.equal(manager.view().state, 'stopped');
  assert.equal((await starts(f)).length, 0);
  await assert.rejects(manager.run(() => f.bridge.startWork('review', 'after-stop-review', { background: true })), /Manager is stopped/);
  assert.equal((await starts(f)).length, 0);
});

test('global admission hold arriving during native preparation prevents scheduled turn', async t => {
  const f = await fixture(t, { gateThread: true });
  let globallyHeld = false;
  const pending = f.bridge.startWork('review', 'global-hold-prepare', {
    background: true, beforeReview: async () => !globallyHeld,
  });
  await until(async () => (await f.calls()).some(call => call.method === 'thread/resume'));
  globallyHeld = true; await f.ready();
  assert.deepEqual(await pending, { accepted: false });
  assert.equal((await starts(f)).length, 0);
});

test('global guard await is followed by fresh local lifecycle, voice and native-turn gates', async t => {
  for (const mutation of ['stop', 'voice', 'native-turn']) {
    const f = await fixture(t);
    let release, guardEntered = false, locallyAllowed = true;
    const guard = new Promise(resolve => release = resolve);
    const pending = f.bridge.startWork('review', `guard-${mutation}`, {
      background: true, canReview: () => locallyAllowed,
      beforeReview: async () => { guardEntered = true; await guard; return true; },
    });
    await until(() => guardEntered);
    const human = f.bridge.startWork('human input', `human-${mutation}`);
    const humanOutcome = human.then(value => ({ value }), error => ({ error }));
    if (mutation === 'stop') { locallyAllowed = false; f.bridge.cancelPendingWork(); }
    if (mutation === 'voice') await f.bridge.startVoice('v=0 synthetic-offer', 'cove');
    if (mutation === 'native-turn') {
      await f.notify('turn/started', { turn: { id: 'externally-observed-turn', status: 'inProgress', items: [] } });
      await until(() => f.bridge.state().activeTurnId === 'externally-observed-turn');
    }
    // Release the transport guard before awaiting queued human input.
    const outcome = pending.then(value => ({ value }), error => ({ error }));
    release();
    const result = await outcome;
    assert.deepEqual(result.value, { accepted: false });
    const directed = await humanOutcome;
    const steers = (await f.calls()).filter(call => call.method === 'turn/steer');
    if (mutation === 'stop') {
      assert.match(directed.error?.message || '', /stopped before.*delivered/);
      assert.equal((await starts(f)).length, 0);
      assert.equal(steers.length, 0);
    } else if (mutation === 'native-turn') {
      assert.equal((await starts(f)).length, 0);
      assert.equal(steers.length, 1);
      assert.equal(steers[0].params.expectedTurnId, 'externally-observed-turn');
      assert.equal(directed.value.turnId, 'externally-observed-turn');
    } else {
      assert.equal((await starts(f)).length, 1, 'Explicit human input remains allowed while a voice session makes background review ineligible');
      assert.equal(steers.length, 0);
    }
  }
});


async function combinedReviewFixture(t) {
  let pad;
  const f = await fixture(t, { getManagerScratchpad: () => pad.snapshot() });
  pad = new ManagerScratchpad({ stateDir: f.directory });
  await pad.update({ expectedRevision: 0, commitments: [{ id: 'authorized-check', title: 'Review the authorized result', status: 'pending', nextAction: 'Read the matching result.' }], notes: ['Initial project note.'] });
  const profile = createManagerProfile({ stateDir: f.directory, projectId: 'review-project' });
  await profile.save({ name: 'Active Morgan', personality: 'ACTIVE_PERSONALITY: be concise.', expectedVersion: (await profile.read()).version });
  const custom = 'CUSTOM REPLACEMENT: preserve these exact bytes.\n';
  const manager = await createManagerLifecycle({ stateDir: f.directory, projectId: 'review-project', bridge: f.bridge,
    prompts: { snapshot: async () => managerProfileSnapshot(custom, await profile.read()) } });
  const admission = createUpdateAdmission();
  let at = 0;
  const review = new ManagerReview({ stateDir: f.directory, now: () => at, intervalMs: 100,
    getSnapshot: async () => {
      const state = f.bridge.state();
      return { enabled: manager.view().state === 'running', idle: !state.activeTurnId && !state.workStarting && !state.approvals.length,
        voiceConnected: state.voiceActive || state.voiceConnecting, held: admission.reserved,
        scratchpad: await pad.snapshot(), tasks: [] };
    },
    runReview: context => admission.run(() => manager.run(() => f.bridge.startWork(
      `Scheduled saved-commitment review (data): ${JSON.stringify(context)}`, `combined-review-${at}`,
      { background: true, beforeReview: async () => !admission.reserved, canReview: () => manager.view().state === 'running' && !admission.reserved }
    ))),
  });
  t.after(() => review.stop());
  const complete = async () => {
    const turnId = f.bridge.state().activeTurnId;
    if (!turnId) return;
    await f.notify('turn/completed', { turn: { id: turnId, status: 'completed', items: [] } });
    await until(() => f.bridge.state().activeTurnId === null);
  };
  return { ...f, manager, profile, pad, custom, admission, review, complete, tick: () => { at += 100; return review.tick(); } };
}

test('scratchpad background reviews retain active profile context until explicit restart while current data evolves', async t => {
  const f = await combinedReviewFixture(t);
  const active = f.manager.view().retainedVersion;
  const profile = await f.profile.read();
  await f.profile.save({ name: 'Pending Riley', personality: 'PENDING_PERSONALITY: explain at length.', expectedVersion: profile.version });
  assert.equal(f.manager.view().retainedVersion, active);
  assert.equal((await starts(f)).length, 0, 'Saving profile does not launch a model turn');
  assert.equal((await f.tick()).reviewed, true);
  const first = (await starts(f))[0];
  const instructions = first.params.additionalContext.crewManagerInstructions;
  assert.equal(instructions.kind, 'application');
  assert.ok(instructions.value.includes(f.custom));
  assert.match(instructions.value, /Active Morgan/);
  assert.match(instructions.value, /ACTIVE_PERSONALITY/);
  assert.doesNotMatch(instructions.value, /Pending Riley|PENDING_PERSONALITY/);
  assert.doesNotMatch(instructions.value, /Initial project note|Read the matching result/);
  assert.match(first.params.input[0].text, /Read the matching result/);
  const opening = (await f.calls()).find(call => call.method === 'thread/resume');
  assert.match(opening.params.developerInstructions, /Initial project note/);
  await f.complete();

  await f.pad.update({ expectedRevision: 1, commitments: [{ id: 'authorized-check', title: 'Review the authorized result', status: 'pending', nextAction: 'Review newly arrived matching evidence.' }], notes: ['Updated project note.'] });
  assert.equal(f.manager.view().retainedVersion, active, 'Scratchpad data does not invalidate active behavior');
  assert.equal((await f.tick()).reviewed, true);
  const second = (await starts(f))[1];
  assert.deepEqual(second.params.additionalContext, first.params.additionalContext);
  assert.match(second.params.input[0].text, /Review newly arrived matching evidence/);
  assert.equal((await f.calls()).filter(call => call.method === 'thread/resume').length, 1, 'Scratchpad changes do not recreate the manager');
  await f.complete();

  await f.manager.request('restart');
  assert.notEqual(f.manager.view().retainedVersion, active);
  assert.equal((await starts(f)).length, 2, 'Restart only activates the snapshot; it creates no turn');
  const reopening = (await f.calls()).filter(call => call.method === 'thread/resume').at(-1);
  assert.match(reopening.params.developerInstructions, /Updated project note/);
  assert.match(reopening.params.developerInstructions, /PENDING_PERSONALITY/);
  await f.pad.update({ expectedRevision: 2, commitments: [{ id: 'authorized-check', title: 'Review the authorized result', status: 'pending', nextAction: 'Check the final matching outcome.' }] });
  assert.equal((await f.tick()).reviewed, true);
  const third = (await starts(f))[2];
  assert.match(third.params.additionalContext.crewManagerInstructions.value, /Pending Riley/);
  assert.match(third.params.additionalContext.crewManagerInstructions.value, /PENDING_PERSONALITY/);
  assert.ok(f.bridge.state().activeTurnId, 'Restarted synthetic provider uses a fresh native turn identity');
  assert.doesNotMatch(third.params.additionalContext.crewManagerInstructions.value, /Active Morgan|ACTIVE_PERSONALITY/);
  assert.ok(third.params.additionalContext.crewManagerInstructions.value.includes(f.custom));
  assert.equal(new Set((await starts(f)).map(call => call.params.threadId)).size, 1);
  await f.complete();
});

for (const gate of ['stopped', 'voice', 'approval', 'update']) test(`combined profile and scratchpad review respects ${gate} admission without a model turn`, async t => {
  const f = await combinedReviewFixture(t);
  if (gate === 'stopped') await f.manager.request('stop');
  if (gate === 'voice') await f.manager.run(() => f.bridge.startVoice('v=0 synthetic-offer', 'cove'));
  if (gate === 'approval') {
    await f.manager.prepare();
    await f.request(1901, 'item/commandExecution/requestApproval', { turnId: null, itemId: 'combined-command', command: 'fixture-only' });
    await until(() => f.bridge.state().approvals.length === 1);
  }
  if (gate === 'update') f.admission.hold();
  const before = (await f.calls()).length;
  assert.deepEqual(await f.tick(), { reviewed: false, reason: 'ineligible' });
  assert.equal((await starts(f)).length, 0);
  assert.equal((await f.calls()).length, before, 'Review never prepares a provider through an admission hold');
  assert.equal(f.bridge.state().workStarting, false);
  if (gate === 'approval') assert.equal(f.bridge.state().approvals.length, 1, 'Review never answers native approval');
  if (gate === 'stopped') assert.equal(f.manager.view().state, 'stopped');
  if (gate === 'voice') await f.bridge.stopVoice();
});
