// GitHub #3: actual HTTP server + synthetic stdio provider; no user config/network/audio.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTask, updateTask, readTask, loadTasks, requestWorkerAction } from '../runtime/orchestration/store.mjs';
import { recordWorkerRequest, workerRequestDecisions, listWorkerRequests } from '../runtime/workers/approval-store.mjs';
const root = fileURLToPath(new URL('../runtime/', import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() { const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; }
async function fixture(t, { nativeAttention = false } = {}) {
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
  if (method === 'config/read') return reply({ config: {} });
  if (method === 'thread/start' || method === 'thread/resume') return reply({ thread: { id: 'http-retained-chat' } });
  if (method === 'thread/timeline/list') return send({ id, error: { code: -32601, message: 'Method not found' } });
  if (method === 'thread/turns/list') return reply({ data: [{ id: 'historic-turn', status: 'completed', items: [{ id: 'historic-message', type: 'agentMessage', text: 'Preserved HTTP history.' }] }] });
  if (method === 'mcpServerStatus/list') return reply({ data: [] });
  if (method === 'turn/start') { const turn = { id: 'http-turn', status: 'completed', items: [] }; send({ method: 'turn/completed', params: { threadId: 'http-retained-chat', turn } }); return reply({ turn }); }
  return reply({});
});
`, { mode: 0o700 });
  let child = null, diagnostics = '';
  const nativeEvents = [];
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
    // A server shutdown leaves workers independent. This fixture owns only
    // synthetic workers; wait for natural supervisor exit before deleting files.
    for (const task of await loadTasks(stateDir).catch(error => {if(error.code==='ENOENT') return []; throw error;})) {
      if (!task.runnerPid) continue;
      const until = Date.now() + 15000;
      for (;;) {
        try { process.kill(task.runnerPid, 0); }
        catch (error) { if (error.code === 'ESRCH') break; throw error; }
        if (Date.now() >= until) throw new Error(`Synthetic worker ${task.id} has not exited; fixture files preserved.`);
        await delay(30);
      }
    }
  }
  async function start() {
    diagnostics = '';
    child = spawn(process.execPath, [join(root, 'server.mjs')], { cwd: root, env: { ...process.env, AI_MANAGER_CONFIG: configPath, AI_MANAGER_PORT: String(port), AI_MANAGER_CODEX_BINARY: executable, CODEX_BINARY: executable, ...(nativeAttention ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }, stdio: ['ignore', 'pipe', 'pipe', ...(nativeAttention ? ['ipc'] : [])] });
    child.stdout.on('data', data => { diagnostics += data; }); child.stderr.on('data', data => { diagnostics += data; });
    if (nativeAttention) child.on('message', message => nativeEvents.push(message));
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
  t.after(async () => {
    await stop();
    let disposable;
    try { disposable = JSON.parse(await readFile(join(stateDir, 'fixture.json'), 'utf8')); }
    catch (error) { if(error.code!=='ENOENT') throw error; }
    // The controller creates this separate disposable Git root, outside dataDir.
    if (disposable) {
      assert.match(disposable.base, /[/\\]crew-fixture-[^/\\]+$/);
      assert.equal(disposable.repo, join(disposable.base,'repo'));
      await rm(disposable.base, {recursive:true,force:true});
    }
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, dataDir, stateDir, configPath, origin, request, start, stop, calls, events, nativeEvents };
}
const instructions = calls => calls.filter(c => ['thread/start', 'thread/resume', 'thread/fork'].includes(c.method));

test('worker approval HTTP endpoint rejects cross-origin and stale correlation, persists an actual decision without starting manager work', async t => {
  const f = await fixture(t, { nativeAttention: true });
  const taskId = 'http-approval-task', runId = 'http-approval-run', threadId = 'native-http-thread', turnId = 'native-http-turn';
  await createTask(f.stateDir, { requestId: taskId, ticket: 'GH-13', brief: 'Read-only synthetic request', projectId: 'http-settings-fixture' });
  await updateTask(f.stateDir, taskId, task => { task.status = 'running'; task.runId = runId; });
  // Publish the retained synthetic run before controller startup. A live
  // controller may legitimately admit a newly created queued task between writes.
  await f.start();
  const native = await recordWorkerRequest({ stateDir: f.stateDir, taskId, runId, threadId, turnId, requestId: 5, method: 'item/commandExecution/requestApproval', params: { threadId, turnId, command: 'docker version', availableDecisions: ['accept', 'decline', 'cancel'] } });
  const { approvalId, requestId } = native;
  const snapshot = await f.request('/api/worker-approvals');
  assert.equal(snapshot.status, 200); assert.equal(snapshot.value.requests[0].approvalId, approvalId);
  assert.equal((await f.request('/api/config')).value.nativeAttentionSound, true, 'the renderer defers playback to the native project owner');
  const forwarded = () => f.nativeEvents.filter(message => message.type === 'crew:attention:state' && message.event?.type === 'worker-approval-state');
  const ipcDeadline = Date.now() + 3000;
  while (!forwarded().some(message => message.event.requests.some(request => request.approvalId === approvalId)) && Date.now() < ipcDeadline) await delay(10);
  const pendingEvent = forwarded().find(message => message.event.requests.some(request => request.approvalId === approvalId));
  assert.ok(pendingEvent, 'pending worker approval reaches the native owner without a browser SSE consumer');
  assert.equal(pendingEvent.event.requests[0].status, 'pending'); assert.equal(pendingEvent.event.requests[0].requestId, 5);
  const body = { taskId, runId, threadId, turnId, approvalId, requestId, response: { decision: 'decline' } };
  assert.equal((await f.request('/api/worker-approval', { body, requestOrigin: 'https://untrusted.example' })).status, 403);
  const stale = await f.request('/api/worker-approval', { body: { ...body, runId: 'stale-http-run' } });
  assert.equal(stale.status, 400); assert.match(stale.value.error, /correlation mismatch/);
  assert.deepEqual(await workerRequestDecisions({ stateDir: f.stateDir, taskId, runId }), []);
  const result = await f.request('/api/worker-approval', { body });
  assert.equal(result.status, 200, JSON.stringify(result.value)); assert.equal(result.value.status, 'decided');
  assert.equal((await workerRequestDecisions({ stateDir: f.stateDir, taskId, runId }))[0].response.decision, 'decline');
  assert.equal((await f.request('/api/worker-approval', { body })).status, 200);
  assert.equal((await f.request('/api/worker-approval', { body: { ...body, response: { decision: 'accept' } } })).status, 400);
  assert.equal((await listWorkerRequests({ stateDir: f.stateDir, pendingOnly: true })).length, 0);
  assert.deepEqual((await f.request('/api/worker-approvals')).value.requests, []);
  assert.equal((await f.calls()).some(call => call.method === 'turn/start'), false);
});

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

test('manager profile HTTP persists only the project voice and never starts work', async t => {
  const f = await fixture(t); await f.start();
  const before = (await f.request('/api/settings', { method: 'GET' })).value;
  const saved = await f.request('/api/settings/manager-profile', { method: 'PUT', body: { voice: 'maple', expectedVersion: before.managerProfile.version } });
  assert.equal(saved.status, 200); assert.equal(saved.value.managerProfile.voice, 'maple');
  assert.equal(saved.value.manager.saved.version, before.manager.saved.version);
  assert.equal((await f.request('/api/settings/manager-profile', { method: 'PUT', requestOrigin: 'https://untrusted.invalid', body: { voice: 'cove', expectedVersion: saved.value.managerProfile.version } })).status, 403);
  await f.stop(); await f.start();
  assert.equal((await f.request('/api/settings', { method: 'GET' })).value.managerProfile.voice, 'maple');
  assert.equal((await f.calls()).some(call => ['turn/start', 'thread/realtime/start'].includes(call.method)), false);
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

test('profile behavior waits for explicit restart on the same chat and survives controller reload without changing custom prompts', async t => {
  const f = await fixture(t); await f.start();
  await f.request('/api/prepare');
  const original = (await f.request('/api/settings', { method: 'GET' })).value;
  const save = await f.request('/api/settings/manager-profile', { method: 'PUT', body: { name: 'Ada', personality: 'Use PROFILE_STYLE concise replies.', expectedVersion: original.managerProfile.version } });
  assert.equal(save.status, 200); assert.equal(save.value.manager.pendingRestart, true);
  assert.deepEqual(save.value.manager.saved, original.manager.saved);
  assert.deepEqual(save.value.worker, original.worker);
  assert.equal(save.value.managerProfile.voice, original.managerProfile.voice);
  assert.equal((await f.calls()).filter(c => ['thread/start', 'thread/resume'].includes(c.method)).length, 1);
  await f.stop(); await f.start(); await f.request('/api/prepare');
  let threads = (await f.calls()).filter(c => ['thread/start', 'thread/resume'].includes(c.method));
  assert.doesNotMatch(threads.at(-1).params.developerInstructions, /PROFILE_STYLE/);
  assert.equal((await f.request('/api/settings', { method: 'GET' })).value.manager.pendingRestart, true);
  assert.equal((await f.request('/api/manager/lifecycle', { body: { action: 'restart' } })).status, 200);
  threads = (await f.calls()).filter(c => ['thread/start', 'thread/resume'].includes(c.method));
  assert.equal(threads.at(-1).params.threadId, 'http-retained-chat');
  assert.match(threads.at(-1).params.developerInstructions, /HTTP MANAGER ORIGINAL/);
  assert.match(threads.at(-1).params.developerInstructions, /PROFILE_STYLE/);
  assert.equal((await f.request('/api/settings', { method: 'GET' })).value.manager.pendingRestart, false);
  assert.equal((await f.calls()).some(c => ['turn/start','thread/realtime/start'].includes(c.method)), false);
  await f.request('/api/work', { body: { text: 'Explicit synthetic conversational check', requestId: 'profile-context-proof' } });
  const turn = (await f.calls()).find(c => c.method === 'turn/start');
  assert.match(turn.params.additionalContext.crewManagerInstructions.value, /PROFILE_STYLE/);
  assert.match(turn.params.additionalContext.crewManagerInstructions.value, /replaces earlier Crew/);
  assert.equal(turn.params.additionalContext.crewManagerInstructions.kind, 'application');
  assert.equal(turn.params.input[0].text, 'Explicit synthetic conversational check');
});

test('combined instruction limit rejects either editor before persisting an unusable manager profile', async t => {
  const f = await fixture(t); await f.start();
  let saved = (await f.request('/api/settings', { method: 'GET' })).value;
  assert.equal((await f.request('/api/settings/prompts', { method: 'PUT', body: { role: 'manager', text: 'x'.repeat(63999), expectedVersion: saved.manager.saved.version } })).status, 200);
  saved = (await f.request('/api/settings', { method: 'GET' })).value;
  assert.equal((await f.request('/api/settings/manager-profile', { method: 'PUT', body: { name: 'Ada', expectedVersion: saved.managerProfile.version } })).status, 400);
  assert.equal((await f.request('/api/settings', { method: 'GET' })).value.managerProfile.name, '');
  assert.equal((await f.request('/api/settings/prompts', { method: 'PUT', body: { role: 'manager', text: 'Short instructions', expectedVersion: saved.manager.saved.version } })).status, 200);
  assert.equal((await f.request('/api/settings/manager-profile', { method: 'PUT', body: { name: 'Ada', expectedVersion: saved.managerProfile.version } })).status, 200);
  saved = (await f.request('/api/settings', { method: 'GET' })).value;
  assert.equal((await f.request('/api/settings/prompts', { method: 'PUT', body: { role: 'manager', text: 'x'.repeat(63999), expectedVersion: saved.manager.saved.version } })).status, 400);
  assert.equal((await f.request('/api/settings', { method: 'GET' })).value.manager.saved.text, 'Short instructions');
});

test('permanent archive deletion is scoped, stale guarded, idempotent and removes local records only', async t => {
 const {mkdir,access}=await import('node:fs/promises');const f=await fixture(t);await f.start();
 const taskId='http-archive-delete';
 await createTask(f.stateDir,{requestId:taskId,ticket:'GH-43',brief:'Local archived fixture',projectId:'http-settings-fixture'});
 await updateTask(f.stateDir,taskId,n=>{n.status='running';n.runId='archive-delete-run';});
 const native=await recordWorkerRequest({stateDir:f.stateDir,taskId,runId:'archive-delete-run',threadId:'archive-thread',turnId:'archive-turn',requestId:99,method:'item/commandExecution/requestApproval',params:{threadId:'archive-thread',turnId:'archive-turn',command:'fixture',availableDecisions:['accept','decline']}});
 const task=await updateTask(f.stateDir,taskId,n=>{n.status='disposed';n.archivedAt='2026-10-21T12:00:00Z';});
 const run=join(f.stateDir,'runs',taskId,'archive-run');await mkdir(run,{recursive:true});await writeFile(join(run,'evidence.json'),'local evidence');await writeFile(join(f.stateDir,'tasks',`${taskId}.notes.md`),'local notes');
 const outside=join(f.directory,'native-history');await mkdir(outside);await writeFile(join(outside,'keep.txt'),'provider history');
 const body={taskId,action:'delete',operationId:'delete-archive-operation',expectedRevision:task.revision};
 assert.equal((await f.request('/api/archived-worker-action',{body,requestOrigin:'https://untrusted.invalid'})).status,403);
 assert.equal((await f.request('/api/archived-worker-action',{body:{...body,expectedRevision:1}})).status,400);
 assert.deepEqual((await f.request('/api/worker-approvals')).value.requests,[]);
 const result=await f.request('/api/archived-worker-action',{body});assert.equal(result.status,200,JSON.stringify(result.value));
 await f.stop();await f.start();
 assert.equal((await f.request('/api/archived-worker-action',{body})).status,200);
 assert.deepEqual((await f.request('/api/worker-approvals')).value.requests,[]);
 await assert.rejects(access(join(f.stateDir,'worker-approvals',`${native.approvalId}.json`)),{code:'ENOENT'});
 // A retained orphan from an older version must never resurrect native attention.
 await writeFile(join(f.stateDir,'worker-approvals',`${native.approvalId}.json`),JSON.stringify(native));
 assert.deepEqual((await f.request('/api/worker-approvals')).value.requests,[]);
 await assert.rejects(access(join(f.stateDir,'tasks',`${taskId}.json`)),{code:'ENOENT'});await assert.rejects(access(join(f.stateDir,'runs',taskId)),{code:'ENOENT'});assert.equal(await readFile(join(outside,'keep.txt'),'utf8'),'provider history');
 await assert.rejects(createTask(f.stateDir,{requestId:taskId,ticket:'GH-43',brief:'Reused deleted identity',projectId:'http-settings-fixture'}),/choose a new task ID/);
 await createTask(f.stateDir,{requestId:'foreign-archive-delete',ticket:'GH-43',brief:'Foreign archived fixture',projectId:'foreign-project'});const foreign=await updateTask(f.stateDir,'foreign-archive-delete',n=>{n.status='disposed';});
 const denied=await f.request('/api/archived-worker-action',{body:{...body,taskId:foreign.id,expectedRevision:foreign.revision,operationId:'foreign-delete-operation'}});assert.equal(denied.status,400);assert.match(denied.value.error,/another project/);
 assert.equal((await f.calls()).some(call=>call.method==='turn/start'),false);
});

test('history-only restore HTTP preserves records across restart and never revives old questions or approvals', async t => {
 const f=await fixture(t),taskId='http-history-restore',projectId='http-settings-fixture';
 await createTask(f.stateDir,{requestId:taskId,ticket:'GH-43',brief:'Restore recorded history only',projectId});
 await updateTask(f.stateDir,taskId,n=>{n.status='running';n.runId='historical-restore-run';n.threadId='historical-restore-thread';});
 const native=await recordWorkerRequest({stateDir:f.stateDir,taskId,runId:'historical-restore-run',threadId:'historical-restore-thread',turnId:'old-restore-turn',requestId:101,method:'item/commandExecution/requestApproval',params:{threadId:'historical-restore-thread',turnId:'old-restore-turn',command:'historical fixture',availableDecisions:['accept','decline','cancel']}});
 const archived=await updateTask(f.stateDir,taskId,n=>{n.status='disposed';n.archivedAt='2026-10-21T12:00:00Z';n.result={message:'Retained result'};n.question={id:'historical-question',runId:n.runId,message:'Old question'};n.attention=[{id:'historical-attention',kind:'question',message:'Old question'}];});
 await f.start();const body={taskId,action:'restore',operationId:'http-restore-operation',expectedRevision:archived.revision};
 const response=await f.request('/api/archived-worker-action',{body});assert.equal(response.status,200,JSON.stringify(response.value));
 let restored=await readTask(f.stateDir,taskId);assert.equal(restored.status,'blocked');assert.match(restored.failure,/reconstruction is not currently supported/);assert.equal(restored.question,null);assert.ok(restored.attention[0].ackedAt);assert.deepEqual(restored.result,archived.result);assert.equal(restored.archivedAt,archived.archivedAt);
 assert.deepEqual((await f.request('/api/worker-approvals')).value.requests,[]);assert.equal((await listWorkerRequests({stateDir:f.stateDir,taskId}))[0].approvalId,native.approvalId,'native historical approval is retained without answering');
 for(const decision of ['accept','decline','cancel']){const denied=await f.request('/api/worker-approval',{body:{taskId,runId:native.runId,threadId:native.threadId,turnId:native.turnId,approvalId:native.approvalId,requestId:native.requestId,response:{decision}}});assert.equal(denied.status,400);assert.match(denied.value.error,/historical approvals/);}
 assert.equal((await listWorkerRequests({stateDir:f.stateDir,taskId}))[0].status,'pending');
 await f.stop();await f.start();assert.equal((await f.request('/api/archived-worker-action',{body})).status,200);restored=await readTask(f.stateDir,taskId);assert.equal(restored.status,'blocked');assert.equal(restored.runId,archived.runId);assert.equal(restored.history.filter(event=>event.id==='archive-restore:http-restore-operation').length,1);assert.deepEqual((await f.request('/api/worker-approvals')).value.requests,[]);
 assert.equal((await f.calls()).some(call=>['turn/start','thread/start'].includes(call.method)),false);
});


test('worker environment HTTP saves every supported direct hook without execution, preserves retained work, and survives restart', async t => {
  const f = await fixture(t);
  const historical = await createTask(f.stateDir, { requestId: 'http-environment-retained', ticket: 'GH-45', brief: 'Retained environment evidence; never execute.', projectId: 'http-settings-fixture' });
  await updateTask(f.stateDir, historical.id, task => { task.status = 'completed'; task.result = { message: 'Original attempt retained.' }; task.environment = { status: 'failed', planHash: 'original-plan', setupCompleted: false }; });
  const marker = join(f.directory, 'must-not-execute');
  const hook = { command: process.execPath, args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed')`, 'literal space', '$(never execute)', '', ...Array.from({length:12}, () => 'x'.repeat(8192))], timeoutMs: 1234 };
  const environment = Object.fromEntries(['bootstrap', 'start', 'ready', 'resume', 'cleanup'].map(phase => [phase, hook]));
  await f.start();
  const before = (await f.request('/api/settings', { method: 'GET' })).value;
  const retainedBefore = await readTask(f.stateDir, historical.id);
  assert.equal(before.workerEnvironment.available, true);
  assert.deepEqual(before.workerEnvironment.environment, {});
  const body = { expectedRevision: before.workerEnvironment.revision, environment };
  const denied = await f.request('/api/settings/worker-environment', { method: 'PUT', body, requestOrigin: 'https://untrusted.invalid' });
  assert.equal(denied.status, 403);
  const saved = await f.request('/api/settings/worker-environment', { method: 'PUT', body });
  assert.equal(saved.status, 200, JSON.stringify(saved.value));
  assert.deepEqual(saved.value.workerEnvironment.environment, environment);
  assert.equal(saved.value.workerEnvironment.configPath, f.configPath);
  assert.match(saved.value.workerEnvironment.provenance.description, /Crew overrides/);
  assert.deepEqual(await readTask(f.stateDir, historical.id), retainedBefore);
  const diskAfter = await readFile(f.configPath, 'utf8');
  const stale = await f.request('/api/settings/worker-environment', { method: 'PUT', body: { ...body, environment: {} } });
  assert.equal(stale.status, 400); assert.match(stale.value.error, /changed elsewhere/);
  const invalid = await f.request('/api/settings/worker-environment', { method: 'PUT', body: { expectedRevision: saved.value.workerEnvironment.revision, environment: { start: { ...hook, args: '--shell-shaped-string' } } } });
  assert.equal(invalid.status, 400);
  assert.equal(await readFile(f.configPath, 'utf8'), diskAfter);
  assert.deepEqual((await f.request('/api/settings', { method: 'GET' })).value.workerEnvironment.environment, environment, 'leaving the editor without another PUT preserves the saved hooks');
  await assert.rejects(readFile(marker), {code:'ENOENT'});
  assert.deepEqual(await f.calls(), [], 'settings never starts a manager, worker or realtime session');
  await f.stop(); await f.start();
  const restarted = (await f.request('/api/settings', { method: 'GET' })).value;
  assert.deepEqual(restarted.workerEnvironment.environment, environment);
  assert.equal(restarted.workerEnvironment.revision, saved.value.workerEnvironment.revision);
  assert.deepEqual((await readTask(f.stateDir, historical.id)).environment, retainedBefore.environment);
  assert.deepEqual((await readTask(f.stateDir, historical.id)).result, retainedBefore.result);
  await assert.rejects(readFile(marker), {code:'ENOENT'});
  assert.deepEqual(await f.calls(), []);
});


