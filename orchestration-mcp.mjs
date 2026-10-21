#!/usr/bin/env node
import readline from 'node:readline';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createTask, readTask, loadTasks, reportTask, answerQuestion, acknowledgeAttention, requestWorkerAction } from './orchestration-store.mjs';

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
const tools = role === 'manager' ? [
  { name: 'request_attention', description: 'Notify the user only when their response or action is required. Explain the specific decision/action in message. Reuse requestId for retries. Never use for routine completion, progress, failures you can resolve yourself, or duplicate native input requests/worker question alerts. Does not start work or microphone capture.', inputSchema: object({ requestId: taskIdentifier, message: string('Specific question or action the user needs to address', 2000) }, ['requestId', 'message']) },
  {
    name: 'submit_task',
    description: repositoryMode ? 'Start an explicitly user-authorized bounded task in a configured repository, separate worker and isolated Git worktree. Verify the existing Linear ticket first. No backlog selection, push, PR, production or external ticket mutations. Independent tasks may run concurrently in separate workers. Queued dispatch is not completion. Reuse requestId for retries.' : 'Start an explicitly user-authorized read-only disposable fixture audit in a separate worker and Git worktree. Independent tasks may run concurrently in separate workers. Queued dispatch is not completion. Reuse requestId for retries.',
    inputSchema: object({ requestId: taskIdentifier, ticket: string('Development ticket, e.g. AI-004', 120), brief: string('Agreed bounded task brief and explicit scope limits'), repositoryId: string('Exact configured repository ID', 80) }, ['requestId', 'ticket', 'brief', ...(repositoryMode ? ['repositoryId'] : [])]),
  },
  { name: 'get_status', description: 'Read durable actual worker status, meaningful reports, questions and pending attention. Dispatch is not completion. Do not repeat low-level logs aloud.', inputSchema: object({ taskId: taskIdentifier }) },
  { name: 'answer_question', description: 'Relay the user answer to the currently pending worker question. This queues a controller resume; never invent user consent or expand the brief.', inputSchema: object({ taskId: taskIdentifier, questionId: string('Exact active question ID', 160), answer: string('User answer within agreed scope') }, ['taskId', 'questionId', 'answer']) },
  { name: 'worker_action', description: 'Request a lifecycle change for one explicitly selected worker. Actions are durable queued intent: read status for actual execution. Stop retains task, history and worktree; pause retains resumable work; resume/start continues the same task; dispose tears down only a safely removable inactive worktree and retains records. Never invent user consent or expand scope. Use the current run ID from get_status to reject stale actions and reuse actionId for retries.', inputSchema: object({ taskId: taskIdentifier, actionId: taskIdentifier, action: { type: 'string', enum: ['stop', 'pause', 'resume', 'start', 'dispose'] }, expectedRunId: string('Current run ID read from get_status, when a run exists', 160) }, ['taskId', 'actionId', 'action']) },
  { name: 'acknowledge_attention', description: 'Mark one attention item acknowledged after discussing it with the user. Does not launch work, activate a microphone or grant speaking permission.', inputSchema: object({ taskId: taskIdentifier, attentionId: string('Exact attention ID', 160) }, ['taskId', 'attentionId']) },
] : [
  { name: 'report', description: 'Write a durable report for this bound task/run only. Give one useful progress update. For question: record the question, END this turn and wait for controller resume; do not keep polling or continue without the answer. For result: provide concrete evidence; this is a terminal candidate, not verified completion. Reuse reportId for retries.', inputSchema: object({ reportId: string('Unique stable report ID within this run', 160), kind: { type: 'string', enum: ['progress', 'question', 'result', 'blocked'] }, message: string('Useful bounded progress, question, result or blocker'), evidence: { type: 'array', maxItems: 20, items: string('Concrete evidence; no secrets', 2000) } }, ['reportId', 'kind', 'message']) },
];
function validateArgs(tool, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Arguments must be an object');
  for (const key of tool.inputSchema.required) if (!(key in args)) throw new Error(`Missing ${key}`);
  for (const [key, value] of Object.entries(args)) {
    const schema = tool.inputSchema.properties[key];
    if (!schema) throw new Error(`Unknown argument ${key}`);
    if (schema.type === 'string' && (typeof value !== 'string' || !value.trim() || value.length > (schema.maxLength || 80) || (schema.pattern && !new RegExp(schema.pattern).test(value)) || (schema.enum && !schema.enum.includes(value)))) throw new Error(`Invalid ${key}`);
    if (schema.type === 'array' && (!Array.isArray(value) || value.length > schema.maxItems || value.some(item => typeof item !== 'string' || !item.trim() || item.length > schema.items.maxLength))) throw new Error(`Invalid ${key}`);
  }
}
async function callTool(name, args) {
  const tool = tools.find(item => item.name === name);
  if (!tool) throw new Error('Unknown tool for this role');
  validateArgs(tool, args);
  if (role === 'worker') return reportTask(stateDir, taskId, runId, args);
  switch (name) {
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
    case 'get_status': return args.taskId ? scoped(await readTask(stateDir, args.taskId)) : (await loadTasks(stateDir)).map(scoped);
    case 'answer_question': scoped(await readTask(stateDir, args.taskId)); return answerQuestion(stateDir, args);
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
