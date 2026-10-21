#!/usr/bin/env node
import readline from 'node:readline';
import { ManagerScratchpad } from './manager-scratchpad.mjs';
import path from 'node:path';
import { readFile, realpath } from 'node:fs/promises';
import { createTask, readTask, loadTasks, reportTask, answerQuestion, acknowledgeAttention, requestWorkerAction, updateWorkNotes } from './orchestration-store.mjs';
import { requestWorkerRecovery } from './orchestration-store.mjs';
import { reviewProjectRecovery } from './project-environment.mjs';
import { listWorkerRequests, decideWorkerRequest } from './worker-approvals.mjs';
import { requestWorkerModel, requestWorkerFollowup, requestWorkerFollowupAdoption, currentAssignment } from './orchestration-store.mjs';

import {captureWorktreeEvidence} from './worker-worktree-evidence.mjs';
import {selectWorktreeRoot} from './worktree-paths.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);

const [stateDirArg, role, taskId, runId] = process.argv.slice(2);
if (!stateDirArg || !['manager', 'worker'].includes(role) || (role === 'worker' && (!taskId || !runId))) {
  process.stderr.write('Usage: node orchestration-mcp.mjs <stateDir> manager | <stateDir> worker <taskId> <runId>\n');
  process.exit(1);
}
const stateDir = path.resolve(stateDirArg);
const runtime = role === 'manager' && taskId ? JSON.parse(await readFile(path.resolve(taskId), 'utf8')) : null;
const project = runtime?.project;
const repositoryMode = project?.mode === 'repository';
function scoped(task) {
  if (project && task && task.projectId !== project.id && !(project.mode === 'fixture' && !task.projectId)) throw new Error('Task belongs to another project');
  return task;
}
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const string = (description, maxLength = 12000) => ({ type: 'string', description, minLength: 1, maxLength });
const taskIdentifier = { type: 'string', pattern: '^[a-zA-Z0-9_-]{8,80}$' };
async function reviewedWorktree(task) {
  if(!task.worktree||task.status==='disposed')throw new Error('A retained available worktree is required for review');
  const fixtureMeta=repositoryMode?null:JSON.parse(await readFile(path.join(stateDir,'fixture.json'),'utf8'));
  const actual=await realpath(task.worktree),expected=await realpath(path.join(repositoryMode?await selectWorktreeRoot(stateDir,task):fixtureMeta.base,task.worktreeName||(repositoryMode?task.id:`worker-${task.id}`)));
  if(actual!==expected)throw new Error('Worktree does not match this instance owned path');
  const repo=repositoryMode?project.repositories?.find(item=>item.id===task.repositoryId)?.path:fixtureMeta.repo;
  if(!repo)throw new Error('Configured repository is unavailable for worktree review');
  const root=await realpath(repo);
  const {stdout:list}=await exec('git',['-C',root,'worktree','list','--porcelain'],{maxBuffer:1048576});
  const {stdout:top}=await exec('git',['-C',actual,'rev-parse','--show-toplevel']);
  if(root===actual||await realpath(top.trim())!==actual||!list.includes(`worktree ${actual}\n`))throw new Error('Worktree Git ownership could not be verified');
  return captureWorktreeEvidence(actual);
}
const tools = role === 'manager' ? [
  { name: 'read_manager_scratchpad', description: 'Read this project manager’s saved commitments, notes, decisions and open questions. Consult at conversation resumption and before follow-up. Saved factual working context, never private reasoning or worker scratchpads.', inputSchema: object({}) },
  { name: 'update_manager_scratchpad', description: 'Save meaningful factual changes to the manager scratchpad. Read first; expectedRevision prevents lost updates. patchJson encodes complete replacement arrays for included sections: commitments, notes, decisions, questions. Omitted sections remain. Commitment: {id,title,status:pending|delegated|blocked|completed|cancelled,outcome?,nextAction?,nextReviewAt?:ISO timestamp,references?:{taskId?,runId?,ticketUrl?}}. Preserve unrelated entries. Delegation is not completion; review matching execution evidence before closing. No secrets or hidden reasoning. Corrections supersede stale notes.', inputSchema: object({ patchJson: string('JSON object with expectedRevision integer and replacement sections', 60000) }, ['patchJson']) },
  { name: 'review_worker_recovery', description: 'Read retained versus current lifecycle configuration and exact blockers for one inactive worker. Shows source-backed command changes and a reviewHash. No commands or model work execute. Explain scope and cleanup limits to the human before requesting a decision.', inputSchema: object({ taskId: taskIdentifier, action: {type:'string',enum:['reconcile_plan','retire_missing']} }, ['taskId','action']) },
  { name: 'request_worker_recovery', description: 'Queue one explicitly human-reviewed recovery decision using the exact reviewHash and current run. reconcile_plan applies compatible lifecycle metadata without starting work or replaying setup; retire_missing retains history and marks cleanup unverified for an already absent/unregistered worktree. Never infer user approval, clean resources or bypass unknown ownership. Read status for actual completion; reuse actionId only for exact retries.', inputSchema: object({ taskId:taskIdentifier, actionId:taskIdentifier, action:{type:'string',enum:['reconcile_plan','retire_missing']}, expectedRunId:{type:['string','null'],description:'Exact current run ID, or JSON null for no run'}, reviewHash:string('Exact reviewHash from review_worker_recovery',64), decision:string('Actual human decision approving these exact changes and their resource scope; retirement acknowledges unverified cleanup',2000) }, ['taskId','actionId','action','expectedRunId','reviewHash','decision']) },
  { name: 'request_attention', description: 'Notify the user only when their response or action is required. Explain the specific decision/action in message. Reuse requestId for retries. Never use for routine completion, progress, failures you can resolve yourself, or duplicate native input requests/worker question alerts. Does not start work or microphone capture.', inputSchema: object({ requestId: taskIdentifier, message: string('Specific question or action the user needs to address', 2000) }, ['requestId', 'message']) },
  {
    name: 'submit_task',
    description: repositoryMode ? 'Start an explicitly user-authorized bounded task in a configured repository, separate worker and isolated Git worktree. Verify the existing Linear ticket first. No backlog selection, push, PR, production or external ticket mutations. Independent tasks may run concurrently in separate workers. Queued dispatch is not completion. Reuse requestId for retries.' : 'Start an explicitly user-authorized read-only disposable fixture audit in a separate worker and Git worktree. Independent tasks may run concurrently in separate workers. Queued dispatch is not completion. Reuse requestId for retries.',
    inputSchema: object({ requestId: taskIdentifier, ticket: string('Development ticket, e.g. AI-004', 120), brief: string('Agreed bounded task brief and explicit scope limits'), repositoryId: string('Exact configured repository ID', 80) }, ['requestId', 'ticket', 'brief', ...(repositoryMode ? ['repositoryId'] : [])]),
  },
  { name: 'review_worker_followup', description: 'Read current retained worktree changes and fingerprint before requesting explicit adoption of unknown edits. Does not start work, edit files or grant permission. Show changedFiles to the user and relay their actual decision through assignment or adoption. Re-review if content changes.', inputSchema: object({taskId:taskIdentifier},['taskId']) },
  { name: 'approve_worker_followup_changes', description: 'Record actual explicit user authorization to preserve and adopt the exact reviewed worktree changes for a queued or current inactive assignment. Use the fingerprint from review_worker_followup after discussing the changed paths with the user. Does not launch work or widen the assignment brief, sandbox or other approvals. Exact request retries are idempotent.', inputSchema: object({taskId:taskIdentifier,assignmentId:taskIdentifier,requestId:taskIdentifier,expectedRunId:{type:['string','null'],maxLength:160},fingerprint:string('Exact reviewed fingerprint',64),userDecision:string('Actual human decision adopting these reviewed changes',4000)},['taskId','assignmentId','requestId','expectedRunId','fingerprint','userDecision']) },
  { name: 'assign_worker_followup', description: 'Queue a fresh explicitly user-authorized assignment for a retained worker, preserving the same Codex conversation, Git worktree and prior assignment results. Use after completion or while busy: queued intent does not interrupt work or prove launch. Read current run/assignment IDs from get_status, verify the actual configured ticket, and provide the new bounded brief and actual user decision. This is the operation for research-to-implementation scope changes; never infer authorization. Permissions and approvals remain enforced. Reuse requestId only for exact retries. Disposed workers cannot accept work.', inputSchema: object({ taskId: taskIdentifier, requestId: taskIdentifier, expectedRunId: { type: ['string', 'null'], description: 'Exact current run ID or JSON null before first run', maxLength: 160 }, expectedAssignmentId: string('Exact current assignment ID; initial for legacy tasks', 80), ticket: string('Verified configured development ticket', 120), brief: string('New agreed bounded assignment and scope limits'), userDecision: string('Actual explicit human authorization for this assignment and any change of scope', 4000), reviewedWorktreeFingerprint: string('Optional exact review_worker_followup fingerprint after actual human adoption of the shown edits',64) }, ['taskId','requestId','expectedRunId','expectedAssignmentId','ticket','brief','userDecision']) },
  { name: 'get_status', description: 'Read durable actual worker status, meaningful reports, questions and pending attention. Dispatch is not completion. Do not repeat low-level logs aloud.', inputSchema: object({ taskId: taskIdentifier }) },
  { name: 'answer_worker_approval', description: 'Relay an actual explicit user response to one native worker approval or input request from get_status. Never approve automatically, infer consent from the task brief, expand requested permissions, or answer for the user. Copy every request identity exactly; this continues the same worker request and does not resume or start a turn. Supply exactly one of turnId or turnIdJson; startup connector requests may have JSON null as their native turn.', inputSchema: object({ taskId: taskIdentifier, runId: string('Exact current run ID', 200), approvalId: taskIdentifier, threadId: string('Exact native thread ID', 200), turnId: string('Exact native turn ID; omit when using turnIdJson', 200), turnIdJson: string('The literal JSON null for a connector request whose native turnId is null; omit turnId', 4), requestIdJson: string('JSON encoding of the exact native request ID, preserving number versus string', 250), responseJson: string('Actual user response JSON: decision must match an offered native choice; permissions may select a requested subset and turn/session scope; connectors use action and content; input uses answers keyed by question ID', 16000) }, ['taskId', 'runId', 'approvalId', 'threadId', 'requestIdJson', 'responseJson']) },
  { name: 'answer_question', description: 'Relay the user answer to the currently pending worker question. This queues a controller resume; never invent user consent or expand the brief.', inputSchema: object({ taskId: taskIdentifier, questionId: string('Exact active question ID', 160), answer: string('User answer within agreed scope') }, ['taskId', 'questionId', 'answer']) },
  { name: 'set_worker_model', description: 'Record the actual user-approved model change for one existing worker, using an exact provider model ID. Pending intent only: availability is validated by the native worker before its next explicit resume; no in-flight swap, automatic pause or new turn. Preserve the current turn, task, worktree and native thread. Read get_status; reuse requestId on retries. To transition now, request cooperative pause, wait for confirmed exit, then resume the same worker. A blocked model requirement can be resolved in userDecision without changing the original brief. Never invent consent or claim selection from the request alone.', inputSchema: object({ taskId: taskIdentifier, requestId: taskIdentifier, expectedRunId: string('Exact current run ID', 160), model: string('Exact native model/list model ID, no friendly aliases', 160), userDecision: string('Actual user authorization and any resolved prior model requirement, within agreed scope', 4000) }, ['taskId', 'requestId', 'expectedRunId', 'model', 'userDecision']) },
  { name: 'worker_action', description: 'Request a lifecycle change for one explicitly selected worker. Actions are durable queued intent: read status for actual execution. Stop retains task, history and worktree; pause retains resumable work; resume/start continues the same task; dispose tears down only a safely removable inactive worktree and retains records. Never invent user consent or expand scope. Use the current run ID from get_status to reject stale actions and reuse actionId for retries.', inputSchema: object({ taskId: taskIdentifier, actionId: taskIdentifier, action: { type: 'string', enum: ['stop', 'pause', 'resume', 'start', 'dispose'] }, cooperative: { type: 'boolean', description: 'For pause only: interrupt native turn and await natural owned exit without force-kill. Use for model transitions.' }, expectedRunId: string('Current run ID read from get_status, when a run exists', 160) }, ['taskId', 'actionId', 'action']) },
  { name: 'acknowledge_attention', description: 'Mark one attention item acknowledged after discussing it with the user. Does not launch work, activate a microphone or grant speaking permission.', inputSchema: object({ taskId: taskIdentifier, attentionId: string('Exact attention ID', 160) }, ['taskId', 'attentionId']) },
] : [
  { name: 'report', description: 'Write a durable report for this bound task/run only. Give one useful progress update. For question: record the question, END this turn and wait for controller resume; do not keep polling or continue without the answer. For result: provide concrete evidence; this is a terminal candidate, not verified completion. Reuse reportId for retries.', inputSchema: object({ reportId: string('Unique stable report ID within this run', 160), kind: { type: 'string', enum: ['progress', 'question', 'result', 'blocked'] }, message: string('Useful bounded progress, question, result or blocker'), evidence: { type: 'array', maxItems: 20, items: string('Concrete evidence; no secrets', 2000) } }, ['reportId', 'kind', 'message']) },
];
tools.push({ name: 'update_work_notes', description: 'Replace the actual shared Markdown work document for this task. Record factual findings and decisions, never private reasoning or secrets. The UI reads this document separately from structured task state. Reuse updateId on retries.', inputSchema: object({ ...(role === 'manager' ? { taskId: taskIdentifier } : {}), updateId: string('Stable unique note revision ID', 160), markdown: string('Complete factual shared Markdown document', 60000) }, [...(role === 'manager' ? ['taskId'] : []), 'updateId', 'markdown']) });
function validateArgs(tool, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Arguments must be an object');
  for (const key of tool.inputSchema.required) if (!(key in args)) throw new Error(`Missing ${key}`);
  for (const [key, value] of Object.entries(args)) {
    const schema = tool.inputSchema.properties[key];
    if (!schema) throw new Error(`Unknown argument ${key}`);
    if (schema.type === 'string' && (typeof value !== 'string' || !value.trim() || value.length > (schema.maxLength || 80) || (schema.pattern && !new RegExp(schema.pattern).test(value)) || (schema.enum && !schema.enum.includes(value)))) throw new Error(`Invalid ${key}`);
    if (Array.isArray(schema.type) && !(value === null && schema.type.includes('null') || typeof value === 'string' && schema.type.includes('string') && value.trim() && value.length <= (schema.maxLength || 160))) throw new Error(`Invalid ${key}`);
    if (schema.type === 'boolean' && typeof value !== 'boolean') throw new Error(`Invalid ${key}`);
    if (schema.type === 'array' && (!Array.isArray(value) || value.length > schema.maxItems || value.some(item => typeof item !== 'string' || !item.trim() || item.length > schema.items.maxLength))) throw new Error(`Invalid ${key}`);
  }
}
async function callTool(name, args) {
  const tool = tools.find(item => item.name === name);
  if (!tool) throw new Error('Unknown tool for this role');
  validateArgs(tool, args);
  if (name === 'update_work_notes') { const id = role === 'worker' ? taskId : args.taskId; scoped(await readTask(stateDir, id)); return updateWorkNotes(stateDir, id, { ...args, runId: role === 'worker' ? runId : null }); }
  if (role === 'worker') return reportTask(stateDir, taskId, runId, args);
  switch (name) {
    case 'read_manager_scratchpad': return new ManagerScratchpad({ stateDir }).snapshot();
    case 'update_manager_scratchpad': return new ManagerScratchpad({ stateDir }).update(JSON.parse(args.patchJson));
    case 'request_attention': return { ok: true, attention: { requestId: args.requestId, message: args.message } };
    case 'submit_task': {
      if (project && !project.readiness?.ready) throw new Error(`Project configuration is not ready: ${(project.readiness?.issues || ['configuration incomplete']).join('; ')}`);
      if (repositoryMode) {
        if (!project.repositories.some(repo => repo.id === args.repositoryId)) throw new Error('Unknown configured repositoryId');
        const key = project.linear?.teamKey;
        if (!key || !/^[A-Z][A-Z0-9]*$/.test(key) || !args.ticket.startsWith(`${key}-`) || !/^[1-9][0-9]*$/.test(args.ticket.slice(key.length + 1))) throw new Error('Ticket must match the configured Linear team key; manager must verify the actual ticket');
      } else if (args.repositoryId) throw new Error('Fixture tasks do not accept repositoryId');
      return createTask(stateDir, { ...args, projectId: project?.id || null });
    }
    case 'review_worker_followup': {
      const task=scoped(await readTask(stateDir,args.taskId)),snapshot=await reviewedWorktree(task);
      const known=task.result?.verification?.worktreeFingerprint || [...(task.assignments||[])].reverse().find(item=>item.status==='completed')?.result?.verification?.worktreeFingerprint;
      return {taskId:task.id,expectedRunId:task.runId||null,expectedAssignmentId:currentAssignment(task).id,worktreeFingerprint:snapshot.fingerprint,dirty:snapshot.dirty,changedFiles:snapshot.changedFiles,knownRetainedChanges:known===snapshot.fingerprint};
    }
    case 'approve_worker_followup_changes': scoped(await readTask(stateDir,args.taskId)); return requestWorkerFollowupAdoption(stateDir,args);
    case 'assign_worker_followup': {
      const task = scoped(await readTask(stateDir, args.taskId));
      if (repositoryMode) {
        if (!project.repositories.some(repo => repo.id === task.repositoryId)) throw new Error('Unknown configured repositoryId');
        const key = project.linear?.teamKey;
        if (!key || !/^[A-Z][A-Z0-9]*$/.test(key) || !args.ticket.startsWith(`${key}-`) || !/^[1-9][0-9]*$/.test(args.ticket.slice(key.length + 1))) throw new Error('Ticket must match the configured Linear team key; manager must verify the actual ticket');
      }
      return requestWorkerFollowup(stateDir, args);
    }
    case 'get_status': {
      const requests = await listWorkerRequests({ stateDir });
      const withApprovals = task => ({ ...scoped(task), approvals: requests.filter(request => request.taskId === task.id && request.runId === task.runId && ['pending', 'decided', 'delivered', 'delivery-unknown'].includes(request.status)) });
      return args.taskId ? withApprovals(await readTask(stateDir, args.taskId)) : (await loadTasks(stateDir)).map(withApprovals);
    }
    case 'answer_worker_approval': {
      scoped(await readTask(stateDir, args.taskId));
      const { requestIdJson, responseJson, turnIdJson, ...identity } = args;
      const hasTurn = Object.hasOwn(args, 'turnId'), hasJsonTurn = Object.hasOwn(args, 'turnIdJson');
      if (hasTurn === hasJsonTurn) throw new Error('Supply exactly one of turnId or turnIdJson');
      if (hasJsonTurn) { if (JSON.parse(turnIdJson) !== null) throw new Error('turnIdJson must encode JSON null'); identity.turnId = null; }
      return decideWorkerRequest({ ...identity, stateDir, requestId: JSON.parse(requestIdJson), response: JSON.parse(responseJson) });
    }
    case 'review_worker_recovery': return reviewProjectRecovery({stateDir,task:scoped(await readTask(stateDir,args.taskId)),project,mode:args.action});
    case 'request_worker_recovery': scoped(await readTask(stateDir,args.taskId)); return requestWorkerRecovery(stateDir,args);
    case 'answer_question': scoped(await readTask(stateDir, args.taskId)); return answerQuestion(stateDir, args);
    case 'set_worker_model': scoped(await readTask(stateDir, args.taskId)); return requestWorkerModel(stateDir, args);
    case 'worker_action': scoped(await readTask(stateDir, args.taskId)); return requestWorkerAction(stateDir, args);
    case 'acknowledge_attention': scoped(await readTask(stateDir, args.taskId)); return acknowledgeAttention(stateDir, args);
  }
}
function send(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
async function request(message) {
  if (message?.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    send({ jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32600, message: 'Invalid Request' } }); return;
  }
  if (!Object.hasOwn(message, 'id')) return; // initialized/cancelled notifications need no response.
  const result = value => send({ jsonrpc: '2.0', id: message.id, result: value });
  switch (message.method) {
    case 'initialize':
      result({ protocolVersion: message.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: `local-worker-${role}`, version: '0.1.0' } }); return;
    case 'ping': result({}); return;
    case 'tools/list': result({ tools }); return;
    case 'tools/call':
      try {
        const value = await callTool(message.params?.name, message.params?.arguments ?? {});
        result({ content: [{ type: 'text', text: JSON.stringify(value) }], ...(message.params?.name === 'request_attention' ? { structuredContent: value } : {}) });
      }
      catch (error) { result({ isError: true, content: [{ type: 'text', text: error.message }] }); }
      return;
    default: send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
  }
}
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let pending = Promise.resolve();
lines.on('line', line => {
  if (!line.trim()) return;
  if (line.length > 100000) { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Request exceeds limit' } }); return; }
  pending = pending.then(async () => {
    let parsed;
    try { parsed = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
    await request(parsed);
  }).catch(error => { process.stderr.write(`${error.message}\n`); });
});