test('chunked worker environment HTTP preserves UTF-8 commands and arguments split inside code points', async t => {
  const f = await fixture(t); await f.start();
  const before = (await f.request('/api/settings', {method:'GET'})).value;
  const environment = {start:{command:'/tmp/工具-🌍',args:['naïve 🧪 café', '', 'line\n二'],timeoutMs:1000}};
  const bytes = Buffer.from(JSON.stringify({expectedRevision:before.workerEnvironment.revision,environment}), 'utf8');
  const firstSplit = bytes.indexOf(Buffer.from('工')) + 1;
  const secondSplit = bytes.indexOf(Buffer.from('🧪')) + 2;
  assert.ok(firstSplit > 0 && secondSplit > firstSplit);
  const result = await new Promise((resolve, reject) => {
    const req = httpRequest(f.origin + '/api/settings/worker-environment', {method:'PUT',headers:{Origin:f.origin,'Content-Type':'application/json','Transfer-Encoding':'chunked'}}, response => {
      const chunks=[]; response.on('data',chunk=>chunks.push(chunk)); response.on('error',reject);
      response.on('end',()=> {try {resolve({status:response.statusCode,value:JSON.parse(Buffer.concat(chunks).toString('utf8'))});} catch(error) {reject(error);}});
    });
    t.after(() => req.destroy());
    req.on('error',reject); req.setTimeout(10000,()=>req.destroy(new Error('Chunked environment request timed out.')));
    // Separate actual HTTP chunks deliberately end inside 3- and 4-byte UTF-8
    // sequences. Yield between writes so the server consumes partial input.
    void (async () => {
      req.write(bytes.subarray(0,firstSplit)); await delay(30);
      req.write(bytes.subarray(firstSplit,secondSplit)); await delay(30);
      req.end(bytes.subarray(secondSplit));
    })().catch(error=>req.destroy(error));
  });
  assert.equal(result.status,200,JSON.stringify(result.value));
  assert.deepEqual(result.value.workerEnvironment.environment,environment);
  assert.deepEqual((await f.request('/api/settings',{method:'GET'})).value.workerEnvironment.environment,environment);
  assert.deepEqual(JSON.parse(await readFile(f.configPath,'utf8')).project.worker.environment,environment);
  assert.deepEqual(await f.calls(),[], 'Unicode configuration editing never starts commands, workers or voice');
});


