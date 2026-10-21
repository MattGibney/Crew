import test from 'node:test';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTask, updateTask, reportTask, answerQuestion, requestWorkerAction, updateWorkNotes } from '../orchestration-store.mjs';
import { readWorkerDetail } from '../worker-detail.mjs';
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
    const child = spawn(process.execPath, [fileURLToPath(new URL('../orchestration-mcp.mjs', import.meta.url)), dir, ...roleArgs], { stdio: ['pipe', 'pipe', 'pipe'] });
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
