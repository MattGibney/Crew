import { constants } from 'node:fs';
import { open, readdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { readTask } from './orchestration-store.mjs';

// Bound private evidence reads; never follow an evidence file symlink outside state.
async function evidenceFile(file, max = 8 * 1024 * 1024) {
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Evidence file is not a regular file');
    if (stat.size > max) throw new Error('Evidence file exceeds the detail read limit');
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const actual = await handle.stat();
      if (!actual.isFile() || actual.size > max) throw new Error('Evidence changed during read');
      const buffer = Buffer.alloc(Math.min(actual.size + 1, max + 1));
      let offset = 0;
      while (offset < buffer.length) { const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset); if (!bytesRead) break; offset += bytesRead; }
      if (offset > actual.size || (await handle.stat()).size > offset) throw new Error('Evidence changed during bounded read');
      return buffer.subarray(0, offset).toString('utf8');
    } finally { await handle.close(); }
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function webUrl(value) {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; }
}
export async function readWorkerDetail(stateDir, taskId, project) {
  const task = await readTask(stateDir, taskId);
  if (project && task.projectId !== project.id && !(project.mode === 'fixture' && !task.projectId)) throw new Error('Task belongs to another project');
  const assignments = task.assignments?.length ? task.assignments : [{ id: 'initial', ticket: task.ticket, brief: task.brief, status: task.status, createdAt: task.createdAt, runIds: [], result: task.result }];
  const assignmentForRun = runId => assignments.find(item => item.runIds?.includes(runId))?.id || null;
  const conversation = (task.history || []).map(item => ({ ...item, assignmentId: item.assignmentId || assignmentForRun(item.runId) || (item.id === 'assignment' ? 'initial' : null) })), notices = [];
  const add = event => { if (!conversation.some(item => item.id === event.id)) conversation.push(event); };
  for (const assignment of assignments) {
    const recorded = conversation.some(item => item.actor === 'manager' && ['instruction', 'assignment', 'followup_assignment'].includes(item.kind) && item.assignmentId === assignment.id && item.message === assignment.brief);
    if (!recorded) add({ id: assignment.id === 'initial' ? 'assignment' : `assignment:${assignment.id}`, actor: 'manager', kind: 'instruction', message: assignment.brief, at: assignment.createdAt, runId: null, assignmentId: assignment.id });
  }
  for (const report of task.reports) add({ id: `report:${report.runId}:${report.reportId}`, actor: 'worker', kind: report.kind, message: report.message, at: report.at, runId: report.runId, assignmentId: report.assignmentId || assignmentForRun(report.runId), evidence: report.evidence || [] });
  if (task.answer) add({ id: `answer:${task.answer.questionId}`, actor: 'manager', kind: 'answer', message: task.answer.text, at: task.answer.at, runId: task.question?.runId || null, assignmentId: assignmentForRun(task.question?.runId), questionId: task.answer.questionId });
  if (!task.historyVersion) notices.push('This task predates durable exchange history. Retained assignment, reports, current answer and available execution records are shown; earlier answers or transitions may be unavailable.');
  const root = path.join(stateDir, 'runs', task.id);
  let runs = [];
  const rootStat = await lstat(root).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (rootStat?.isSymbolicLink()) throw new Error('Worker run directory is not a safe evidence directory');
  try { runs = await readdir(root, { withFileTypes: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const run of runs.filter(item => item.isDirectory() && /^[a-zA-Z0-9_-]{8,160}$/.test(item.name)).sort((a, b) => a.name.localeCompare(b.name))) {
    try {
      const runDir = path.join(root, run.name), configText = await evidenceFile(path.join(runDir, 'config.json'));
      if (!configText) continue;
      const config = JSON.parse(configText);
      if (config.taskId !== task.id || config.runId !== run.name || config.project?.id && config.project.id !== task.projectId) { notices.push(`Uncorrelated run evidence omitted: ${run.name}`); continue; }
      const eventText = await evidenceFile(path.join(runDir, 'events.jsonl'));
      let index = 0;
      for (const line of (eventText || '').split('\n')) {
        index++;
        if (!line.trim()) continue;
        let event; try { event = JSON.parse(line); } catch { continue; } // A trailing in-flight write is retried on refresh.
        if (event.runId && event.runId !== run.name || event.taskId && event.taskId !== task.id) continue;
        const base = { id: `execution:${run.name}:${index}`, actor: 'worker', runId: run.name, assignmentId: config.assignmentId || assignmentForRun(run.name), at: event.at || null };
        if (event.item?.type === 'agent_message' && event.type === 'item.completed' && typeof event.item.text === 'string') add({ ...base, kind: 'reply', message: event.item.text });
        if (event.item?.type === 'command_execution' && typeof event.item.command === 'string') add({ ...base, kind: 'execution', message: event.item.command, status: event.item.status || null, exitCode: event.item.exitCode ?? null });
      }
      if (!conversation.some(event => event.runId === run.name && event.kind === 'execution')) {
        const runtimeText = await evidenceFile(path.join(runDir, 'runtime.json')) || await evidenceFile(path.join(runDir, 'exit.json'));
        if (runtimeText) { const runtime = JSON.parse(runtimeText); if (runtime.runId === run.name) for (const [index, command] of (runtime.commands || []).entries()) if (typeof command.command === 'string') add({ id: `command:${run.name}:${index}`, actor: 'worker', kind: 'execution', message: command.command, exitCode: command.exitCode ?? null, at: null, runId: run.name, assignmentId: config.assignmentId || assignmentForRun(run.name) }); }
      }
      // Older runners retained final visible replies and command records here.
      if (!conversation.some(event => event.runId === run.name && event.kind === 'reply')) {
        const exitText = await evidenceFile(path.join(runDir, 'exit.json'));
        if (exitText) { const exit = JSON.parse(exitText); if (exit.runId === run.name && exit.finalMessage) add({ id: `final:${run.name}`, actor: 'worker', kind: 'reply', message: exit.finalMessage, at: exit.at || null, runId: run.name, assignmentId: config.assignmentId || assignmentForRun(run.name) }); }
      }
    } catch { notices.push(`Some execution evidence could not be read for run ${run.name}; retained reports remain available.`); }
  }
  conversation.sort((a, b) => (Date.parse(a.at) || Date.parse(task.createdAt)) - (Date.parse(b.at) || Date.parse(task.createdAt)));
  const notePath = path.join(stateDir, 'tasks', `${task.id}.notes.md`);
  let markdown = null;
  try { markdown = await evidenceFile(notePath, 60000); } catch { notices.push('Shared work notes could not be read safely.'); }
  const links = [], urls = new Set();
  const addUrl = (candidate, label) => { const url = webUrl(candidate); if (!url || urls.has(url)) return; urls.add(url); links.push({ kind: /github\.com\/.+\/pull\/\d+/.test(url) ? 'pull_request' : /linear\.app\//.test(url) ? 'ticket' : 'resource', label, url }); };
  // Only supplied URLs; never manufacture a ticket URL from a key or a PR from a branch.
  for (const value of [...assignments.map(item => item.ticket), task.ticket, task.ticketUrl, task.pullRequestUrl, ...(task.reports || []).flatMap(report => report.evidence || [])]) {
    if (typeof value !== 'string') continue;
    for (const match of value.matchAll(/https?:\/\/[^\s<>"']+/g)) addUrl(match[0].replace(/[),.;\]]+$/, ''), match[0].replace(/[),.;\]]+$/, ''));
  }
  for (const [key, label] of [['worktree', 'Worker worktree'], ['repositoryPath', 'Repository'], ['runDir', 'Current run evidence']]) if (typeof task[key] === 'string') links.push({ kind: 'local_path', label, path: task[key] });
  links.push({ kind: 'local_path', label: 'Structured orchestration record', path: path.join(stateDir, 'tasks', `${task.id}.json`) });
  return { taskId: task.id, revision: task.revision, assignments, currentAssignmentId: task.currentAssignmentId || 'initial', conversation, notes: { exists: markdown !== null, markdown, path: notePath, updatedAt: task.workNotes?.updatedAt || null, source: 'shared-markdown' }, links, historyNotice: notices.join(' ') || null };
}