test('HTTP command edits survive restart as agent context without automatic bootstrap or retry', async t => {
  const f=await fixture(t);await f.start();
  const phaseFile='.crew-http-partial.json';
  const initialScript=`require('node:fs').writeFileSync(${JSON.stringify(phaseFile)},JSON.stringify({seeds:1,partial:true}));process.exit(17)`;
  const initialEnvironment={bootstrap:{command:process.execPath,args:['-e',initialScript],timeoutMs:5000}};
  const before=(await f.request('/api/settings',{method:'GET'})).value;
  const saved=await f.request('/api/settings/worker-environment',{method:'PUT',body:{expectedRevision:before.workerEnvironment.revision,environment:initialEnvironment}});
  assert.equal(saved.status,200,JSON.stringify(saved.value));
  const taskId='http-agent-environment';
  await createTask(f.stateDir,{requestId:taskId,ticket:'GH-50',brief:'Inspect agent-owned command context in this disposable fixture.',projectId:'http-settings-fixture'});
  async function waitTask(predicate,description){
    const until=Date.now()+15000;let task;
    while(Date.now()<until){task=await readTask(f.stateDir,taskId);if(await predicate(task))return task;await delay(40);}
    throw new Error(description+': '+JSON.stringify({status:task?.status,failure:task?.failure,harnessStarted:task?.harnessStarted,lifecycleRequests:task?.lifecycleRequests}));
  }
  const nativeEnded=async task=>{if(!task.threadId||!task.runDir)return false;try{const exit=JSON.parse(await readFile(join(task.runDir,'exit.json'),'utf8'));return exit.runId===task.runId&&(exit.connectionClosed===true||exit.stopConfirmed===true);}catch(error){if(error.code==='ENOENT')return false;throw error;}};
  async function environmentContext(task){
    const child=spawn(process.execPath,[join(root,'orchestration-mcp.mjs'),f.stateDir,'worker',taskId,task.runId],{stdio:['pipe','pipe','pipe']});let output='',errors='';
    child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>errors+=chunk);
    child.stdin.end(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'get_project_environment',arguments:{}}})+'\n');
    assert.equal(await new Promise(resolve=>child.on('close',resolve)),0,errors);
    const result=JSON.parse(output).result;assert.ok(!result.isError,JSON.stringify(result));return JSON.parse(result.content[0].text);
  }
  const first=await waitTask(nativeEnded,'Initial native connection did not finish');
  assert.equal(first.harnessStarted,true,'Native execution is not conditional on bootstrap success');
  assert.equal(first.environment?.hooks?.length||0,0,'Crew creates no automatic bootstrap attempt');
  await assert.rejects(readFile(join(first.worktree,phaseFile),'utf8'),{code:'ENOENT'});
  assert.deepEqual((await environmentContext(first)).configuredEnvironment,initialEnvironment);
  const firstConfig=JSON.parse(await readFile(join(first.runDir,'config.json'),'utf8'));
  assert.deepEqual(firstConfig.project.worker.environment,initialEnvironment);
  // Fixture-owned partial state proves subsequent command edits do not replay
  // commands or reset retained work. The configured repair would modify it.
  await writeFile(join(first.worktree,phaseFile),JSON.stringify({seeds:1,partial:true}));
  const correctedScript=`const fs=require('node:fs');const state=JSON.parse(fs.readFileSync(${JSON.stringify(phaseFile)},'utf8'));state.repaired=true;fs.writeFileSync(${JSON.stringify(phaseFile)},JSON.stringify(state))`;
  const correctedEnvironment={bootstrap:{command:process.execPath,args:['-e',correctedScript],timeoutMs:5000}};
  const fixed=await f.request('/api/settings/worker-environment',{method:'PUT',body:{expectedRevision:saved.value.workerEnvironment.revision,environment:correctedEnvironment}});
  assert.equal(fixed.status,200,JSON.stringify(fixed.value));
  await f.stop();await f.start();
  assert.deepEqual((await f.request('/api/settings',{method:'GET'})).value.workerEnvironment.environment,correctedEnvironment);
  const retained=await readTask(f.stateDir,taskId);assert.equal(retained.runId,first.runId);assert.equal(retained.worktree,first.worktree);assert.equal(retained.threadId,first.threadId);
  const turnsBefore=(await f.calls()).filter(call=>call.method==='turn/start').length;
  const action={taskId,actionId:'http-obsolete-setup-retry',action:'retry_setup',expectedRunId:first.runId};
  await requestWorkerAction(f.stateDir,action);
  const refused=await waitTask(task=>task.lifecycleRequests?.some(item=>item.id===action.actionId&&item.status==='failed'),'Obsolete retry did not explain the agent command path');
  assert.match(refused.lifecycleRequests.find(item=>item.id===action.actionId).error,/agent-initiated.*get_project_environment.*native tools/);
  assert.equal((await f.calls()).filter(call=>call.method==='turn/start').length,turnsBefore);
  const {requestWorkerFollowup}=await import('../runtime/orchestration/store.mjs');
  await requestWorkerFollowup(f.stateDir,{taskId,requestId:'http-new-agent-direction',brief:'Continue in the same working context with the latest configured commands.'});
  const next=await waitTask(async task=>task.runId!==first.runId&&await nativeEnded(task),'Retained native continuation did not finish');
  assert.equal(next.worktree,first.worktree);assert.equal(next.threadId,first.threadId);assert.equal(next.environment?.hooks?.length||0,0);
  assert.deepEqual((await environmentContext(next)).configuredEnvironment,correctedEnvironment);
  assert.deepEqual(JSON.parse(await readFile(join(first.worktree,phaseFile),'utf8')),{seeds:1,partial:true});
  assert.deepEqual(JSON.parse(await readFile(join(first.runDir,'config.json'),'utf8')),firstConfig,'Earlier native command context remains historical evidence');
  const calls=await f.calls();assert.ok(calls.some(call=>call.method==='thread/resume'&&call.params.threadId===first.threadId));assert.equal(calls.some(call=>call.method==='thread/realtime/start'),false);
  await f.stop();
});

