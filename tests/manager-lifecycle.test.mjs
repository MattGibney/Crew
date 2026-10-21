// GitHub #3. Real child protocol evidence, disposable state; no network/audio.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createBridge } from '../codex-bridge.mjs';
import { createManagerLifecycle } from '../manager-lifecycle.mjs';
import { createPromptSettings } from '../prompt-settings.mjs';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) { if (await predicate()) return; await delay(10); }
  throw new Error('Synthetic protocol condition did not arrive.');
}
async function fixture(t, { threadDelay = 0, interrupt = 'confirm' } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'crew-manager-lifecycle-'));
  const statePath = join(directory, 'manager.json'), control = join(directory, 'control.jsonl'), log = join(directory, 'calls.jsonl');
  const executable = join(directory, 'peer.mjs'), workers = join(directory, 'workers.json');
  await writeFile(control, ''); await writeFile(log, '');
  const workerEvidence = JSON.stringify({ tasks: [{ id: 'independent-worker', status: 'working', runId: 'immutable-run' }] });
  await writeFile(workers, workerEvidence);
  const program = `#!${process.execPath}
import { createInterface } from 'node:readline';
import { readFileSync, appendFileSync } from 'node:fs';
const control = ${JSON.stringify(control)}, log = ${JSON.stringify(log)};
let seen = readFileSync(control, 'utf8').split('\\n').filter(Boolean).length, sequence = 0;
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
const reply = (id, result) => send({ id, result });
const notify = (method, params) => send({ method, params: { threadId: 'preserved-manager', ...params } });
setInterval(() => {
  const lines = readFileSync(control, 'utf8').split('\\n').filter(Boolean);
  for (const line of lines.slice(seen)) send(JSON.parse(line)); seen = lines.length;
}, 5);
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line); appendFileSync(log, JSON.stringify({ pid: process.pid, ...message }) + '\\n');
  const { id, method, params } = message; if (id === undefined || !method) return;
  if (method === 'initialize') return reply(id, {});
  if (method === 'account/read') return reply(id, { account: { type: 'chatgpt', planType: 'synthetic' } });
  if (method === 'config/read') return reply(id, { config: {} });
  if (method === 'thread/start' || method === 'thread/resume') return setTimeout(() => reply(id, { thread: { id: 'preserved-manager' } }), ${threadDelay});
  if (method === 'thread/timeline/list') return send({ id, error: { code: -32601, message: 'Method not found' } });
  if (method === 'thread/turns/list') return reply(id, { data: [{ id: 'historic-turn', status: 'completed', items: [{ id: 'historic-message', type: 'agentMessage', text: 'Retained conversation history.' }] }] });
  if (method === 'mcpServerStatus/list') return reply(id, { data: [] });
  if (method === 'turn/start') {
    const turn = { id: 'new-turn-' + (++sequence), status: 'inProgress', items: [] };
    notify('turn/started', { turn }); return reply(id, { turn });
  }
  if (method === 'turn/interrupt') {
    if (${JSON.stringify(interrupt)} === 'error') return send({ id, error: { code: -1, message: 'Synthetic interruption failure.' } });
    if (${JSON.stringify(interrupt)} === 'confirm') notify('turn/completed', { turn: { id: params.turnId, status: 'interrupted', items: [] } });
    return reply(id, {});
  }
  return reply(id, {});
});
`;
  await writeFile(executable, program, { mode: 0o700 });
  const prompts = await createPromptSettings({ stateDir: directory, projectId: 'test-project', managerPrompt: 'CUSTOM MANAGER ALPHA', workerPrompt: 'CUSTOM WORKER ALPHA' });
  const independentWorker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  await once(independentWorker, 'spawn');
  const bridges = [], events = [];
  const newBridge = () => { const bridge = createBridge({ cwd: directory, statePath, executable, onEvent: event => events.push(event) }); bridges.push(bridge); return bridge; };
  const bridge = newBridge();
  t.after(async () => {
    await Promise.all(bridges.map(b => b.shutdown()));
    if (independentWorker.exitCode === null && independentWorker.signalCode === null) { const exited = once(independentWorker, 'exit'); independentWorker.kill('SIGTERM'); await exited; }
    await rm(directory, { recursive: true, force: true });
  });
  const lifecycle = await createManagerLifecycle({ stateDir: directory, projectId: 'test-project', bridge, prompts });
  return { directory, statePath, prompts, bridge, lifecycle, events, newBridge,
    calls: async () => (await readFile(log, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)),
    notify: async value => appendFile(control, JSON.stringify(value) + '\n'),
    workerUnchanged: async () => {
      assert.equal(await readFile(workers, 'utf8'), workerEvidence);
      assert.equal(independentWorker.exitCode, null); assert.equal(independentWorker.signalCode, null);
      assert.doesNotThrow(() => process.kill(independentWorker.pid, 0));
    },
    recreate: async () => createManagerLifecycle({ stateDir: directory, projectId: 'test-project', bridge: newBridge(), prompts }),
  };
}
const threadCalls = calls => calls.filter(call => ['thread/start', 'thread/resume', 'thread/fork'].includes(call.method));

