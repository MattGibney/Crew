import test from 'node:test';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTask, updateTask, reportTask, answerQuestion, requestWorkerAction, updateWorkNotes } from '../runtime/orchestration/store.mjs';
import { readWorkerDetail } from '../runtime/workers/detail.mjs';
const project = { id: 'project-one', mode: 'repository' };
async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'crew-detail-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const id = 'detail-task-one';
  await createTask(dir, { requestId: id, ticket: 'SET-42', brief: 'Inspect the agreed task', projectId: project.id });
  return { dir, id };
}
test('durable correlated exchanges survive question replacement and multiple runs', async t => {
  const { dir, id } = await fixture(t);
  await updateTask(dir, id, task => { task.runId = 'run-one-123'; task.status = 'running'; });
  await reportTask(dir, id, 'run-one-123', { reportId: 'question-one', kind: 'question', message: 'Which cohort?', evidence: [] });
  await updateTask(dir, id, task => { task.question = { id: 'question-one', runId: task.runId }; task.status = 'awaiting_answer'; });
  await answerQuestion(dir, { taskId: id, questionId: 'question-one', answer: 'Use the agreed October cohort' });
  await updateTask(dir, id, task => { task.runId = 'run-two-123'; task.question = null; task.answer = null; task.status = 'running'; });
  await reportTask(dir, id, 'run-two-123', { reportId: 'progress-two', kind: 'progress', message: 'Verified the cohort', evidence: [] });
  await requestWorkerAction(dir, { taskId: id, actionId: 'pause-request-123', action: 'pause', expectedRunId: 'run-two-123' });
  const detail = await readWorkerDetail(dir, id, project);
  assert.equal(detail.historyNotice, null);
  assert.equal(detail.conversation.find(event => event.kind === 'answer').runId, 'run-one-123');
  assert.equal(detail.conversation.find(event => event.kind === 'question').message, 'Which cohort?');
  assert.equal(detail.conversation.filter(event => event.kind === 'progress').length, 1);
  assert.equal(detail.conversation.find(event => event.kind === 'lifecycle_request').actor, 'manager');
  assert.equal(detail.notes.exists, false);
  await updateTask(dir, id, task => { task.lifecycleRequests.at(-1).status = 'completed'; });
  await requestWorkerAction(dir, { taskId: id, actionId: 'update-pause-123', action: 'pause', cooperative: true, expectedRunId: 'run-two-123' });
  assert.equal((await readWorkerDetail(dir, id, project)).conversation.find(event => event.id === 'action:update-pause-123').actor, 'controller');
  await assert.rejects(updateTask(dir, id, task => { task.history = []; }), /history is immutable/);
  assert.equal(detail.links.some(link => link.url?.includes('SET-42')), false);
  await assert.rejects(readWorkerDetail(dir, id, { id: 'another-project' }), /another project/);
});
test('shared prose is an actual separate Markdown document, scoped and idempotent', async t => {
  const { dir, id } = await fixture(t);
  await updateTask(dir, id, task => { task.runId = 'notes-run-123'; task.status = 'running'; });
  const note = { updateId: 'notes-revision-one', markdown: '# Findings\n\nActual observed findings.', runId: 'notes-run-123' };
  await updateWorkNotes(dir, id, note);
  await updateWorkNotes(dir, id, note);
  await assert.rejects(updateWorkNotes(dir, id, { ...note, markdown: 'Changed retry' }), /reused/);
  await assert.rejects(updateWorkNotes(dir, id, { ...note, runId: 'stale-run' }), /Stale/);
  const detail = await readWorkerDetail(dir, id, project);
  assert.equal(detail.notes.markdown, note.markdown);
  assert.equal(await readFile(detail.notes.path, 'utf8'), note.markdown);
  assert.notEqual(await readFile(path.join(dir, 'tasks', `${id}.md`), 'utf8'), note.markdown);
  assert.equal(detail.conversation.filter(event => event.kind === 'notes').length, 1);
});
test('visible worker events refresh live, exclude reasoning and unrelated runs, expose actual links only', async t => {
  const { dir, id } = await fixture(t), runId = 'event-run-123';
  const runDir = path.join(dir, 'runs', id, runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, 'config.json'), JSON.stringify({ taskId: id, runId, project }));
  const events = [
    { type: 'item.completed', item: { type: 'agent_message', text: 'Observed visible reply' } },
    { type: 'item.completed', item: { type: 'reasoning', text: 'PRIVATE REASONING' } },
    { type: 'item.completed', taskId: 'another-task', item: { type: 'agent_message', text: 'Unrelated message' } },
    { type: 'item.completed', item: { type: 'command_execution', command: 'npm test', status: 'completed', exitCode: 0 } },
  ];
  await writeFile(path.join(runDir, 'events.jsonl'), events.map(event => JSON.stringify(event)).join('\n'));
  await updateTask(dir, id, task => { task.runId = runId; task.status = 'running'; task.worktree = '/tmp/actual worktree'; });
  await reportTask(dir, id, runId, { reportId: 'links-report', kind: 'progress', message: 'Linked actual resources', evidence: ['https://github.com/example/repo/pull/12', 'https://linear.app/example/issue/SET-42/task', 'javascript:alert(1)', 'https://secret:password@example.com/private'] });
  let detail = await readWorkerDetail(dir, id, project);
  assert.equal(detail.conversation.some(event => event.message === 'PRIVATE REASONING' || event.message === 'Unrelated message'), false);
  assert.equal(detail.conversation.find(event => event.kind === 'execution').exitCode, 0);
  assert.deepEqual(detail.links.filter(link => link.url).map(link => link.kind), ['pull_request', 'ticket']);
  events.push({ type: 'item.completed', at: new Date().toISOString(), item: { type: 'agent_message', text: 'New live reply' } });
  await writeFile(path.join(runDir, 'events.jsonl'), events.map(event => JSON.stringify(event)).join('\n'));
  detail = await readWorkerDetail(dir, id, project);
  assert.equal(detail.conversation.at(-1).message, 'New live reply');
  await writeFile(path.join(runDir, 'config.json'), JSON.stringify({ taskId: 'another-task', runId, project }));
  detail = await readWorkerDetail(dir, id, project);
  assert.equal(detail.conversation.some(event => event.kind === 'reply'), false);
  assert.match(detail.historyNotice, /Uncorrelated/);
});
test('legacy records are recovered truthfully and note symlinks are never followed', async t => {
  const { dir, id } = await fixture(t), file = path.join(dir, 'tasks', `${id}.json`);
  const task = JSON.parse(await readFile(file, 'utf8')); delete task.history; delete task.historyVersion;
  await writeFile(file, JSON.stringify(task));
  const outside = path.join(dir, 'private.md'); await writeFile(outside, 'PRIVATE FILE');
  await symlink(outside, path.join(dir, 'tasks', `${id}.notes.md`));
  const detail = await readWorkerDetail(dir, id, project);
  assert.match(detail.historyNotice, /predates durable/);
  assert.match(detail.historyNotice, /notes could not/);
  assert.equal(detail.notes.exists, false);
  assert.equal(detail.conversation[0].message, task.brief);
});

