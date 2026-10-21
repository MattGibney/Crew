// GitHub #26: actual MCP subprocesses and HTTP/bridge lifecycle, synthetic
// provider only. No model, microphone, user profile or business repository.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ManagerReview, MANAGER_REVIEW_INTERVAL_MS } from '../runtime/manager/reviews/scheduler.mjs';

const root = fileURLToPath(new URL('../runtime/', import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function temporary(t, cleanup = true) {
  const directory = await mkdtemp(path.join(tmpdir(), 'crew-scratchpad-integration-'));
  if (cleanup) t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
async function rpc(t, stateDir, role, method, params = {}) {
  const child = spawn(process.execPath, [path.join(root, 'orchestration-mcp.mjs'), stateDir, role, ...(role === 'worker' ? ['fixture-task', 'fixture-run'] : [])]);
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); });
  let output = '', errors = '';
  child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => errors += chunk);
  const exit = once(child, 'close');
  child.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) + '\n');
  assert.equal((await exit)[0], 0, errors);
  return JSON.parse(output.trim()).result;
}
async function readPad(t, stateDir) {
  const result = await rpc(t, stateDir, 'manager', 'tools/call', { name: 'read_manager_scratchpad', arguments: {} });
  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
}
async function updatePad(t, stateDir, patch) {
  return rpc(t, stateDir, 'manager', 'tools/call', { name: 'update_manager_scratchpad', arguments: { patchJson: JSON.stringify(patch) } });
}

test('MCP captures four separate explicit commitments, corrects stale notes, persists outcomes and denies worker access', async t => {
  const directory = await temporary(t), stateDir = path.join(directory, 'first'), other = path.join(directory, 'second');
  const manager = await rpc(t, stateDir, 'manager', 'tools/list');
  assert.ok(manager.tools.some(tool => tool.name === 'read_manager_scratchpad'));
  assert.ok(manager.tools.some(tool => tool.name === 'update_manager_scratchpad'));
  const workers = await rpc(t, stateDir, 'worker', 'tools/list');
  assert.equal(workers.tools.some(tool => /scratchpad/.test(tool.name)), false);
  const requests = ['Audit release evidence', 'Review worker result', 'Draft user update', 'Check onboarding'];
  const initial = { expectedRevision: 0, commitments: requests.map((title, i) => ({ id: `request-${i + 1}`, title, status: 'pending' })), notes: ['Old release assumption'], decisions: ['Wait for verified evidence'], questions: ['Which account?'] };
  assert.equal((await updatePad(t, stateDir, initial)).isError, undefined);
  const saved = await readPad(t, stateDir);
  assert.deepEqual(saved.commitments.map(item => item.title), requests);
  assert.deepEqual((await readPad(t, other)).commitments, []);
  for (const name of ['read_manager_scratchpad', 'update_manager_scratchpad']) {
    const denied = await rpc(t, stateDir, 'worker', 'tools/call', { name, arguments: name.startsWith('update') ? { patchJson: JSON.stringify({ expectedRevision: 1, notes: ['Worker overwrite'] }) } : {} });
    assert.equal(denied.isError, true);
  }
  const commitments = saved.commitments.map(item => item.id === 'request-2' ? { ...item, status: 'delegated', nextAction: 'Review matching worker evidence', references: { taskId: 'actual-task', runId: 'actual-run', ticketUrl: 'https://github.com/MattGibney/Crew/issues/26' } } : item);
  assert.equal((await updatePad(t, stateDir, { expectedRevision: 1, commitments, notes: ['Corrected release fact'] })).isError, undefined);
  const corrected = await readPad(t, stateDir);
  assert.equal(corrected.commitments[1].status, 'delegated', 'dispatch is recorded separately from completion');
  assert.deepEqual(corrected.decisions, saved.decisions);
  assert.deepEqual(corrected.questions, saved.questions);
  assert.equal((await updatePad(t, stateDir, { expectedRevision: 1, notes: ['Stale overwrite'] })).isError, true);
  assert.equal((await updatePad(t, stateDir, { expectedRevision: 2, notes: corrected.notes })).isError, undefined);
  assert.deepEqual(await readPad(t, stateDir), corrected, 'separate process reread preserves no-op revision and timestamp');
  const reviewed = corrected.commitments.map(item => item.id === 'request-2' ? { ...item, status: 'completed', outcome: 'Reviewed matching run and passing evidence', nextAction: 'Report verified outcome to the user' } : item);
  assert.equal((await updatePad(t, stateDir, { expectedRevision: 2, commitments: reviewed })).isError, undefined);
  assert.equal((await readPad(t, stateDir)).commitments[1].outcome, 'Reviewed matching run and passing evidence');
  assert.deepEqual((await readPad(t, other)).notes, []);
});

