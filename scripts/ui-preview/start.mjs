// Local design harness: imports no controller, configuration, auth or worker runtime.
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { scenarios, scenario, notes } from './scenarios.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));
const port = Number(process.env.CREW_PREVIEW_PORT || 4451);
const backendPort = port + 1;
const origin = `http://127.0.0.1:${backendPort}`;
const fixture = spawn(process.execPath, ['tests/browser-fixture.mjs', String(backendPort)], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] });
let vite;
const cleanup = () => { fixture.kill('SIGTERM'); void vite?.close().finally(() => process.exit()); };
process.once('SIGINT', cleanup); process.once('SIGTERM', cleanup); process.once('exit', () => fixture.kill('SIGTERM'));
await new Promise((resolve, reject) => { fixture.stdout.once('data', resolve); fixture.once('error', reject); fixture.once('exit', code => reject(Error(`Fixture exited ${code}`))); });
const control = async body => { const response = await fetch(`${origin}/__control`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); if (!response.ok) throw Error(await response.text()); };
async function reset(name, project) {
  const state = scenario(name, project);
  await control({ resetPreview: true, projectName: project || 'Northstar Studio', ...state });
  await fetch(`${origin}/api/manager/lifecycle`, { method: 'POST', body: JSON.stringify({ action: 'restart' }) });
  // Lifecycle reset clears active turn; restore the selected scenario afterwards.
  await control(state);
  for (const task of state.orchestration.tasks) await control({ workerDetail: { taskId: task.id, conversation: [
    { id: `${task.id}-instruction`, at: task.createdAt, actor: 'manager', kind: 'instruction', message: `Please ${task.brief.toLowerCase()}. Keep the existing photography and bring decisions back before changing anything.`, runId: task.runId },
    { id: `${task.id}-reply`, at: task.createdAt, actor: 'worker', kind: 'reply', message: 'I’m checking the fictional storefront at desktop and mobile sizes. The review is limited to layout, labels and focus behaviour.', runId: task.runId },
    { id: `${task.id}-command`, at: task.createdAt, actor: 'controller', kind: 'command', message: 'Simulated command: npm run test:accessibility\nPreview output: 18 checks passed; one focus-style follow-up proposed.', runId: task.runId },
    { id: `${task.id}-finding`, at: task.createdAt, actor: 'worker', kind: 'progress', message: 'The menu layout is consistent. I’ve recorded the focus-state finding and the archive-link decision in the shared notes.', runId: task.runId },
  ], notes: { exists: true, markdown: notes, path: '/preview/northstar/WORK-NOTES.md', updatedAt: task.createdAt, source: 'Fictional shared Markdown document' }, links: [{ kind: 'ticket', label: `${task.ticket} · fictional review brief`, path: 'Preview resource — no external ticket exists' }, { kind: 'design', label: 'Northstar responsive layout reference', url: `http://127.0.0.1:${port}/?resource=layout` }, { kind: 'worktree', label: 'Simulated worktree', path: task.worktree }], historyNotice: 'Fictional observable exchanges for design review. No real worker has run.' } });
}
await reset(scenarios[0]);
vite = await createServer({ configFile: `${root}vite.config.js`, server: { host: '127.0.0.1', port, strictPort: true, proxy: Object.fromEntries(['/api', '/events', '/__control', '/__telemetry', '/__media-events', '/__proof', '/__state'].map(route => [route, { target: origin }])) }, plugins: [{ name: 'crew-local-design-preview',
  async transformIndexHtml(html) {
    const media = await readFile(`${root}tests/fixtures/browser-media.js`, 'utf8');
    return html.replace('<head>', `<head><script>${media}\nHTMLMediaElement.prototype.play = async function() {}; window.Audio = class { async play() {} pause() {} }; window.open = () => null;</script>`).replace('/src/manager/main.jsx', '/src/preview/main.jsx');
  },
  configureServer(server) {
    server.middlewares.use((req, res, next) => { res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws://127.0.0.1:${port}; media-src 'none'; object-src 'none'; frame-src 'none'`); res.setHeader('Permissions-Policy', 'microphone=(), camera=(), geolocation=()'); next(); });
    server.middlewares.use('/__preview/scenario', async (req, res) => { try { let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 10000) throw Error('Request too large'); } const body = JSON.parse(raw || '{}'); if (!scenarios.includes(body.name)) throw Error('Unknown preview scenario'); await reset(body.name, body.project); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true })); } catch (error) { res.statusCode = 400; res.end(JSON.stringify({ error: error.message })); } });
  },
}] });
await vite.listen();
console.log(`Crew design preview: http://127.0.0.1:${port} — synthetic effects only; Ctrl-C stops both servers.`);