test('manager schedules save through actual project settings without starting work and persist while stopped',async t=>{
 const f=await fixture(t);await f.start();
 const initial=await f.request('/api/settings',{method:'GET'});assert.equal(initial.status,200);assert.equal(initial.value.managerSchedules.schedules[0].id,'commitment-review');
 await f.request('/api/manager/lifecycle',{body:{action:'stop'}});
 const schedule={id:'project-check',name:'Check configured work',instruction:'Review only my explicitly assigned work.',enabled:true,timing:{kind:'interval',minutes:1}};
 const denied=await f.request('/api/settings/manager-schedules',{method:'PUT',requestOrigin:'https://elsewhere.invalid',body:{expectedRevision:initial.value.managerSchedules.revision,schedules:[schedule]}});assert.equal(denied.status,403);
 const saved=await f.request('/api/settings/manager-schedules',{method:'PUT',body:{expectedRevision:initial.value.managerSchedules.revision,schedules:[schedule]}});assert.equal(saved.status,200,JSON.stringify(saved.value));assert.equal(saved.value.managerSchedules.schedules[0].instruction,schedule.instruction);
 const stale=await f.request('/api/settings/manager-schedules',{method:'PUT',body:{expectedRevision:initial.value.managerSchedules.revision,schedules:[]}});assert.notEqual(stale.status,200);
 assert.equal((await f.calls()).filter(call=>call.method==='turn/start').length,0,'Saving does not run the instruction');
 await f.stop();await writeFile(join(f.stateDir,'manager-schedule-runs.json'),JSON.stringify({'project-check':{nextAt:Date.now()-60000}}));await f.start();
 let current;const deadline=Date.now()+5000;do{current=await f.request('/api/settings',{method:'GET'});if(current.value.managerSchedules.schedules[0].run.status==='deferred')break;await delay(50);}while(Date.now()<deadline);
 assert.equal(current.value.managerLifecycle.state,'stopped');assert.equal(current.value.managerSchedules.schedules[0].name,schedule.name);assert.equal(current.value.managerSchedules.schedules[0].run.status,'deferred');assert.equal((await f.calls()).filter(call=>call.method==='turn/start').length,0,'A due schedule never wakes the stopped manager');await f.stop();
});
