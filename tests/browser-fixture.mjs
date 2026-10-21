// Disposable synthetic backend for CUA browser acceptance of the real compiled UI.
// Usage: npm run renderer:build; node tests/browser-fixture.mjs [port=4342]
// This never loads Codex, project configuration, credentials or business repositories.
import http from 'node:http';
import { conversationMessage } from '../conversation.mjs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const port = Number(process.argv[2] || 4342);
const assetsRoot = path.resolve(process.argv[3] || path.join(root, 'renderer-dist'));
const peers = new Set(), mediaPeers = new Set();
const now = new Date().toISOString();
const task = (id, status, extra = {}) => ({ id: `fixture-task-${id}`, runId: `fixture-run-${id}`, ticket: `AI-${140 + id}`, brief: `Review fixture area ${id}`, status, createdAt: now, updatedAt: now, progress: `Examining area ${id} with a bounded read-only check.`, repositoryId: 'fixture', projectId: 'crew-acceptance-fixture', worktree: `/tmp/crew-fixture/w${id}`, attention: [], ...extra });
let orchestration = { maxConcurrent: 6, tasks: [
  task(1, 'running', { workerPromptSnapshot: { text: 'Original fixture worker instructions. Preserve this immutable snapshot.', version: 'fixture-original-v1' }, harnessStarted: true, execution: { runId: 'fixture-run-1', observedAt: now, endedAt: null, startedAt: new Date(Date.now() - 125000).toISOString(), live: true }, environment: { status: 'ready', kind: 'project-execution' } }),
  task(2, 'awaiting_answer', { question: { id: 'question-2', runId: 'fixture-run-2', message: 'Should the audit include archived records?' }, attention: [{ id: 'question-2', kind: 'question', message: 'Should the audit include archived records?' }] }),
  task(3, 'paused'), task(4, 'queued'), task(5, 'launching'), task(6, 'running'),
  task(7, 'completed', { result: { message: 'Read-only fixture verification passed.' }, attention: [{ id: 'result-7', kind: 'completion', message: 'Read-only fixture verification passed.' }] }),
  task(8, 'failed', { failure: 'Fixture environment readiness check failed.' }), task(9, 'stopped'), task(10, 'disposed'),
] };
let work = { threadId: 'fixture-manager', managerConnected: true, status: 'idle', approvals: [], connectors: [{ name: 'linear', status: 'connected' }], items: [], messages: [] };
let workerApprovals = [];
let managerLifecycle = { state: 'running' };
const fixturePrompt = 'You are the Crew fixture manager. Help the user plan work and report verified progress.';
let settings = { projectId: 'crew-acceptance-fixture', projectName: 'Crew acceptance fixture', manager: { saved: { text: fixturePrompt, version: 'manager-1' }, activeVersion: 'manager-1', pendingRestart: false, defaultText: fixturePrompt }, worker: { saved: { text: 'Complete the agreed fixture task and report evidence.', version: 'worker-1' }, defaultText: 'Complete the agreed fixture task and report evidence.' } };
let promptRevision = 1, promptSaveDelay = 0;
let proof = { calls: [], media: null, setup: [] };
const lifecycleView = () => ({ ...managerLifecycle, activeVersion: managerLifecycle.state === 'running' ? settings.manager.activeVersion : null, retainedVersion: settings.manager.activeVersion });
const settingsView = () => ({ ...settings, managerLifecycle: lifecycleView(), manager: { ...settings.manager, activeVersion: lifecycleView().activeVersion, retainedVersion: settings.manager.activeVersion } });
const emit = message => { for (const response of peers) response.write(`data: ${JSON.stringify(message)}\n\n`); };
const sendMedia = message => { for (const response of mediaPeers) response.write(`data: ${JSON.stringify(message)}\n\n`); };
const server = http.createServer(async (req, res) => {
  const send = (value, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
  try {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (url.pathname === '/events' || url.pathname === '/__media-events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' }); res.write(': connected\n\n');
      const set = url.pathname === '/events' ? peers : mediaPeers; set.add(res); if (url.pathname === '/events') res.write(`data: ${JSON.stringify({ type: 'worker-approval-state', requests: workerApprovals })}\n\n`); req.on('close', () => set.delete(res)); return;
    }
    if (url.pathname === '/api/settings' && req.method === 'GET') return send(settingsView());
    if (req.method === 'POST' || req.method === 'PUT') {
      let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 100000) throw Error('Too large'); }
      const body = JSON.parse(raw || '{}');
      if (url.pathname === '/__telemetry') { proof.media = body; return send({ ok: true }); }
      if (url.pathname === '/__setup-proof') { proof.setup.push(body); return send({ ok: true }); }
      if (url.pathname === '/__control') {
        if (Number.isFinite(body.promptSaveDelay)) promptSaveDelay = Math.min(5000, Math.max(0, body.promptSaveDelay));
        if (body.work) { work = { ...work, ...body.work }; emit({ type: 'work-state', state: work }); }
        if (body.orchestration) { orchestration = body.orchestration; emit({ type: 'orchestration-state', state: orchestration }); }
        if (body.workerApprovals) { workerApprovals = body.workerApprovals; emit({ type: 'worker-approval-state', requests: workerApprovals }); }
        if (body.event) emit(body.event);
        if (body.media) sendMedia(body.media);
        if (body.dropEvents) for (const response of peers) response.end();
        return send({ ok: true });
      }
      const name = url.pathname.replace('/api/', ''); proof.calls.push({ name, body });
      if (name === 'settings/prompts') {
        if (promptSaveDelay) await new Promise(resolve => setTimeout(resolve, promptSaveDelay));
        const item = settings[body.role];
        if (!item || typeof body.text !== 'string' || !body.text.trim()) return send({ error: 'Instructions must contain text.' }, 400);
        if (body.expectedVersion !== item.saved.version) return send({ error: 'Saved instructions changed. Your draft is kept.' }, 409);
        item.saved = { text: body.text, version: `${body.role}-${++promptRevision}` };
        if (body.role === 'manager') item.pendingRestart = item.activeVersion !== item.saved.version;
        return send(settingsView());
      }
      if (name === 'manager/lifecycle') {
        managerLifecycle = { state: body.action === 'stop' ? 'stopped' : 'running' };
        if (body.action === 'restart') { settings.manager.activeVersion = settings.manager.saved.version; settings.manager.pendingRestart = false; }
        work = { ...work, activeTurnId: null, status: 'idle' };
        emit({ type: 'manager-lifecycle', state: lifecycleView() }); emit({ type: 'work-state', state: work });
        return send({ managerLifecycle: lifecycleView(), state: work });
      }
      if (name === 'config') return send({ project: { name: 'Crew acceptance fixture', mode: 'fixture', readiness: { ready: true } } });
      if (name === 'prepare') return send({ plan: 'synthetic fixture', state: work });
      if (name === 'state') return send(work);
      if (name === 'orchestration') return send(orchestration);
      if (name === 'voices') return send({ defaultVoice: 'cove', voices: [{ id: 'cove', name: 'Cove' }, { id: 'maple', name: 'Maple' }] });
      if (name === 'connect') return send({ sessionToken: 'synthetic-session', sdp: 'synthetic-answer' });
      if (name === 'work') { work = { ...work, status: 'idle', messages: [...work.messages, conversationMessage({ id: `fixture-user-${proof.calls.length}`, type: 'userMessage', content: [{ type: 'text', text: body.text }] }, `fixture-turn-${proof.calls.length}`), { id: `fixture-${proof.calls.length}`, turnId: `fixture-turn-${proof.calls.length}`, role: 'assistant', text: body.text.startsWith('CREW_WORKER_ACTION') ? 'I received the selected worker action. The controller will report its confirmed outcome here.' : `Fixture manager received: ${body.text}` }] }; emit({ type: 'work-state', state: work }); return send({ accepted: true }); }
      if (name === 'approval') { work = { ...work, approvals: work.approvals.filter(item => item.id !== body.id) }; emit({ type: 'work-state', state: work }); }
      if (name === 'worker-approval') { workerApprovals = workerApprovals.filter(item => item.approvalId !== body.approvalId); emit({ type: 'worker-approval-state', requests: workerApprovals }); return send({ status: 'decided' }); }
      if (name === 'stop-work') { work = { ...work, activeTurnId: null, status: 'idle' }; emit({ type: 'work-state', state: work }); }
      if (['voice-ready', 'voice-status', 'disconnect', 'approval', 'stop-work', 'discuss-attention'].includes(name)) return send({ ok: true });
      return send({ error: `Unknown fixture endpoint ${name}` }, 404);
    }
    if (url.pathname === '/__proof') return send(proof);
    if (url.pathname === '/__state') return send({ work, orchestration });
    if (url.pathname === '/__media.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end(await readFile(path.join(root, 'tests/fixtures/browser-media.js'))); }
    if (url.pathname === '/__setup.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end(await readFile(path.join(root, 'tests/fixtures/browser-setup.js'))); }
    const requested = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = path.resolve(assetsRoot, `.${requested}`);
    if (!file.startsWith(assetsRoot + path.sep)) return send({ error: 'Invalid path' }, 404);
    let data = await readFile(file);
    const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' }[path.extname(file)] || 'application/octet-stream';
    if (file.endsWith('.html')) data = Buffer.from(data.toString().replace('<head>', `<head><script src="${file.endsWith('setup.html') ? '/__setup.js' : '/__media.js'}"></script>`));
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' }); res.end(data);
  } catch (error) { send({ error: error.message }, 400); }
});
server.listen(port, '127.0.0.1', () => process.stdout.write(`Synthetic Crew UI fixture: http://127.0.0.1:${port}\n`));