async function httpFixture(t) {
  const directory = await temporary(t, false), dataDir = path.join(directory, 'state'), stateDir = path.join(dataDir, 'orchestration');
  const executable = path.join(directory, 'synthetic-codex.mjs'), callsFile = path.join(directory, 'calls.jsonl'), configPath = path.join(directory, 'config.json');
  const socket = createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening'); const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  await writeFile(callsFile, '');
  await writeFile(path.join(directory, 'manager.md'), 'Synthetic manager instructions'); await writeFile(path.join(directory, 'worker.md'), 'Synthetic worker instructions');
  const config = JSON.parse(await readFile(path.join(root, 'config/fixture.example.json'), 'utf8'));
  config.runtime = { port, codexBinary: executable, dataDir };
  config.project.id = 'scratchpad-integration'; config.project.prompts = { manager: path.join(directory, 'manager.md'), worker: path.join(directory, 'worker.md') };
  await writeFile(configPath, JSON.stringify(config));
  await writeFile(executable, `#!${process.execPath}
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
if (process.argv.includes('--version')) { console.log('codex-cli synthetic'); process.exit(0); }
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
createInterface({ input: process.stdin }).on('line', line => {
 const message = JSON.parse(line); appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(message) + '\\n');
 const {id,method} = message; if(id === undefined || !method) return;
 const reply = result => send({id,result});
 if(method === 'account/read') return reply({account:{type:'chatgpt',planType:'synthetic'}});
 if(method === 'config/read') return reply({config:{}});
 if(method === 'thread/start' || method === 'thread/resume') return reply({thread:{id:'scratchpad-native-chat'}});
 if(method === 'thread/timeline/list') return send({id,error:{code:-32601,message:'Method not found'}});
 if(method === 'thread/turns/list') return reply({data:[]});
 if(method === 'mcpServerStatus/list') return reply({data:[]});
 if(method === 'turn/start') { const turn={id:'synthetic-turn',status:'completed',items:[]}; send({method:'turn/completed',params:{threadId:'scratchpad-native-chat',turn}}); return reply({turn}); }
 return reply({});
});
`, { mode: 0o700 });
  let child, diagnostics = '';
  const streams = new Set();
  const request = async (route, method = 'POST', body = {}) => {
    const response = await fetch(origin + route, { method, headers: { Origin: origin, 'Content-Type': 'application/json' }, ...(method === 'GET' ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, value: await response.json() };
  };
  async function stop() {
    for (const abort of streams) abort.abort(); streams.clear();
    if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
    child = null;
  }
  // Register teardown before the first subprocess/readiness observation.
  t.after(async () => { await stop(); await rm(directory, { recursive: true, force: true }); });
  async function start() {
    diagnostics = '';
    child = spawn(process.execPath, [path.join(root, 'server.mjs')], { cwd: root, env: { ...process.env, AI_MANAGER_CONFIG: configPath, AI_MANAGER_PORT: String(port), AI_MANAGER_CODEX_BINARY: executable, CODEX_BINARY: executable } });
    child.stdout.on('data', data => diagnostics += data); child.stderr.on('data', data => diagnostics += data);
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw Error(`Synthetic server exited: ${diagnostics}`);
      try { if ((await request('/api/settings', 'GET')).status === 200) return; } catch {}
      await delay(30);
    }
    throw Error(`Synthetic server readiness timed out: ${diagnostics}`);
  }
  async function observeRevision(revision, afterConnected) {
    const abort = new AbortController(); streams.add(abort);
    const timeout = setTimeout(() => abort.abort(), 6000);
    try {
      const response = await fetch(origin + '/events', { headers: { Origin: origin }, signal: abort.signal });
      assert.equal(response.status, 200);
      const reader = response.body.getReader();
      await afterConnected?.();
      let buffer = '';
      while (true) {
        const { value, done } = await reader.read(); if (done) throw Error('SSE closed before scratchpad refresh');
        buffer += new TextDecoder().decode(value);
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
          if (!frame.startsWith('data: ')) continue;
          const event = JSON.parse(frame.slice(6));
          if (event.type === 'work-state' && event.state.managerScratchpad?.revision === revision) return event.state;
        }
      }
    } finally { clearTimeout(timeout); abort.abort(); streams.delete(abort); }
  }
  const calls = async () => (await readFile(callsFile, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { stateDir, request, start, stop, observeRevision, calls };
}

test('HTTP state/SSE updates without voice; manager resume consults saved context and explicit Stop survives controller restart', async t => {
  const f = await httpFixture(t);
  await updatePad(t, f.stateDir, { expectedRevision: 0, commitments: [{ id: 'first', title: 'Review authorized result', status: 'pending' }], notes: ['Initial saved fact'] });
  await f.start();
  assert.equal((await f.calls()).length, 0, 'loading project state starts no provider work');
  assert.equal((await f.request('/api/state')).value.managerScratchpad.notes[0], 'Initial saved fact');
  const event = await f.observeRevision(2, async () => {
    const result = await updatePad(t, f.stateDir, { expectedRevision: 1, notes: ['Corrected saved fact'], decisions: ['Keep the scope read-only'] });
    assert.equal(result.isError, undefined);
  });
  assert.deepEqual(event.managerScratchpad.notes, ['Corrected saved fact']);
  assert.equal(event.voiceActive, false);
  assert.equal((await f.calls()).length, 0, 'scratchpad publication never starts a model or voice connection');
  const prepared = await f.request('/api/prepare');
  assert.equal(prepared.status, 200);
  assert.deepEqual(prepared.value.state.managerScratchpad.notes, ['Corrected saved fact'], 'prepare response preserves scratchpad already received through SSE');
  const padFile = path.join(f.stateDir, 'manager-scratchpad.json');
  const validPad = await readFile(padFile, 'utf8');
  await writeFile(padFile, '{broken');
  const stale = (await f.request('/api/state')).value;
  assert.match(stale.managerScratchpadError, /preserved/);
  assert.deepEqual(stale.managerScratchpad.notes, ['Corrected saved fact']);
  await writeFile(padFile, validPad);
  assert.equal((await f.request('/api/state')).value.managerScratchpadError, null);
  const opened = (await f.calls()).find(call => call.method === 'thread/start');
  assert.match(opened.params.developerInstructions, /Corrected saved fact/);
  assert.match(opened.params.developerInstructions, /read_manager_scratchpad/);
  assert.equal((await f.request('/api/manager/lifecycle', 'POST', { action: 'stop' })).status, 200);
  await f.stop(); await f.start();
  assert.equal((await f.request('/api/settings', 'GET')).value.managerLifecycle.state, 'stopped');
  assert.equal((await f.request('/api/prepare')).status, 400);
  const state = (await f.request('/api/state')).value;
  assert.deepEqual(state.managerScratchpad.decisions, ['Keep the scope read-only']);
  assert.equal(state.managerScratchpad.commitments[0].status, 'pending');
  assert.equal((await f.calls()).some(call => call.method === 'turn/start' || /realtime/.test(call.method || '')), false);
  assert.equal((await f.request('/api/manager/lifecycle', 'POST', { action: 'start' })).status, 200);
  assert.match((await f.calls()).findLast(call => call.method === 'thread/resume').params.developerInstructions, /Corrected saved fact/);
});

test('ten-minute review composes with actual HTTP lifecycle: stopped stays stopped, explicit Start enables once, replay stays quiet', async t => {
  const f = await httpFixture(t);
  await updatePad(t, f.stateDir, { expectedRevision: 0, commitments: [{ id: 'review', title: 'Review my explicit authorized request', status: 'pending', nextAction: 'Check the saved evidence' }] });
  await f.start();
  assert.equal((await f.request('/api/manager/lifecycle', 'POST', { action: 'stop' })).status, 200);
  let time = Date.now(), reviewAdmissions = 0;
  const options = {
    stateDir: f.stateDir, now: () => time,
    getSnapshot: async () => {
      const lifecycle = (await f.request('/api/settings', 'GET')).value.managerLifecycle;
      const state = (await f.request('/api/state')).value;
      return { enabled: lifecycle.state === 'running', idle: !state.activeTurnId && !state.workStarting && !state.approvals.length,
        voiceConnected: state.voiceActive || state.voiceConnecting, scratchpad: state.managerScratchpad, tasks: [] };
    },
    runReview: async context => {
      reviewAdmissions++;
      assert.equal(context.commitments[0].id, 'review');
      const response = await f.request('/api/work', 'POST', { text: 'Review only the saved authorized commitment; do not start voice.', requestId: `synthetic-review-${reviewAdmissions}` });
      assert.equal(response.status, 200, JSON.stringify(response.value));
      return { accepted: true };
    },
  };
  const scheduler = new ManagerReview(options);
  time += MANAGER_REVIEW_INTERVAL_MS;
  assert.equal((await scheduler.tick()).reason, 'ineligible');
  assert.equal(reviewAdmissions, 0);
  assert.equal((await f.calls()).some(call => call.method === 'thread/start' || call.method === 'turn/start'), false);
  assert.equal((await f.request('/api/manager/lifecycle', 'POST', { action: 'start' })).status, 200);
  time += MANAGER_REVIEW_INTERVAL_MS;
  assert.equal((await scheduler.tick()).reviewed, true);
  assert.equal(reviewAdmissions, 1);
  const deadline = Date.now() + 3000;
  while ((await f.request('/api/state')).value.activeTurnId && Date.now() < deadline) await delay(20);
  assert.equal((await f.calls()).filter(call => call.method === 'turn/start').length, 1);
  const restarted = new ManagerReview(options);
  time += MANAGER_REVIEW_INTERVAL_MS;
  assert.equal((await restarted.tick()).reason, 'unchanged');
  assert.equal(reviewAdmissions, 1, 'durable checkpoint suppresses repeated unchanged review after restart');
  assert.equal((await f.request('/api/manager/lifecycle', 'POST', { action: 'stop' })).status, 200);
  await updatePad(t, f.stateDir, { expectedRevision: 1, commitments: [{ id: 'review', title: 'Corrected authorized request', status: 'blocked', nextAction: 'Wait for human clarification' }] });
  time += MANAGER_REVIEW_INTERVAL_MS;
  assert.equal((await restarted.tick()).reason, 'ineligible');
  assert.equal(reviewAdmissions, 1, 'a meaningful edit cannot restart an explicitly stopped manager');
  assert.equal((await f.calls()).some(call => /realtime/.test(call.method || '')), false);
});
