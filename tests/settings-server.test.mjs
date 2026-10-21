// GitHub #3: actual HTTP server + synthetic stdio provider; no user config/network/audio.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTask, updateTask, readTask } from '../orchestration-store.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() { const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; }
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'crew-settings-http-')), dataDir = join(directory, 'state'), stateDir = join(dataDir, 'orchestration');
  const executable = join(directory, 'synthetic-codex.mjs'), callsFile = join(directory, 'calls.jsonl'), configPath = join(directory, 'config.json');
  const port = await freePort(), origin = `http://127.0.0.1:${port}`;
  await writeFile(callsFile, '');
  await writeFile(join(directory, 'manager.md'), 'HTTP MANAGER ORIGINAL'); await writeFile(join(directory, 'worker.md'), 'HTTP WORKER ORIGINAL');
  const config = JSON.parse(await readFile(join(root, 'config/fixture.example.json'), 'utf8'));
  config.runtime = { port, codexBinary: executable, dataDir };
  config.project.id = 'http-settings-fixture'; config.project.prompts = { manager: join(directory, 'manager.md'), worker: join(directory, 'worker.md') };
  await writeFile(configPath, JSON.stringify(config));
  await writeFile(executable, `#!${process.execPath}
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
if (process.argv.includes('--version')) { console.log('codex-cli 0.0.0-synthetic'); process.exit(0); }
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line); appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(message) + '\\n');
  const { id, method, params } = message; if (id === undefined || !method) return;
  const reply = result => send({ id, result });
  if (method === 'initialize') return reply({});
  if (method === 'account/read') return reply({ account: { type: 'chatgpt', planType: 'synthetic' } });
  if (method === 'thread/start' || method === 'thread/resume') return reply({ thread: { id: 'http-retained-chat' } });
  if (method === 'thread/turns/list') return reply({ data: [{ id: 'historic-turn', status: 'completed', items: [{ id: 'historic-message', type: 'agentMessage', text: 'Preserved HTTP history.' }] }] });
  if (method === 'mcpServerStatus/list') return reply({ data: [] });
  if (method === 'turn/start') { const turn = { id: 'http-turn', status: 'completed', items: [] }; send({ method: 'turn/completed', params: { threadId: 'http-retained-chat', turn } }); return reply({ turn }); }
  return reply({});
});
`, { mode: 0o700 });
  let child = null, diagnostics = '';
  const streams = new Set();
  async function request(route, { method = 'POST', body = {}, requestOrigin = origin } = {}) {
    const headers = { Origin: requestOrigin, 'Content-Type': 'application/json' };
    const response = await fetch(origin + route, { method, headers, ...(method === 'GET' ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, value: await response.json() };
  }
  async function stop() {
    for (const abort of streams) abort.abort(); streams.clear();
    if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
    child = null;
  }
  async function start() {
    diagnostics = '';
    child = spawn(process.execPath, [join(root, 'server.mjs')], { cwd: root, env: { ...process.env, AI_MANAGER_CONFIG: configPath, AI_MANAGER_PORT: String(port), AI_MANAGER_CODEX_BINARY: executable, CODEX_BINARY: executable }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', data => { diagnostics += data; }); child.stderr.on('data', data => { diagnostics += data; });
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Synthetic HTTP server exited: ${diagnostics}`);
      try { const result = await request('/api/settings', { method: 'GET' }); if (result.status === 200) return; } catch {}
      await delay(30);
    }
    throw new Error(`Synthetic HTTP server readiness timed out: ${diagnostics}`);
  }
  async function events() { const abort = new AbortController(); streams.add(abort); const response = await fetch(origin + '/events', { headers: { Origin: origin }, signal: abort.signal }); assert.equal(response.status, 200); const reader = response.body.getReader(); await reader.read(); return abort; }
  const calls = async () => (await readFile(callsFile, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  t.after(async () => { await stop(); await rm(directory, { recursive: true, force: true }); });
  return { directory, dataDir, stateDir, request, start, stop, calls, events };
}
const instructions = calls => calls.filter(c => ['thread/start', 'thread/resume', 'thread/fork'].includes(c.method));

test('real HTTP save, explicit restart, durable stop and Start preserve conversation, worker settings and task history', async t => {
  const f = await fixture(t);
  const historical = await createTask(f.stateDir, { requestId: 'http-retained-task', ticket: 'AI-004', brief: 'Retained disposable task; never execute.', projectId: 'http-settings-fixture' });
  await updateTask(f.stateDir, historical.id, task => { task.status = 'completed'; task.result = { message: 'Prior fixture evidence remains.' }; });
  await f.start();
  let settings = (await f.request('/api/settings', { method: 'GET' })).value;
  assert.equal(settings.projectId, 'http-settings-fixture'); assert.equal(settings.manager.saved.text, 'HTTP MANAGER ORIGINAL');
  assert.equal((await f.calls()).length, 0);
  const prepared = await f.request('/api/prepare'); assert.equal(prepared.status, 200);
  assert.equal(prepared.value.state.threadId, 'http-retained-chat');
  const originalVersion = settings.manager.saved.version;
  settings = (await f.request('/api/settings/prompts', { method: 'PUT', body: { role: 'manager', text: 'HTTP MANAGER EDITED', expectedVersion: originalVersion } })).value;
  assert.equal(settings.manager.pendingRestart, true); assert.equal(settings.manager.activeVersion, originalVersion);
  assert.equal((await f.request('/api/prepare')).status, 200);
  assert.equal(instructions(await f.calls()).length, 1);
  assert.match(instructions(await f.calls())[0].params.developerInstructions, /^HTTP MANAGER ORIGINAL\n/);
  assert.equal((await f.request('/api/manager/lifecycle', { body: { action: 'restart' } })).status, 200);
  settings = (await f.request('/api/settings', { method: 'GET' })).value;
  assert.equal(settings.manager.pendingRestart, false); assert.equal(settings.manager.activeVersion, settings.manager.saved.version);
  assert.deepEqual(instructions(await f.calls()).map(c => c.method), ['thread/start', 'thread/resume']);
  assert.match(instructions(await f.calls())[1].params.developerInstructions, /^HTTP MANAGER EDITED\n/);
  assert.equal(instructions(await f.calls())[1].params.developerInstructions.includes('HTTP MANAGER ORIGINAL'), false);
  const savedWorker = await f.request('/api/settings/prompts', { method: 'PUT', body: { role: 'worker', text: 'HTTP WORKER EDITED', expectedVersion: settings.worker.saved.version } });
  assert.equal(savedWorker.status, 200);
  assert.equal((await f.request('/api/manager/lifecycle', { body: { action: 'stop' } })).status, 200);
  await f.events();
  for (const [route, body] of [['/api/prepare', {}], ['/api/work', { text: 'Held synthetic request', requestId: 'http-held-request' }], ['/api/connect', { sdp: 'v=0\r\nsynthetic' }]]) {
    const result = await f.request(route, { body }); assert.equal(result.status, 400); assert.match(result.value.error, /Manager is stopped/);
  }
  settings = (await f.request('/api/settings', { method: 'GET' })).value;
  const savedWhileStopped = await f.request('/api/settings/prompts', { method: 'PUT', body: { role: 'manager', text: 'HTTP MANAGER NEXT START', expectedVersion: settings.manager.saved.version } });
  assert.equal(savedWhileStopped.status, 200);
  await f.stop(); await f.start();
  settings = (await f.request('/api/settings', { method: 'GET' })).value;
  assert.equal(settings.managerLifecycle.state, 'stopped'); assert.equal(settings.manager.activeVersion, null);
  assert.equal(settings.worker.saved.text, 'HTTP WORKER EDITED');
  assert.equal(settings.manager.saved.text, 'HTTP MANAGER NEXT START');
  assert.equal((await f.request('/api/prepare')).status, 400);
  assert.equal(instructions(await f.calls()).length, 2);
  assert.equal((await f.request('/api/manager/lifecycle', { body: { action: 'start' } })).status, 200);
  const resumed = instructions(await f.calls()).at(-1);
  assert.equal(resumed.method, 'thread/resume'); assert.equal(resumed.params.threadId, 'http-retained-chat');
  assert.match(resumed.params.developerInstructions, /^HTTP MANAGER NEXT START\n/);
  const state = (await f.request('/api/state')).value;
  assert.equal(state.messages.some(message => message.text === 'Preserved HTTP history.'), true);
  assert.equal((await readTask(f.stateDir, historical.id)).result.message, 'Prior fixture evidence remains.');
  const tasks = (await f.request('/api/orchestration')).value.tasks;
  assert.equal(tasks.length, 1); assert.equal(tasks[0].id, historical.id); assert.equal(tasks[0].status, 'completed');
  assert.equal((await f.calls()).some(c => ['thread/realtime/start', 'turn/start'].includes(c.method)), false);
});

test('HTTP origin checks, stale writes and invalid saves preserve the prior project settings', async t => {
  const f = await fixture(t); await f.start();
  const initial = (await f.request('/api/settings', { method: 'GET' })).value;
  const original = initial.worker.saved;
  const update = { role: 'worker', text: 'HTTP WORKER NEW', expectedVersion: original.version };
  assert.equal((await f.request('/api/settings/prompts', { method: 'PUT', body: update, requestOrigin: 'https://untrusted.invalid' })).status, 403);
  assert.equal((await f.request('/api/settings', { method: 'GET', requestOrigin: 'https://untrusted.invalid' })).status, 403);
  assert.equal((await f.request('/api/settings/prompts', { method: 'PUT', body: update })).status, 200);
  const stale = await f.request('/api/settings/prompts', { method: 'PUT', body: { ...update, text: 'MUST NOT OVERWRITE' } });
  assert.equal(stale.status, 400); assert.match(stale.value.error, /changed elsewhere/);
  const current = (await f.request('/api/settings', { method: 'GET' })).value;
  assert.equal(current.worker.saved.text, 'HTTP WORKER NEW');
  const empty = await f.request('/api/settings/prompts', { method: 'PUT', body: { role: 'worker', text: '  ', expectedVersion: current.worker.saved.version } });
  assert.equal(empty.status, 400);
  assert.deepEqual((await f.request('/api/settings', { method: 'GET' })).value.worker.saved, current.worker.saved);
  assert.equal((await f.calls()).length, 0);
});

test('worker detail HTTP is read-only, same-origin and project scoped', async t => {
  const f = await fixture(t);
  await createTask(f.stateDir, { requestId: 'http-detail-task', ticket: 'AI-004', brief: 'Read-only detail fixture, never execute.', projectId: 'http-settings-fixture' });
  await updateTask(f.stateDir, 'http-detail-task', task => { task.status = 'completed'; });
  await f.start();
  const before = await readTask(f.stateDir, 'http-detail-task');
  const response = await f.request('/api/workers/http-detail-task', { method: 'GET' });
  assert.equal(response.status, 200);
  assert.equal(response.value.taskId, 'http-detail-task');
  assert.equal(response.value.conversation[0].message, before.brief);
  assert.equal((await f.request('/api/workers/http-detail-task', { method: 'GET', requestOrigin: 'https://untrusted.invalid' })).status, 403);
  assert.equal((await f.request('/api/workers/http-detail-task', { body: { markdown: 'not authorized' } })).status, 404);
  assert.equal((await readTask(f.stateDir, 'http-detail-task')).revision, before.revision);
  await createTask(f.stateDir, { requestId: 'http-other-project', ticket: 'AI-004', brief: 'Different project', projectId: 'other-project' });
  const other = await f.request('/api/workers/http-other-project', { method: 'GET' });
  assert.equal(other.status, 400); assert.match(other.value.error, /another project/);
  assert.equal((await f.calls()).some(call => call.method === 'turn/start'), false);
});
