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

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { if (await predicate()) return; await delay(10); }
  throw new Error('Expected synthetic native-protocol condition did not arrive');
}
async function fixture(t, { history = [], gateThread = false } = {}) {
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
 if (method === 'turn/start') return reply(id, {turn:{id:'review-turn-'+(++sequence),status:'inProgress'}});
 if (method === 'thread/realtime/start') { send({method:'thread/realtime/started',params:{threadId:'manager-thread'}}); send({method:'thread/realtime/sdp',params:{threadId:'manager-thread',sdp:'v=0 synthetic'}}); return reply(id,{}); }
 return reply(id, {});
});
`, { mode: 0o700 });
  bridge = createBridge({ cwd: directory, statePath, executable });
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
    await assert.rejects(f.bridge.startWork('second', `second-${backgroundFirst}`, { background: !backgroundFirst }), /already working/);
    await f.ready(); await first;
    assert.equal((await starts(f)).length, 1);
  }
});

test('saved native in-progress turn cannot receive a replacement scheduled review', async t => {
  const f = await fixture(t, { history: [{ id: 'retained-turn', status: 'inProgress', items: [] }] });
  await assert.rejects(f.bridge.startWork('review', 'retained-native-work', { background: true }), /already working/);
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
  const stopping = manager.request('stop');
  assert.equal(manager.view().state, 'stopping');
  await f.ready();
  assert.deepEqual(await pending, { accepted: false });
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
    await assert.rejects(f.bridge.startWork('human input', `human-${mutation}`), /already working/);
    if (mutation === 'stop') locallyAllowed = false;
    if (mutation === 'voice') await f.bridge.startVoice('v=0 synthetic-offer', 'cove');
    if (mutation === 'native-turn') {
      await f.notify('turn/started', { turn: { id: 'externally-observed-turn', status: 'inProgress', items: [] } });
      await until(() => f.bridge.state().activeTurnId === 'externally-observed-turn');
    }
    // Attach the rejection observer before releasing the blocked native guard.
    const outcome = pending.then(value => ({ value }), error => ({ error }));
    release();
    const result = await outcome;
    assert.deepEqual(result.value, { accepted: false });
    assert.equal((await starts(f)).length, 0);
  }
});
