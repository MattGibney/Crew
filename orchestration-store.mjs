import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {snapshotProcesses} from './process-ownership.mjs';
import { promptSnapshot } from './prompt-settings.mjs';

const LIFECYCLE_ACTIONS = new Set(['stop', 'pause', 'resume', 'start', 'dispose']);
const LIFECYCLE_STATES = new Set(['pending', 'processing', 'completed', 'failed']);
const ID = /^[a-zA-Z0-9_-]{8,80}$/;
const REPORT_KINDS = new Set(['progress', 'question', 'result', 'blocked']);
const now = () => new Date().toISOString();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function text(value, name, max = 12000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new Error(`Invalid ${name}`);
  // A narrow safety net, not general secret detection. Never include matches in errors.
  if (/\bsk-[a-zA-Z0-9_-]{20,}\b|\bBearer\s+[a-zA-Z0-9._~+\/-]{12,}={0,2}|-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/i.test(value)) throw new Error(`Secret-like material is not allowed in ${name}`);
  return value;
}
function identifier(value, name = 'task ID') {
  if (typeof value !== 'string' || !ID.test(value)) throw new Error(`Invalid ${name}`);
  return value;
}
const taskPath = (dir, id) => path.join(dir, 'tasks', `${identifier(id)}.json`);
function validate(task, expectedId) {
  if (!task || typeof task !== 'object' || Array.isArray(task) || task.id !== expectedId || !ID.test(task.id)
      || typeof task.ticket !== 'string' || !task.ticket.trim() || task.ticket.length > 120
      || typeof task.brief !== 'string' || !task.brief.trim() || task.brief.length > 12000
      || ['projectId', 'repositoryId'].some(key => task[key] != null && (typeof task[key] !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(task[key])))
      || typeof task.status !== 'string' || !task.status || !Number.isSafeInteger(task.revision) || task.revision < 1
      || !Number.isFinite(Date.parse(task.createdAt)) || !Number.isFinite(Date.parse(task.updatedAt))
      || (task.lifecycleRequests !== undefined && (!Array.isArray(task.lifecycleRequests) || task.lifecycleRequests.some(request => !request || typeof request.id !== 'string' || !ID.test(request.id) || !LIFECYCLE_ACTIONS.has(request.action) || !LIFECYCLE_STATES.has(request.status) || !Number.isFinite(Date.parse(request.at)) || (request.expectedRunId != null && (typeof request.expectedRunId !== 'string' || !request.expectedRunId.trim())))))
      || (task.workerPromptSnapshot !== undefined && (!task.workerPromptSnapshot || typeof task.workerPromptSnapshot.text !== 'string' || task.workerPromptSnapshot.version !== promptSnapshot(task.workerPromptSnapshot.text).version))
      || !Array.isArray(task.reports) || !Array.isArray(task.attention)
      || task.reports.some(r => !r || typeof r.reportId !== 'string' || typeof r.runId !== 'string' || !REPORT_KINDS.has(r.kind) || typeof r.message !== 'string')
      || task.attention.some(a => !a || typeof a.id !== 'string')) throw new Error(`Malformed state for ${expectedId}; refusing to replace it`);
  return task;
}
async function readUnlocked(dir, id) {
  return validate(JSON.parse(await fs.readFile(taskPath(dir, id), 'utf8')), id);
}
async function loadUnlocked(dir) {
  let names;
  try { names = await fs.readdir(path.join(dir, 'tasks')); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const tasks = [];
  for (const name of names.sort()) {
    if (name.endsWith('.json')) tasks.push(await readUnlocked(dir, name.slice(0, -5)));
  }
  return tasks;
}
let processIdentity;
async function ownIdentity(){
  if(!processIdentity)processIdentity=snapshotProcesses().then(rows=>{const identity=rows.get(process.pid);if(!identity)throw new Error('Cannot verify state-lock process identity.');return{pid:process.pid,start:identity.start};}).catch(error=>{processIdentity=null;throw error;});
  return processIdentity;
}
async function lockOwner(lockPath){try{return JSON.parse(await fs.readFile(path.join(lockPath,'owner.json'),'utf8'));}catch(error){if(['ENOENT','ENOTDIR'].includes(error.code))return null;throw error;}}
async function ownerActive(owner){
  if(!owner||!Number.isSafeInteger(owner.pid)||typeof owner.start!=='string'||typeof owner.token!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(owner.token))return true; // unknown is never permission to steal
  if(owner.pid===process.pid)return owner.start===(await ownIdentity()).start;
  try{process.kill(owner.pid,0);}catch(error){if(error.code==='ESRCH')return false;return true;}
  try{const actual=(await snapshotProcesses()).get(owner.pid);return Boolean(actual&&actual.start===owner.start&&!actual.state?.includes('Z'));}catch{return true;}
}
async function lock(dir,name,fn){
  await fs.mkdir(dir,{recursive:true,mode:0o700});
  const lockPath=path.join(dir,name),token=randomUUID(),candidate=`${lockPath}.candidate-${token}`,owner={...await ownIdentity(),token,at:now()};
  // Publish a complete, nonempty owner directory atomically. A process killed
  // before publication leaves only its private candidate, never an empty lock.
  await fs.mkdir(candidate,{mode:0o700});await fs.writeFile(path.join(candidate,'owner.json'),JSON.stringify(owner),{mode:0o600});
  const deadline=Date.now()+5000;let acquired=false;
  try{
    while(!acquired){
      try{await fs.rename(candidate,lockPath);acquired=true;}
      catch(error){
        if(!['EEXIST','ENOTEMPTY','ENOTDIR'].includes(error.code))throw error;
        const previous=await lockOwner(lockPath);
        if(previous&&!await ownerActive(previous)){
          // A deterministic nonempty tombstone prevents two stale observers from
          // renaming a newly acquired lock after the first observer recovered it.
          try{await fs.rename(lockPath,`${lockPath}.stale-${previous.token}`);}catch(recovery){if(!['EEXIST','ENOTEMPTY','ENOENT'].includes(recovery.code))throw recovery;}
          continue;
        }
        if(Date.now()>=deadline)throw new Error(`State lock busy: ${name}; inspect its owner before retrying`);
        await pause(25);
      }
    }
    return await fn();
  }finally{
    if(acquired){const current=await lockOwner(lockPath);if(current?.token!==token)throw new Error(`State lock ownership changed: ${name}; no other lock was removed`);
      // Move the entire lock away before deleting it: removing owner.json in
      // place would briefly create an empty directory another writer can replace.
      const released=`${lockPath}.released-${token}`;await fs.rename(lockPath,released);await fs.rm(released,{recursive:true});
    }else await fs.rm(candidate,{recursive:true,force:true});
  }
}
async function atomic(file, content) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temp, 'wx', 0o600);
    try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temp, file);
  } finally { await fs.unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
async function save(dir, task) {
  validate(task, task.id);
  await fs.mkdir(path.join(dir, 'tasks'), { recursive: true, mode: 0o700 });
  // JSON is authoritative; Markdown is a human-readable projection only.
  await atomic(taskPath(dir, task.id), `${JSON.stringify(task, null, 2)}\n`);
  const lines = [`# ${task.id}`, '', `Ticket: ${task.ticket}`, `Status: ${task.status}`, `Revision: ${task.revision}`, '', 'Project: ' + (task.projectId || 'legacy fixture'), 'Repository: ' + (task.repositoryId || 'fixture'), '', '## Agreed brief', '', task.brief, '', '## Reports', ''];
  for (const report of task.reports) lines.push(`### ${report.kind} (${report.at})`, '', report.message, '', ...(report.evidence || []).map(item => `- ${item}`), '');
  if (task.question) lines.push('## Current question', '', task.question.message, '');
  if (task.answer) lines.push('## Answer', '', task.answer.text, '');
  lines.push('## Attention', '', ...task.attention.map(a => `- ${a.ackedAt ? 'Acknowledged' : 'Pending'}: ${a.message || a.kind || a.id}`), '');
  await atomic(path.join(dir, 'tasks', `${task.id}.md`), lines.join('\n'));
  return task;
}
export async function readTask(dir, id) { return readUnlocked(dir, identifier(id)); }
export async function loadTasks(dir) { return loadUnlocked(dir); }
export async function createTask(dir, { requestId, ticket, brief, projectId = null, repositoryId = null }) {
  for (const [name, value] of Object.entries({ projectId, repositoryId })) if (value !== null && (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(value))) throw new Error(`Invalid ${name}`);
  identifier(requestId); text(ticket, 'ticket', 120); text(brief, 'brief');
  return lock(dir, '.schedule.lock', async () => {
    const tasks = await loadUnlocked(dir);
    const existing = tasks.find(task => task.id === requestId);
    if (existing) {
      if (existing.ticket !== ticket || existing.brief !== brief || (existing.projectId || null) !== projectId || (existing.repositoryId || null) !== repositoryId) throw new Error('Request ID already exists with different ticket or brief');
      return existing;
    }
    return lock(dir, `.${requestId}.lock`, () => save(dir, { id: requestId, ticket, brief, projectId, repositoryId, status: 'queued', revision: 1, createdAt: now(), updatedAt: now(), reports: [], attention: [], lifecycleRequests: [], answer: null }));
  });
}
export async function updateTask(dir, id, fn) {
  identifier(id);
  return lock(dir, '.schedule.lock', () => lock(dir, `.${id}.lock`, async () => {
    const task = await readUnlocked(dir, id);
    const identity = { id: task.id, ticket: task.ticket, brief: task.brief, projectId: task.projectId, repositoryId: task.repositoryId, createdAt: task.createdAt, revision: task.revision, workerPromptSnapshot: task.workerPromptSnapshot ? JSON.stringify(task.workerPromptSnapshot) : null };
    const returned = await fn(task);
    const next = returned === undefined ? task : returned;
    if (!next || next.id !== identity.id || next.ticket !== identity.ticket || next.brief !== identity.brief || next.projectId !== identity.projectId || next.repositoryId !== identity.repositoryId || next.createdAt !== identity.createdAt) throw new Error('Task identity is immutable');
    if (identity.workerPromptSnapshot && JSON.stringify(next.workerPromptSnapshot) !== identity.workerPromptSnapshot) throw new Error('Worker prompt snapshot is immutable');
    if (JSON.stringify(next) === JSON.stringify(await readUnlocked(dir, id))) return next;
    next.revision = identity.revision + 1; next.updatedAt = now();
    validate(next, id);
    return save(dir, next);
  }));
}
export async function reportTask(dir, id, runId, { reportId, kind, message, evidence = [] }) {
  text(runId, 'run ID', 160); text(reportId, 'report ID', 160); text(message, 'message', 12000);
  if (!REPORT_KINDS.has(kind) || !Array.isArray(evidence) || evidence.length > 20) throw new Error('Invalid report kind or evidence');
  evidence.forEach(item => text(item, 'evidence', 2000));
  return updateTask(dir, id, task => {
    if (task.runId !== runId) throw new Error('Stale worker run');
    const existing = task.reports.find(report => report.reportId === reportId && report.runId === runId);
    if (existing) {
      if (existing.kind !== kind || existing.message !== message || JSON.stringify(existing.evidence) !== JSON.stringify(evidence)) throw new Error('Report ID reused with changed content');
      return;
    }
    if (task.reports.some(report => report.runId === runId && ['question', 'blocked', 'result'].includes(report.kind))) throw new Error('Worker run already yielded or finished; wait for controller resume');
    if (task.status !== 'running') throw new Error('Worker is not running');
    if (task.reports.length >= 300) throw new Error('Report limit reached');
    task.reports.push({ reportId, runId, kind, message, evidence, at: now() });
  });
}
export async function answerQuestion(dir, { taskId, questionId, answer }) {
  text(questionId, 'question ID', 160); text(answer, 'answer', 12000);
  return updateTask(dir, taskId, task => {
    if (!task.question || task.question.id !== questionId || task.question.runId !== task.runId) throw new Error('Question is stale or unknown');
    if (task.answer?.questionId === questionId) {
      if (task.answer.text !== answer) throw new Error('Question already answered differently');
      return;
    }
    if (!['awaiting_answer', 'paused', 'stopped'].includes(task.status)) throw new Error('Task is not awaiting this answer');
    if (task.lifecycleRequests?.some(request => ['pending', 'processing'].includes(request.status))) throw new Error('Wait for the pending worker lifecycle action before answering this question');
    task.answer = { questionId, text: answer, at: now() }; task.status = 'resume_queued';
  });
}
export async function acknowledgeAttention(dir, { taskId, attentionId }) {
  text(attentionId, 'attention ID', 160);
  return updateTask(dir, taskId, task => {
    const item = task.attention.find(entry => entry.id === attentionId);
    if (!item) throw new Error('Unknown attention item');
    if (!item.ackedAt) item.ackedAt = now();
  });
}

// Requests are durable intent, not evidence that a process has stopped or restarted.
// The controller alone performs lifecycle transitions and marks each request handled.
export async function requestWorkerAction(dir, { taskId, actionId, action, expectedRunId }) {
  identifier(taskId); identifier(actionId, 'action ID');
  if (!LIFECYCLE_ACTIONS.has(action)) throw new Error('Invalid worker action');
  if (expectedRunId !== undefined && expectedRunId !== null) text(expectedRunId, 'expected run ID', 160);
  return updateTask(dir, taskId, task => {
    const requests = task.lifecycleRequests ||= [];
    const existing = requests.find(request => request.id === actionId);
    if (existing) {
      // An exact retry remains valid even after the controller advances to a new run.
      if (existing.action !== action || (expectedRunId !== undefined && existing.expectedRunId !== expectedRunId)) throw new Error('Action ID reused with changed content');
      return;
    }
    if (expectedRunId !== undefined && (task.runId || null) !== expectedRunId) throw new Error('Stale worker run for lifecycle action');
    if (task.status === 'disposed') throw new Error('Worker has been disposed');
    if (requests.some(request => ['pending', 'processing'].includes(request.status))) throw new Error('Worker already has a pending lifecycle action');
    if (requests.length >= 1000) throw new Error('Worker lifecycle request limit reached');
    requests.push({ id: actionId, action, expectedRunId: task.runId || null, status: 'pending', at: now() });
  });
}
