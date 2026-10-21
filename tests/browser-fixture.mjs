// Disposable synthetic backend for CUA browser acceptance of the real compiled UI.
// Usage: npm run renderer:build; node tests/browser-fixture.mjs [port=4342]
// This never loads Codex, project configuration, credentials or business repositories.
import http from 'node:http';
import { isArchivedTask } from '../worker-archive.mjs';
import {validateWorkerEnvironment} from '../config.mjs';
import { conversationMessage } from '../conversation.mjs';
import { createConversationTimeline } from '../conversation-timeline.mjs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const port = Number(process.argv[2] || 4342);
const assetsRoot = path.resolve(process.argv[3] || path.join(root, 'renderer-dist'));
const peers = new Set(), mediaPeers = new Set();
const now = new Date().toISOString();
const task = (id, status, extra = {}) => ({ id: `fixture-task-${id}`, runId: `fixture-run-${id}`, ticket: `AI-${140 + id}`, brief: `Review fixture area ${id}`, status, createdAt: now, updatedAt: now, revision: 1, progress: `Examining area ${id} with a bounded read-only check.`, repositoryId: 'fixture', projectId: 'crew-acceptance-fixture', worktree: `/tmp/crew-fixture/w${id}`, attention: [], ...extra });
let orchestration = { maxConcurrent: 6, tasks: [
  task(1, 'running', { workerPromptSnapshot: { text: 'Original fixture worker instructions. Preserve this immutable snapshot.', version: 'fixture-original-v1' }, harnessStarted: true, execution: { runId: 'fixture-run-1', observedAt: now, endedAt: null, startedAt: new Date(Date.now() - 125000).toISOString(), live: true }, environment: { status: 'ready', kind: 'project-execution' } }),
  task(2, 'awaiting_answer', { question: { id: 'question-2', runId: 'fixture-run-2', message: 'Should the audit include archived records?' }, attention: [{ id: 'question-2', kind: 'question', message: 'Should the audit include archived records?' }] }),
  task(3, 'paused'), task(4, 'queued'), task(5, 'launching'), task(6, 'running'),
  task(7, 'completed', { result: { message: 'Read-only fixture verification passed.' }, attention: [{ id: 'result-7', kind: 'completion', message: 'Read-only fixture verification passed.' }] }),
  task(8, 'failed', { failure: 'Fixture environment readiness check failed.' }), task(9, 'stopped'), task(10, 'disposed'),
] };
let detailRevision = 1;
const workerDetails = new Map(orchestration.tasks.map(item => [item.id, {
  taskId: item.id, revision: detailRevision,
  conversation: [
    { id: `${item.id}-dispatch`, at: now, actor: 'manager', kind: 'instruction', message: `Inspect fixture area ${item.id.split('-').at(-1)} and report verified evidence.`, runId: item.runId, evidence: ['Persisted synthetic dispatch'] },
    { id: `${item.id}-progress`, at: now, actor: 'worker', kind: 'progress', message: item.progress, runId: item.runId, evidence: ['Persisted synthetic report'] },
  ],
  notes: item.id === 'fixture-task-1' ? { exists: true, markdown: '# Area 1 work notes\n\nVerified the synthetic fixture source.\n\n- Next: review the observed boundary.', path: '/tmp/crew-fixture/w1/WORK-NOTES.md', updatedAt: now, source: 'Task-owned shared Markdown' } : { exists: false, markdown: '', path: null, updatedAt: null, source: null },
  links: item.id === 'fixture-task-1' ? [{ kind: 'ticket', label: 'AI-141 fixture ticket', url: 'https://linear.app/crew-fixture/issue/AI-141' }, { kind: 'pull-request', label: 'Fixture pull request', url: 'https://github.com/example/crew-fixture/pull/1' }, { kind: 'worktree', label: 'Worktree', path: item.worktree }] : [],
  historyNotice: 'Synthetic persisted observable events; no hidden reasoning is available.',
}]));
let work = { threadId: 'fixture-manager', managerConnected: true, status: 'idle', approvals: [], connectors: [{ name: 'linear', status: 'connected' }], items: [], messages: [] };
let workerApprovals = [];
let conversation = createConversationTimeline();
const conversationChanged = () => { work = { ...work, messages: conversation.snapshot() }; emit({ type: 'work-state', state: work }); };
let managerLifecycle = { state: 'running' };
const fixturePrompt = 'You are the Crew fixture manager. Help the user plan work and report verified progress.';
let settings = { projectId: 'crew-acceptance-fixture', projectName: 'Crew acceptance fixture', manager: { saved: { text: fixturePrompt, version: 'manager-1' }, activeVersion: 'manager-1', pendingRestart: false, defaultText: fixturePrompt }, worker: { saved: { text: 'Complete the agreed fixture task and report evidence.', version: 'worker-1' }, defaultText: 'Complete the agreed fixture task and report evidence.' } };
let promptRevision = 1, promptSaveDelay = 0;
const initialSettings = structuredClone(settings);
let fixtureProjectName = 'Crew acceptance fixture';
let designPreview = false;
const managerProfiles = new Map();
const profileView = () => managerProfiles.get(fixtureProjectName) || { voice: null, version: 'profile-0' };
let nativeAttentionSound = false;