test('saved full replacement manager prompt reaches native resume only after explicit restart; history and workers survive', async t => {
  const f = await fixture(t); await f.lifecycle.prepare();
  const original = threadCalls(await f.calls());
  assert.equal(original.length, 1); assert.match(original[0].params.developerInstructions, /^CUSTOM MANAGER ALPHA\n/);
  assert.equal(original[0].params.developerInstructions.includes('CUSTOM WORKER ALPHA'), false);
  const initial = await f.prompts.read();
  assert.equal(f.lifecycle.view().activeVersion, initial.manager.version);
  await f.prompts.save({ role: 'manager', text: 'CUSTOM MANAGER BETA', expectedVersion: initial.manager.version });
  await f.lifecycle.prepare();
  assert.equal(threadCalls(await f.calls()).length, 1);
  assert.equal(f.lifecycle.view().activeVersion, initial.manager.version);
  await f.lifecycle.request('restart');
  const calls = threadCalls(await f.calls());
  assert.deepEqual(calls.map(c => c.method), ['thread/start', 'thread/resume']);
  assert.equal(calls[1].params.threadId, 'preserved-manager');
  assert.match(calls[1].params.developerInstructions, /^CUSTOM MANAGER BETA\n/);
  assert.equal(calls[1].params.developerInstructions.includes('CUSTOM MANAGER ALPHA'), false);
  assert.equal(f.lifecycle.view().activeVersion, (await f.prompts.read()).manager.version);
  assert.equal(JSON.parse(await readFile(f.statePath, 'utf8')).threadId, 'preserved-manager');
  assert.equal(f.bridge.state().messages.some(message => message.text === 'Retained conversation history.'), true);
  assert.equal((await f.calls()).some(c => ['turn/start', 'thread/realtime/start'].includes(c.method)), false);
  await f.workerUnchanged();
});

test('idle stop is durable across controller recreation; Start resumes saved chat without launching work or voice', async t => {
  const f = await fixture(t); await f.lifecycle.prepare();
  await f.lifecycle.request('stop'); assert.equal(f.lifecycle.view().state, 'stopped');
  assert.equal(f.bridge.state().status, 'stopped'); assert.equal(f.bridge.state().voiceActive, false);
  await assert.rejects(f.lifecycle.run(() => f.bridge.startWork('should be held', 'held')), /stopped/);
  const restartedController = await f.recreate();
  assert.equal(restartedController.view().state, 'stopped');
  await assert.rejects(restartedController.prepare(), /stopped/);
  assert.equal(threadCalls(await f.calls()).length, 1);
  await restartedController.request('start');
  assert.equal(restartedController.view().state, 'running');
  const calls = await f.calls(); assert.deepEqual(threadCalls(calls).map(c => c.method), ['thread/start', 'thread/resume']);
  assert.equal(calls.some(c => ['turn/start', 'thread/realtime/start'].includes(c.method)), false);
  await f.workerUnchanged();
});

test('busy stop waits for matching native interruption before reporting stopped and leaves workers untouched', async t => {
  const f = await fixture(t); await f.lifecycle.run(() => f.bridge.startWork('remain active', 'busy'));
  assert.equal(f.bridge.state().activeTurnId, 'new-turn-1');
  await f.lifecycle.request('stop');
  assert.equal(f.bridge.state().activeTurnId, null); assert.equal(f.lifecycle.view().state, 'stopped');
  const interrupts = (await f.calls()).filter(c => c.method === 'turn/interrupt');
  assert.equal(interrupts.length, 1); assert.equal(interrupts[0].params.turnId, 'new-turn-1');
  await f.workerUnchanged();
});

test('delayed native start cannot race stop into false idle or an untracked live manager', async t => {
  const f = await fixture(t, { threadDelay: 90 });
  const starting = f.lifecycle.run(() => f.bridge.startWork('delayed start', 'delayed'));
  await until(() => f.bridge.state().workStarting);
  const stopping = f.lifecycle.request('stop');
  assert.equal(f.lifecycle.view().state, 'stopping');
  await assert.rejects(f.lifecycle.run(() => f.bridge.startWork('second start', 'second')), /unavailable/);
  await Promise.all([starting, stopping]);
  assert.equal(f.lifecycle.view().state, 'stopped'); assert.equal(f.bridge.state().activeTurnId, null);
  assert.equal((await f.calls()).filter(c => c.method === 'turn/start').length, 1);
  assert.equal((await f.calls()).filter(c => c.method === 'turn/interrupt').length, 1);
  await f.workerUnchanged();
});