test('MCP shared notes are bound to exact worker run and manager project', async t => {
  const { spawn } = await import('node:child_process');
  const { dir, id } = await fixture(t);
  await updateTask(dir, id, task => { task.runId = 'notes-mcp-run'; task.status = 'running'; });
  async function call(roleArgs, args) {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../runtime/orchestration-mcp.mjs', import.meta.url)), dir, ...roleArgs], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', stderr = ''; child.stdout.on('data', value => output += value); child.stderr.on('data', value => stderr += value);
    const closed = new Promise(resolve => child.on('close', resolve));
    child.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'update_work_notes', arguments: args } }) + '\n');
    assert.equal(await closed, 0, stderr); return JSON.parse(output).result;
  }
  const args = { updateId: 'mcp-notes-one', markdown: '# Observations\n\nTask-linked evidence.' };
  assert.equal((await call(['worker', id, 'stale-worker-run'], args)).isError, true);
  assert.equal((await call(['worker', id, 'notes-mcp-run'], args)).isError, undefined);
  const runtime = path.join(dir, 'other-runtime.json'); await writeFile(runtime, JSON.stringify({ project: { id: 'unrelated-project', mode: 'repository' } }));
  assert.equal((await call(['manager', runtime], { ...args, taskId: id })).isError, true);
  assert.equal((await readWorkerDetail(dir, id, project)).notes.markdown, args.markdown);
});