let proof = { calls: [], media: null, setup: [], sseConnections: 0 };
const lifecycleView = () => ({ ...managerLifecycle, activeVersion: managerLifecycle.state === 'running' ? settings.manager.activeVersion : null, retainedVersion: settings.manager.activeVersion });
let workerEnvironment = {revision:'environment-0',configPath:'/private/tmp/crew-fixture/config.json',environment:{},available:true};
const settingsView = () => ({ ...settings, workerEnvironment, managerProfile: profileView(), managerLifecycle: lifecycleView(), manager: { ...settings.manager, activeVersion: lifecycleView().activeVersion, retainedVersion: settings.manager.activeVersion } });
const emit = message => { for (const response of peers) response.write(`data: ${JSON.stringify(message)}\n\n`); };
const sendMedia = message => { for (const response of mediaPeers) response.write(`data: ${JSON.stringify(message)}\n\n`); };
const server = http.createServer(async (req, res) => {
  const send = (value, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
  try {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (url.pathname === '/events' || url.pathname === '/__media-events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' }); res.write(': connected\n\n');
      const set = url.pathname === '/events' ? peers : mediaPeers; set.add(res); if (url.pathname === '/events') { proof.sseConnections++; res.write(`data: ${JSON.stringify({ type: 'work-state', state: work })}\n\n`); res.write(`data: ${JSON.stringify({ type: 'worker-approval-state', requests: workerApprovals })}\n\n`); } req.on('close', () => set.delete(res)); return;
    }
    const workerMatch = url.pathname.match(/^\/api\/workers\/([^/]+)$/);
    if (workerMatch && req.method === 'GET') return workerDetails.has(decodeURIComponent(workerMatch[1])) ? send(workerDetails.get(decodeURIComponent(workerMatch[1]))) : send({ error: 'Worker not found in this project.' }, 404);
    if (url.pathname === '/api/settings' && req.method === 'GET') return send(settingsView());
    if (req.method === 'POST' || req.method === 'PUT') {
      let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 100000) throw Error('Too large'); }
      const body = JSON.parse(raw || '{}');
      if (url.pathname === '/__telemetry') { proof.media = body; return send({ ok: true }); }
      if (url.pathname === '/__setup-proof') { proof.setup.push(body); return send({ ok: true }); }
      if (url.pathname === '/__control') {
        // Explicit design-preview reset affects this disposable fixture only.
        if (body.resetPreview) { designPreview = true; conversation = createConversationTimeline(); settings = structuredClone(initialSettings); promptRevision = 1; }
        if (typeof body.projectName === 'string') { fixtureProjectName = body.projectName; settings.projectName = body.projectName; }
        if (Number.isFinite(body.promptSaveDelay)) promptSaveDelay = Math.min(5000, Math.max(0, body.promptSaveDelay));
        if (typeof body.nativeAttentionSound === 'boolean') nativeAttentionSound = body.nativeAttentionSound;

        if (body.workerEnvironment) workerEnvironment = {...workerEnvironment,environment:body.workerEnvironment,revision:`environment-${++promptRevision}`};
        if (body.workerDetail) {
          const { taskId, ...change } = body.workerDetail;
          if (!workerDetails.has(taskId)) return send({ error: 'Unknown fixture worker' }, 400);
          workerDetails.set(taskId, { ...workerDetails.get(taskId), ...change, taskId, revision: ++detailRevision });
          emit({ type: 'orchestration-state', state: orchestration });
        }
        if (body.work) { if (body.work.messages) conversation.restore(body.work.messages); work = { ...work, ...body.work }; emit({ type: 'work-state', state: work }); }
        if (body.orchestration) { orchestration = body.orchestration; emit({ type: 'orchestration-state', state: orchestration }); }
        if (body.protocol) {
          const { method, params = {} } = body.protocol;
          if (method === 'thread/realtime/item/started' || method === 'thread/realtime/item/completed') conversation.realtime(params.item, { status: method.endsWith('/started') ? 'streaming' : 'complete' });
          if (method === 'thread/realtime/item/transcript/delta' || method === 'item/agentMessage/delta') conversation.delta(params.itemId, params.delta);
          if (method === 'item/started' || method === 'item/completed') conversation.record(params.item, params.turnId, { status: method === 'item/started' ? 'streaming' : 'complete' });
          if (method === 'thread/realtime/closed') conversation.partial();
          conversationChanged();
        }
        if (body.workerApprovals) { workerApprovals = body.workerApprovals; emit({ type: 'worker-approval-state', requests: workerApprovals }); }
        if (body.event) {
          if (body.event.type === 'transcript-delta' || body.event.type === 'transcript-done') { conversation.flat(body.event.role, body.event.text, { done: body.event.type === 'transcript-done' }); conversationChanged(); }
          emit(body.event);
        }
        if (body.media) sendMedia(body.media);
        if (body.dropEvents) for (const response of peers) response.end();
        return send({ ok: true });
      }
      const name = url.pathname.replace('/api/', ''); proof.calls.push({ name, body });
      if (name === 'archived-worker-action') {
        // Fixture-only projection mutation. Production store/ownership tests cover real deletion.
        const target = orchestration.tasks.find(task => task.id === body.taskId);
        if (!target || target.projectId !== settings.projectId || !isArchivedTask(target)) return send({ error: 'Archived worker not found in this project.' }, 409);
        if (!Number.isInteger(body.expectedRevision) || body.expectedRevision !== target.revision || typeof body.operationId !== 'string' || !body.operationId.startsWith('archive-')) return send({ error: 'Archived worker changed. Refresh before retrying.' }, 409);
        if (body.action === 'restore') {
          const at = new Date().toISOString();
          target.status = 'blocked';
          target.failure = 'Restored archive history. Its environment was removed or is unavailable; review retained resources before explicit recovery. No worker or setup was started.';
          target.archiveRestoration = { operationId: body.operationId, at, requiresRecovery: true, archiveRevision: body.expectedRevision };
          target.archiveRestorations = [...(target.archiveRestorations || []), target.archiveRestoration];
          target.attention = (target.attention || []).map(item => item.ackedAt ? item : { ...item, ackedAt: at, resolution: 'Historical attention retained from archived worker' });
          if (target.question) { target.archivedQuestions = [...(target.archivedQuestions || []), target.question]; target.question = null; }
          target.revision++; target.updatedAt = at;
          emit({ type: 'orchestration-state', state: orchestration });
          return send({ taskId: target.id, action: 'restore', status: 'restored' });
        }
        if (body.action !== 'delete') return send({ error: 'Unknown archive action.' }, 409);
        orchestration = { ...orchestration, tasks: orchestration.tasks.filter(task => task.id !== target.id) };
        workerDetails.delete(target.id);
        emit({ type: 'orchestration-state', state: orchestration });
        return send({ taskId: target.id, action: 'delete', status: 'deleted' });
      }
      if (name === 'updates') return send({ phase: 'unsupported', message: 'Synthetic fixture; no update checks.' });
      if (name === 'settings/worker-environment') {
        if (body.expectedRevision !== workerEnvironment.revision) return send({error:'Environment settings changed elsewhere; reload before saving.'},400);
        workerEnvironment = {...workerEnvironment,environment:validateWorkerEnvironment(body.environment,{mode:'repository'}),revision:`environment-${++promptRevision}`};
        return send(settingsView());
      }
      if (name === 'settings/manager-profile') {
        if (body.expectedVersion !== profileView().version) return send({ error: 'Manager profile changed elsewhere.' }, 409);
        managerProfiles.set(fixtureProjectName, { voice: body.voice, version: `profile-${++promptRevision}` });
        return send(settingsView());
      }
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
      if (name === 'config') return send({ nativeAttentionSound, project: { name: fixtureProjectName, mode: 'fixture', readiness: { ready: true } } });
      if (name === 'prepare') return send({ plan: 'synthetic fixture', state: work });
      if (name === 'state') return send(work);
      if (name === 'orchestration') return send(orchestration);
      if (name === 'voices') return send({ defaultVoice: 'cove', voices: [{ id: 'cove', name: 'Cove' }, { id: 'maple', name: 'Maple' }] });
      if (name === 'connect') return send({ sessionToken: 'synthetic-session', sdp: 'synthetic-answer' });
      if (name === 'work') {
        const id = proof.calls.length, turnId = `fixture-turn-${id}`;
        if (designPreview && body.text.startsWith('CREW_WORKER_ACTION')) {
          const selected = body.text.match(/selected worker only: (\{[^\n]+?\})\./);
          const action = selected ? JSON.parse(selected[1]) : null;
          const target = orchestration.tasks.find(task => task.id === action?.taskId && task.runId === action.expectedRunId);
          if (target) {
            target.status = ({ pause: 'paused', stop: 'stopped', resume: 'running', dispose: 'disposed' })[action.action] || target.status;
            if (target.execution) target.execution = { ...target.execution, live: action.action === 'resume', observedAt: new Date().toISOString(), endedAt: action.action === 'resume' ? null : new Date().toISOString() };
            emit({ type: 'orchestration-state', state: orchestration });
          }
        }
        conversation.record({ id: `fixture-user-${id}`, type: 'userMessage', content: [{ type: 'text', text: body.text }] }, turnId);
        conversation.record({ id: `fixture-${id}`, type: 'agentMessage', text: body.text.startsWith('CREW_WORKER_ACTION') ? designPreview ? 'Preview only: the selected worker state has been simulated. No process or worktree was changed.' : 'I received the selected worker action. The controller will report its confirmed outcome here.' : `Fixture manager received: ${body.text}` }, turnId);
        work = { ...work, status: 'idle' }; conversationChanged(); return send({ accepted: true });
      }
      if (name === 'approval') { work = { ...work, approvals: work.approvals.filter(item => item.id !== body.id) }; emit({ type: 'work-state', state: work }); }
      if (name === 'worker-approval') { workerApprovals = workerApprovals.filter(item => item.approvalId !== body.approvalId); emit({ type: 'worker-approval-state', requests: workerApprovals }); return send({ status: 'decided' }); }
      if (name === 'stop-work') { work = { ...work, activeTurnId: null, status: 'idle' }; emit({ type: 'work-state', state: work }); }
      if (name === 'discuss-attention' && designPreview) {
        const item = orchestration.tasks.find(task => task.id === body.taskId)?.attention.find(item => item.id === body.attentionId);
        if (item) { conversation.record({ id: `preview-question-${body.attentionId}`, type: 'agentMessage', text: `Preview worker question: ${item.message}` }, 'preview-review'); conversationChanged(); }
      }
      if (['voice-ready', 'voice-status', 'disconnect', 'approval', 'stop-work', 'discuss-attention'].includes(name)) return send({ ok: true });
      return send({ error: `Unknown fixture endpoint ${name}` }, 404);
    }
    if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
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