test('unconfirmed interruption times out without claiming stop or terminating the provider process', async t => {
  const f = await fixture(t, { interrupt: 'unconfirmed' }); await f.lifecycle.run(() => f.bridge.startWork('active', 'unconfirmed'));
  await assert.rejects(f.bridge.stopManager({ timeoutMs: 65 }), /not yet confirmed/);
  assert.equal(f.bridge.state().activeTurnId, 'new-turn-1');
  assert.equal(f.bridge.state().status, 'working');
  await f.notify({ method: 'item/completed', params: { threadId: 'preserved-manager', turnId: 'new-turn-1', item: { id: 'liveness', type: 'agentMessage', text: 'Provider still alive.' } } });
  await until(() => f.bridge.state().messages.some(m => m.id === 'liveness'));
  await f.workerUnchanged();
});

test('pending approvals hold stop even after turn interruption and are never silently approved', async t => {
  const f = await fixture(t); await f.lifecycle.run(() => f.bridge.startWork('approval', 'approval'));
  await f.notify({ id: 'approval-1', method: 'item/commandExecution/requestApproval', params: { threadId: 'preserved-manager', turnId: 'new-turn-1', command: 'synthetic-command', availableDecisions: ['accept', 'decline'] } });
  await until(() => f.bridge.state().approvals.length === 1);
  await assert.rejects(f.bridge.stopManager({ timeoutMs: 65 }), /not yet confirmed/);
  assert.equal(f.bridge.state().approvals.length, 1); assert.notEqual(f.bridge.state().status, 'stopped');
  assert.equal((await f.calls()).some(c => c.id === 'approval-1' && c.result), false);
  f.bridge.answerApproval('approval-1', { decision: 'decline' });
  await f.bridge.stopManager({ timeoutMs: 250 }); assert.equal(f.bridge.state().status, 'stopped');
  await f.workerUnchanged();
});

test('native stop error leaves durable held intent and requires a fresh explicit lifecycle action', async t => {
  const f = await fixture(t, { interrupt: 'error' }); await f.lifecycle.run(() => f.bridge.startWork('error', 'error'));
  await assert.rejects(f.lifecycle.request('stop'), /Synthetic interruption failure/);
  assert.equal(f.lifecycle.view().state, 'error'); assert.match(f.lifecycle.view().error, /Synthetic interruption failure/);
  await assert.rejects(f.lifecycle.prepare(), /unavailable/);
  const persisted = JSON.parse(await readFile(join(f.directory, 'manager-lifecycle.json'), 'utf8'));
  assert.equal(persisted.intent, 'stopped'); assert.equal(f.bridge.state().activeTurnId, 'new-turn-1');
  await f.workerUnchanged();
});


test('stop releases an established synthetic realtime session and Start never reconnects voice', async t => {
  const f = await fixture(t); await f.lifecycle.prepare();
  await f.notify({ method: 'thread/realtime/started', params: { threadId: 'preserved-manager' } });
  await until(() => f.bridge.state().voiceActive);
  await f.lifecycle.request('stop');
  assert.equal(f.bridge.state().voiceActive, false);
  assert.equal((await f.calls()).filter(c => c.method === 'thread/realtime/stop').length, 1);
  await f.lifecycle.request('start');
  assert.equal(f.bridge.state().voiceActive, false);
  assert.equal((await f.calls()).some(c => c.method === 'thread/realtime/start'), false);
  await f.workerUnchanged();
});

test('duplicate restart requests share one transition; conflicting actions cannot spawn a second manager', async t => {
  const f = await fixture(t, { threadDelay: 60 }); await f.lifecycle.prepare();
  const first = f.lifecycle.request('restart'), duplicate = f.lifecycle.request('restart');
  assert.equal(first, duplicate);
  await assert.rejects(f.lifecycle.request('start'), /already in progress/);
  await Promise.all([first, duplicate]);
  assert.equal(f.lifecycle.view().state, 'running');
  assert.deepEqual(threadCalls(await f.calls()).map(c => c.method), ['thread/start', 'thread/resume']);
  await f.workerUnchanged();
});

test('another project cannot load or overwrite the retained lifecycle identity', async t => {
  const f = await fixture(t);
  const file = join(f.directory, 'manager-lifecycle.json'), before = await readFile(file, 'utf8');
  await assert.rejects(createManagerLifecycle({ stateDir: f.directory, projectId: 'different-project', bridge: f.newBridge(), prompts: f.prompts }), /Invalid manager lifecycle record/);
  assert.equal(await readFile(file, 'utf8'), before);
  assert.equal((await f.calls()).length, 0);
  await f.workerUnchanged();
});