test('app-server normalized replies and commands stay visible across live refresh and terminal fallback', async t => {
  const { dir, id } = await fixture(t), runId = 'native-detail-run-123';
  const runDir = path.join(dir, 'runs', id, runId), threadId = 'native-thread-one', turnId = 'native-turn-one';
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, 'config.json'), JSON.stringify({ taskId: id, runId, project }));
  await updateTask(dir, id, task => { task.runId = runId; task.status = 'running'; task.threadId = threadId; });
  const at = new Date().toISOString();
  // This is the bounded visible envelope emitted by the app-server runner;
  // private native reasoning/content is intentionally absent from the envelope.
  const visible = item => ({ taskId: id, runId, at, type: 'item.completed', nativeMethod: 'item/completed', turnId, item });
  const events = [
    visible({ id: 'native-before', type: 'agent_message', text: 'Before the approved command' }),
    visible({ id: 'native-command', type: 'command_execution', command: '/bin/echo native-result', status: 'completed', exitCode: 0 }),
    visible({ id: 'native-reasoning', type: 'reasoning', status: 'completed' }),
    { ...visible({ type: 'agent_message', text: 'Wrong run reply' }), runId: 'unrelated-run' },
    { ...visible({ type: 'agent_message', text: 'Wrong task reply' }), taskId: 'unrelated-task' },
  ];
  const eventFile = path.join(runDir, 'events.jsonl');
  await writeFile(eventFile, events.map(JSON.stringify).join('\n') + '\n{"inFlight":');
  let detail = await readWorkerDetail(dir, id, project);
  assert.deepEqual(detail.conversation.filter(row => row.kind === 'reply').map(row => row.message), ['Before the approved command']);
  assert.deepEqual(detail.conversation.filter(row => row.kind === 'execution').map(row => [row.message, row.exitCode, row.runId]), [['/bin/echo native-result', 0, runId]]);
  events.push(visible({ id: 'native-after', type: 'agent_message', text: 'After the approved command' }));
  events.push(visible({ id: 'native-final', type: 'agent_message', text: 'Final visible result' }));
  await writeFile(eventFile, events.map(JSON.stringify).join('\n') + '\n');
  await writeFile(path.join(runDir, 'exit.json'), JSON.stringify({ runId, threadId, finalMessage: 'Final visible result', commands: [{ command: '/bin/echo native-result', exitCode: 0 }], at }));
  await reportTask(dir, id, runId, { reportId: 'native-result', kind: 'result', message: 'Durable result evidence', evidence: ['Observed native-result output'] });
  await updateTask(dir, id, task => { task.status = 'completed'; });
  detail = await readWorkerDetail(dir, id, project);
  assert.deepEqual(detail.conversation.filter(row => row.kind === 'reply').map(row => row.message), ['Before the approved command', 'After the approved command', 'Final visible result']);
  assert.equal(detail.conversation.filter(row => row.kind === 'execution').length, 1);
  assert.equal(detail.conversation.filter(row => row.kind === 'result' && row.message === 'Durable result evidence').length, 1);
  assert.ok(detail.conversation.filter(row => ['reply', 'execution', 'result'].includes(row.kind)).every(row => row.runId === runId));
  assert.equal(detail.conversation.some(row => /Wrong run|Wrong task|reasoning/.test(row.message)), false);
  assert.equal(detail.historyNotice, null);
});

test('repeated assignments retain their briefs, results and run correlation in worker details', async t => {
  const { dir, id } = await fixture(t), file = path.join(dir, 'tasks', `${id}.json`);
  const task = JSON.parse(await readFile(file, 'utf8'));
  const at = Date.parse(task.createdAt);
  task.currentAssignmentId = 'followup-two';
  task.assignments = [
    { id: 'initial', ticket: task.ticket, brief: task.brief, status: 'completed', createdAt: task.createdAt, runIds: ['research-run-123'], result: { message: 'Research findings retained' } },
    { id: 'followup-one', ticket: 'https://github.com/example/repo/issues/42', brief: 'Implement approved behavior', userDecision: 'I explicitly authorize this implementation', status: 'completed', createdAt: new Date(at + 1000).toISOString(), runIds: ['implementation-run-123'], result: { message: 'Implementation result retained' } },
    { id: 'followup-two', ticket: 'GH-42', brief: 'Document approved behavior', userDecision: 'I explicitly authorize these documentation edits', status: 'active', createdAt: new Date(at + 2000).toISOString(), runIds: ['documentation-run-123'] },
  ];
  task.reports = [{ runId: 'implementation-run-123', reportId: 'implementation-result', kind: 'result', message: 'Implementation result retained', at: new Date(at + 1500).toISOString() }];
  await writeFile(file, JSON.stringify(task));
  const runDir = path.join(dir, 'runs', id, 'documentation-run-123');
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, 'config.json'), JSON.stringify({ taskId: id, runId: 'documentation-run-123', assignmentId: 'followup-two', project }));
  await writeFile(path.join(runDir, 'events.jsonl'), JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Documenting the change' } }));
  const detail = await readWorkerDetail(dir, id, project);
  assert.equal(detail.currentAssignmentId, 'followup-two');
  assert.deepEqual(detail.assignments.map(item => item.result?.message), ['Research findings retained', 'Implementation result retained', undefined]);
  assert.deepEqual(detail.conversation.filter(item => item.kind === 'instruction').map(item => item.message), task.assignments.map(item => item.brief));
  assert.equal(detail.conversation.find(item => item.reportId === 'implementation-result' || item.message === 'Implementation result retained').assignmentId, 'followup-one');
  assert.equal(detail.conversation.find(item => item.message === 'Documenting the change').assignmentId, 'followup-two');
  assert.ok(detail.links.some(item => item.url === 'https://github.com/example/repo/issues/42'));
  await rm(path.join(runDir, 'events.jsonl'));
  await writeFile(path.join(runDir, 'exit.json'), JSON.stringify({ runId: 'documentation-run-123', finalMessage: 'Legacy final reply' }));
  const legacyDetail = await readWorkerDetail(dir, id, project);
  assert.equal(legacyDetail.conversation.find(item => item.message === 'Legacy final reply').assignmentId, 'followup-two');
});
