// GitHub #50: repeatable real-renderer acceptance with synthetic backend/media only.
// Build first. Set CREW_PLAYWRIGHT_MODULE if playwright-core is outside node_modules.
// Optional CREW_BROWSER_EXECUTABLE selects an installed Chromium-family browser.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
const { chromium } = await import(process.env.CREW_PLAYWRIGHT_MODULE || 'playwright-core');
const output = await mkdtemp(path.join(tmpdir(), 'crew-worker-followup-'));
const port = Number(process.env.CREW_ACCEPTANCE_PORT || 4359);
const origin = `http://127.0.0.1:${port}`;
let browser;
const fixture = spawn(process.execPath, ['tests/browser-fixture.mjs', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
// Cleanup is registered before the first wait; this owns only its disposable fixture.
const cleanup = async () => { await browser?.close(); if (fixture.exitCode === null) { fixture.kill('SIGTERM'); await once(fixture, 'exit'); } };
try {
  await new Promise((resolve, reject) => { fixture.stdout.once('data', resolve); fixture.once('error', reject); fixture.once('exit', code => reject(Error(`Fixture exited ${code}`))); });
  browser = await chromium.launch({ headless: true, ...(process.env.CREW_BROWSER_EXECUTABLE ? { executablePath: process.env.CREW_BROWSER_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1400, height: 950 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  const post = body => context.request.post(`${origin}/__control`, { data: body });
  const media = () => page.evaluate(() => ({ calls: window.__crewMedia.calls, stopped: window.__crewMedia.stopped, live: window.__crewMedia.tracks.filter(t => t.readyState === 'live').length, peers: window.__crewMedia.peers.length, connected: window.__crewMedia.peers.filter(p => p.connectionState === 'connected').length }));
  const callCount = async name => (await (await context.request.get(`${origin}/__proof`)).json()).calls.filter(c => c.name === name).length;
  await page.goto(origin);
  await page.getByRole('tab', { name: 'Text', exact: true }).click();
  await page.getByRole('textbox', { name: 'Message your manager', exact: true }).waitFor();
  await page.getByRole('tab', { name: 'Voice', exact: true }).click();
  await page.getByRole('button', { name: 'Connect voice', exact: true }).waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.querySelector('#connect')?.disabled);
  assert.equal((await media()).calls, 0, 'Navigation/startup never asks for media');
  const state = (await (await context.request.get(`${origin}/__state`)).json()).orchestration;
  assert.equal(state.tasks.length, 10);
  const retained = state.tasks.find(task => task.id === 'fixture-task-7');
  retained.currentAssignmentId = 'implementation';
  retained.status = 'running';
  retained.progress = 'Implementing the approved follow-up';
  retained.workflowState = { value: 'Awaiting client feedback', requestId: 'workflow-feedback', actor: 'worker', runId: retained.runId, assignmentId: 'implementation', at: new Date().toISOString() };
  retained.workflowHistory = [retained.workflowState];
  retained.assignments = [
    { id: 'initial', ticket: retained.ticket, brief: 'Research the fixture', status: 'completed', result: { message: 'Original research result retained' }, runIds: ['research-run'] },
    { id: 'implementation', ticket: retained.ticket, brief: 'Implement the approved fixture change', status: 'active', runIds: [retained.runId] },
    { id: 'documentation', ticket: retained.ticket, brief: 'Document the approved fixture behavior', status: 'queued', runIds: [] },
  ];
  await post({ orchestration: state });
  await page.locator('[data-worker-id="fixture-task-7"]').getByText('Implement the approved fixture change', { exact: true }).waitFor();
  await page.getByRole('tab', { name: 'Text', exact: true }).click();
  await page.getByRole('textbox', { name: 'Message your manager', exact: true }).fill('Draft survives disposal');
  await page.getByRole('tab', { name: 'Voice', exact: true }).click();
  await page.getByRole('button', { name: 'Connect voice', exact: true }).click();
  await page.waitForFunction(() => window.__crewMedia.tracks.some(t => t.readyState === 'live'));
  const connected = await media();
  await post({ work: { activeTurnId: 'busy-manager-turn', status: 'working' } });
  await page.getByRole('tab', { name: 'Text', exact: true }).click();
  await page.getByRole('textbox', { name: 'Message your manager', exact: true }).fill('Send this new direction while you are working');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const typedProof = (await (await context.request.get(`${origin}/__proof`)).json()).calls;
  assert.ok(typedProof.some(call => call.name === 'work' && call.body.text === 'Send this new direction while you are working'), 'Typed direction stays available during manager activity');
  await post({ work: { activeTurnId: null, status: 'idle' } });
  await page.locator('[data-worker-id="fixture-task-7"]').click();
  await page.getByRole('tab', { name: 'Overview', exact: true }).click();
  await page.getByRole('heading', { name: 'Queued follow-ups (1)', exact: true }).waitFor();
  await page.getByRole('region', { name: 'Worker detail', exact: true }).getByLabel('Workflow: Awaiting client feedback', { exact: true }).first().waitFor();
  await page.getByRole('region', { name: 'Worker detail', exact: true }).getByLabel('Execution: Working', { exact: true }).first().waitFor();
  const history = page.getByRole('region', { name: 'Assignment history' });
  await history.locator('summary').click();
  await history.getByText('Original research result retained', { exact: true }).waitFor();
  await page.getByRole('tabpanel', { name: 'Overview' }).getByText('Implementing the approved follow-up', { exact: true }).waitFor();
  retained.status = 'completed';
  retained.result = { message: 'Native turn ended; this is not workflow completion' };
  await post({ orchestration: state });
  await page.getByRole('region', { name: 'Worker detail', exact: true }).getByLabel('Execution: Turn ended', { exact: true }).first().waitFor();
  assert.equal(retained.workflowState.value, 'Awaiting client feedback');
  await page.getByRole('region', { name: 'Worker detail', exact: true }).getByLabel('Workflow: Awaiting client feedback', { exact: true }).first().waitFor();
  retained.workflowState = { ...retained.workflowState, value: 'Ready for product review', actor: 'manager', requestId: 'workflow-ready', at: new Date().toISOString() };
  retained.workflowHistory.push(retained.workflowState);
  await post({ orchestration: state });
  await page.getByRole('region', { name: 'Worker detail', exact: true }).getByLabel('Workflow: Ready for product review', { exact: true }).first().waitFor();
  await page.getByRole('region', { name: 'Worker detail', exact: true }).getByLabel('Execution: Turn ended', { exact: true }).first().waitFor();
  await page.screenshot({ path: path.join(output, 'retained-followup-overview.png'), fullPage: true });
  await page.getByRole('button', { name: 'Send direction', exact: true }).click();
  const requests = (await (await context.request.get(`${origin}/__proof`)).json()).calls;
  const discussion = requests.find(call => call.name === 'work' && call.body.text.startsWith('CREW_WORKER_DIRECTION'));
  assert.ok(discussion, 'Send direction creates a manager direction');
  assert.match(discussion.body.text, /"taskId":"fixture-task-7"/);
  assert.doesNotMatch(discussion.body.text, /review_worker_followup|approve_worker_followup|does not authorize execution|explicit scope authorization/i);
  assert.deepEqual(await media(), connected, 'Send direction preserves the same synthetic call');
  await page.locator('[data-worker-id="fixture-task-7"]').click();
  await page.getByRole('tab', { name: 'Overview', exact: true }).click();
  retained.workflowState = { ...retained.workflowState, value: 'Awaiting product and accessibility review of the retained implementation before confirming business readiness' };
  await post({ orchestration: state });
  await page.getByRole('region', { name: 'Worker detail', exact: true }).getByLabel(`Workflow: ${retained.workflowState.value}`, { exact: true }).first().waitFor();
  await page.setViewportSize({ width: 740, height: 900 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Workflow and execution states fit narrow detail');
  await page.screenshot({ path: path.join(output, 'workflow-direction-narrow.png'), fullPage: true });
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log(JSON.stringify({ pass: true, output, syntheticMediaOnly: true, currentAssignmentVisible: true, queuedFollowupVisible: true, assignmentHistoryVisible: true, managerDirectionWithoutReview: true, typedBusyManagerInput: true, explicitWorkflowSeparateFromExecution: true }));
} finally { await cleanup(); }
