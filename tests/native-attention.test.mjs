import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createNativeAttention } from '../desktop/native-attention.mjs';
const soundPath = fileURLToPath(new URL('../desktop/sounds/attention.wav', import.meta.url));
const approval = id => ({ work: { threadId: 'manager-one', approvals: [{ id }] } });
async function fixture(t, options = {}) {
 const dir = await mkdtemp(join(tmpdir(), 'crew-native-cue-'));
 t.after(() => rm(dir, { recursive: true, force: true }));
 const calls = [], children = [];
 const spawnImpl = (command, args, settings) => {
  calls.push({ command, args, settings }); const child = new EventEmitter();
  child.kill = signal => { child.killed = signal; queueMicrotask(() => child.emit('close', null)); };
  children.push(child); if (!options.hold) setTimeout(() => child.emit('close', options.exitCode || 0), 1);
  return child;
 };
 const ledgerPath = join(dir, 'history.json');
 const create = extra => createNativeAttention({ ledgerPath, soundPath, platform: 'darwin', spawnImpl, ...extra });
 return { calls, children, ledgerPath, create };
}

test('native owner persists before playback and coalesces polling/IPC without a renderer or microphone', async t => {
 const f = await fixture(t); const owner = f.create(); await owner.ready;
 owner.update(approval('request-one')); owner.update(approval('request-one'));
 owner.update({ work: { threadId: 'manager-one', approvals: [{ id: 'request-one' }, { id: 'request-two' }] } });
 await owner.idle(); assert.equal(f.calls.length, 1);
 assert.equal(f.calls[0].command, '/usr/bin/afplay');
 assert.deepEqual(f.calls[0].settings, { stdio: 'ignore', shell: false });
 assert.equal(JSON.parse(await readFile(f.ledgerPath, 'utf8')).keys.length, 2);
 await owner.dispose();
 const reopened = f.create(); await reopened.ready; reopened.update(approval('request-one')); await reopened.idle();
 assert.equal(f.calls.length, 1, 'window/native restart replay stays quiet');
 reopened.update(approval('request-three')); await reopened.idle(); assert.equal(f.calls.length, 2); await reopened.dispose();
});

test('only explicit human input sounds; malformed input, results and self-resolved failure stay quiet', async t => {
 const f = await fixture(t), owner = f.create();
 owner.update({ work: { threadId: 'manager-one', approvals: [null, {}], items: [{ attention: {} }] }, orchestration: { tasks: [null, { id: 'failed-task', status: 'failed', attention: [{ kind: 'failure' }] }, { id: 'completed-task', status: 'completed' }, { id: 'old', runId: 'new', status: 'awaiting_answer', question: { id: 'q', runId: 'old' } }] } });
 await owner.idle(); assert.equal(f.calls.length, 0);
 owner.update({ orchestration: { tasks: [{ id: 'worker', runId: 'run', status: 'awaiting_answer', question: { id: 'question', runId: 'run' } }] } });
 await owner.idle(); assert.equal(f.calls.length, 1);
 owner.update({ orchestration: { tasks: [{ id: 'worker', runId: 'run', status: 'awaiting_answer', question: { id: 'answered', runId: 'run' }, answer: { questionId: 'answered' } }] } });
 await owner.idle(); assert.equal(f.calls.length, 1); await owner.dispose();
});

test('project owners isolate identical event identities and retain background deduplication across reopen', async t => {
 const first = await fixture(t), second = await fixture(t);
 const selected = first.create(), background = second.create();
 await Promise.all([selected.ready, background.ready]);
 selected.update(approval('same-request')); background.update(approval('same-request'));
 await Promise.all([selected.idle(), background.idle()]);
 assert.equal(first.calls.length, 1); assert.equal(second.calls.length, 1);
 // Closing or switching the renderer does not replace a project's native owner.
 background.update(approval('same-request')); await background.idle();
 assert.equal(second.calls.length, 1);
 await Promise.all([selected.dispose(), background.dispose()]);
 const reopened = second.create(); await reopened.ready;
 reopened.update(approval('same-request')); await reopened.idle();
 assert.equal(second.calls.length, 1);
 reopened.update(approval('new-background-request')); await reopened.idle();
 assert.equal(second.calls.length, 2); await reopened.dispose();
});

test('corrupt ledger and failed playback fail closed with observable availability', async t => {
 const f = await fixture(t); await writeFile(f.ledgerPath, 'not json'); const owner = f.create();
 assert.equal(await owner.ready, false); owner.update(approval('request-one')); await owner.idle(); assert.equal(f.calls.length, 0); assert.equal(owner.getStatus().available, false); await owner.dispose();
 const failed = await fixture(t, { exitCode: 1 }), bad = failed.create(); await bad.ready;
 bad.update(approval('request-one')); await bad.idle(); assert.equal(bad.getStatus().available, false); assert.ok(bad.getStatus().error);
 bad.update(approval('request-two')); await bad.idle(); assert.equal(failed.calls.length, 1); await bad.dispose();
});

test('dispose and timeout terminate only the owned audio subprocess', async t => {
 const f = await fixture(t, { hold: true }), owner = f.create({ timeoutMs: 15 }); await owner.ready;
 owner.update(approval('request-one')); await owner.idle(); assert.equal(f.children[0].killed, 'SIGKILL'); assert.equal(owner.getStatus().available, false); await owner.dispose();
 const g = await fixture(t, { hold: true }), closing = g.create(); await closing.ready;
 closing.update(approval('request-two'));
 while (!g.children.length) await new Promise(resolve => setTimeout(resolve, 1));
 await closing.dispose(); assert.equal(g.children[0].killed, 'SIGKILL');
 closing.update(approval('request-three')); await closing.idle(); assert.equal(g.calls.length, 1);
});

test('original attention WAV is a short PCM asset', async () => {
 const bytes = await readFile(new URL('../desktop/sounds/attention.wav', import.meta.url));
 assert.equal(bytes.toString('ascii', 0, 4), 'RIFF'); assert.equal(bytes.toString('ascii', 8, 12), 'WAVE'); assert.equal(bytes.readUInt32LE(24), 44100); assert.equal(bytes.readUInt16LE(22), 1); assert.ok(bytes.length < 50000);
});

test('missing exit confirmation remains visibly active until a late close arrives', async t => {
 const f = await fixture(t, { hold: true });
 const owner = f.create({ timeoutMs: 5, spawnImpl: () => {
  const child = new EventEmitter(); child.kill = () => true; f.children.push(child); return child;
 } });
 await owner.ready; owner.update(approval('unknown-exit')); await owner.idle();
 assert.equal(owner.getStatus().available, false); assert.equal(owner.getStatus().playing, true);
 f.children[0].emit('close', null);
 assert.equal(owner.getStatus().playing, false); await owner.dispose();
});
