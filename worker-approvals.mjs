// Private durable native requests. These records never authorize a new worker or turn.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readTask, withStateLock } from './orchestration-store.mjs';
import Ajv from 'ajv';
import { isDeepStrictEqual } from 'node:util';

const formValidator = new Ajv({ strict: false, validateFormats: false, allErrors: true });
function subset(value, requested) {
  if (value == null) return true;
  if (Array.isArray(value)) return Array.isArray(requested) && value.every(item => requested.some(allowed => isDeepStrictEqual(item, allowed)));
  if (typeof value === 'object') return requested && typeof requested === 'object' && Object.entries(value).every(([key, item]) => Object.hasOwn(requested, key) && subset(item, requested[key]));
  if (value === false) return typeof requested === 'boolean';
  return value === requested;
}

const METHODS = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'item/tool/requestUserInput', 'mcpServer/elicitation/request']);
const ACTIVE = new Set(['running', 'launching', 'awaiting_answer', 'verifying', 'blocked', 'pausing', 'stopping']);
const id = value => { if (typeof value !== 'string' || !/^[\w-]{8,80}$/.test(value)) throw new Error('Invalid worker request identity'); return value; };
const native = value => { if (!(typeof value === 'string' && value.length > 0 && value.length <= 200 || Number.isSafeInteger(value))) throw new Error('Invalid native request identity'); return value; };
const directory = stateDir => path.join(stateDir, 'worker-approvals');
const filename = (stateDir, approvalId) => path.join(directory(stateDir), `${id(approvalId)}.json`);
const stamp = () => new Date().toISOString();
const rejection = (message, code) => Object.assign(new Error(message), { code });
function identity(value) { return [id(value.taskId), native(value.runId), native(value.threadId), value.turnId === null ? null : native(value.turnId), native(value.requestId)]; }
function key(value) { return `approval-${createHash('sha256').update(JSON.stringify(identity(value))).digest('hex')}`; }
async function current(stateDir, value, { allowLifecycle = false } = {}) {
  const task = await readTask(stateDir, value.taskId);
  if (task.runId !== value.runId || !ACTIVE.has(task.status)) throw rejection('Worker request belongs to an inactive or stale run', 'STALE_WORKER_REQUEST');
  if (task.threadId && task.threadId !== value.threadId) throw rejection('Worker request belongs to a different thread', 'STALE_WORKER_REQUEST');
  if (!allowLifecycle && (task.lifecycleRequests || []).some(request => ['pending', 'processing'].includes(request.status) && ['stop', 'pause', 'dispose'].includes(request.action))) throw rejection('Worker lifecycle change is pending; this request cannot be approved', 'WORKER_LIFECYCLE_PENDING');
  return task;
}
async function save(stateDir, record) {
  await fs.mkdir(directory(stateDir), { recursive: true, mode: 0o700 });
  const file = filename(stateDir, record.approvalId), temp = `${file}.${randomUUID()}.tmp`;
  try { const handle = await fs.open(temp, 'wx', 0o600); try { await handle.writeFile(`${JSON.stringify(record)}\n`); await handle.sync(); } finally { await handle.close(); } await fs.rename(temp, file); }
  finally { await fs.unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  return record;
}
async function read(stateDir, approvalId) {
  const record = JSON.parse(await fs.readFile(filename(stateDir, approvalId), 'utf8'));
  if (record.approvalId !== approvalId || key(record) !== approvalId || !METHODS.has(record.method) || record.turnId === null && record.method !== 'mcpServer/elicitation/request' || !['pending', 'decided', 'delivered', 'delivery-unknown', 'resolved', 'stale'].includes(record.status)) throw new Error('Malformed worker request; refusing to replace it');
  return record;
}
export async function recordWorkerRequest({ stateDir, ...input }) {
  const approvalId = key(input);
  if (!METHODS.has(input.method) || !input.params || typeof input.params !== 'object' || Array.isArray(input.params) || JSON.stringify(input.params).length > 65536) throw new Error('Unsupported or oversized worker request');
  if (input.turnId === null && input.method !== 'mcpServer/elicitation/request') throw new Error('Only a connector elicitation may omit its native turn');
  if (input.params.threadId !== input.threadId || input.params.turnId !== undefined && input.params.turnId !== input.turnId) throw new Error('Native request correlation mismatch');
  return withStateLock(stateDir, '.worker-approvals.lock', async () => {
    await current(stateDir, input, { allowLifecycle: true });
    try { const previous = await read(stateDir, approvalId); if (previous.method !== input.method || JSON.stringify(previous.params) !== JSON.stringify(input.params)) throw new Error('Native request identity reused with different contents'); return previous; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    return save(stateDir, { ...input, approvalId, status: 'pending', createdAt: stamp() });
  });
}
export async function listWorkerRequests({ stateDir, taskId, runId, pendingOnly = false }) {
  let names; try { names = await fs.readdir(directory(stateDir)); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const records = await Promise.all(names.filter(name => name.endsWith('.json')).map(name => read(stateDir, name.slice(0, -5))));
  return records.filter(record => (!taskId || record.taskId === taskId) && (!runId || record.runId === runId) && (!pendingOnly || record.status === 'pending')).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
// The UI supplies only a human decision; translate it into the native method's response.
export function workerApprovalResponse(request, response) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) throw new Error('A user response is required');
  const { method, params } = request;
  if (method === 'item/tool/requestUserInput') {
    const answers = {};
    for (const question of params.questions || []) {
      const answer = response.answers?.[question.id];
      if (typeof answer !== 'string' || !answer.trim() || answer.length > 12000) throw new Error('Answer each question before submitting');
      if (question.options?.length && !question.isOther && !question.options.some(option => option.label === answer)) throw new Error('Choose an offered answer');
      answers[question.id] = { answers: [answer] };
    }
    return { answers };
  }
  if (method === 'mcpServer/elicitation/request') {
    if (!['accept', 'decline', 'cancel'].includes(response.action)) throw new Error('Invalid connector response');
    const empty = params.mode === 'form' && params._meta?.codex_approval_kind === 'mcp_tool_call' && Object.keys(params.requestedSchema?.properties || {}).length === 0;
    let content = null;
    if (response.action === 'accept') {
      if (empty) content = {};
      else if (params.mode === 'url') content = response.content ?? null;
      else {
        content = response.content;
        if (!content || typeof content !== 'object' || JSON.stringify(content).length > 16000) throw new Error('Provide the requested connector form content');
        if (params.requestedSchema) {
          const schema = { ...params.requestedSchema }; delete schema.$schema;
          if (schema.required === null) delete schema.required;
          let validate; try { validate = formValidator.compile(schema); } catch { throw new Error('This connector form schema cannot be validated safely'); }
          if (!validate(content)) throw new Error(`Connector form content does not match its schema: ${formValidator.errorsText(validate.errors, { dataVar: 'form' })}`);
        }
      }
    }
    return { action: response.action, content, _meta: response._meta ?? null };
  }
  if (method === 'item/permissions/requestApproval') {
    if (!['accept', 'decline'].includes(response.decision)) throw new Error('Invalid permission decision');
    const permissions = response.decision === 'accept' ? response.permissions ?? params.permissions : {};
    if (!subset(permissions, params.permissions)) throw new Error('Granted permissions exceed this request');
    const scope = response.scope ?? 'turn';
    if (!['turn', 'session'].includes(scope)) throw new Error('Invalid permission scope');
    if (response.strictAutoReview != null && typeof response.strictAutoReview !== 'boolean') throw new Error('Invalid automatic review choice');
    return { permissions, scope, ...(response.strictAutoReview != null ? { strictAutoReview: response.strictAutoReview } : {}) };
  }
  const defaults = ['accept', 'acceptForSession', 'decline', 'cancel'];
  if (method === 'item/commandExecution/requestApproval') {
    if (params.proposedExecpolicyAmendment) defaults.push({ acceptWithExecpolicyAmendment: { execpolicy_amendment: params.proposedExecpolicyAmendment } });
    for (const amendment of params.proposedNetworkPolicyAmendments || []) defaults.push({ applyNetworkPolicyAmendment: { network_policy_amendment: amendment } });
  }
  if (!(params.availableDecisions || defaults).some(choice => isDeepStrictEqual(choice, response.decision))) throw new Error('Decision is not available for this request');
  return { decision: response.decision };
}
export async function decideWorkerRequest({ stateDir, ...input }) {
  identity(input);
  // Serialize the last correlation check with controller run/lifecycle changes.
  return withStateLock(stateDir, '.schedule.lock', () => withStateLock(stateDir, '.worker-approvals.lock', async () => {
    const record = await read(stateDir, input.approvalId);
    if (key(input) !== record.approvalId) throw new Error('Worker request correlation mismatch');
    const response = workerApprovalResponse(record, input.response);
    if (record.status === 'delivery-unknown') throw new Error('Native response delivery outcome is unknown; the decision cannot be retried');
    if (['decided', 'delivered', 'resolved'].includes(record.status)) { if (JSON.stringify(record.response) !== JSON.stringify(response)) throw new Error('Worker request already has a different decision or was resolved by Codex'); return record; }
    if (record.status !== 'pending') throw new Error('Worker request is stale');
    const negative = ['decline', 'cancel'].includes(input.response.decision || input.response.action);
    await current(stateDir, record, { allowLifecycle: negative });
    return save(stateDir, { ...record, response, status: 'decided', decidedAt: stamp() });
  }));
}
export async function workerRequestDecisions({ stateDir, taskId, runId }) {
  return (await listWorkerRequests({ stateDir, taskId, runId })).filter(record => record.status === 'decided');
}
function grantsNothing(value) {
  if (value == null || value === false) return true;
  if (Array.isArray(value)) return value.length === 0;
  return typeof value === 'object' && Object.values(value).every(grantsNothing);
}
function negativeResponse(record) {
  if (record.method === 'item/permissions/requestApproval') return grantsNothing(record.response?.permissions);
  return ['decline', 'cancel'].includes(record.response?.decision || record.response?.action);
}
export async function deliverWorkerRequest({ stateDir, taskId, runId, approvalId }, deliver) {
  // Keep the controller's lifecycle/run barrier until the native response is
  // actually written. A prior user decision cannot race a newer pause into
  // granting access after that pause was durably requested.
  return withStateLock(stateDir, '.schedule.lock', () => withStateLock(stateDir, '.worker-approvals.lock', async () => {
    const record = await read(stateDir, approvalId);
    if (record.taskId !== taskId || record.runId !== runId) throw new Error('Worker request correlation mismatch');
    if (record.status !== 'decided') return null;
    try { await current(stateDir, record, { allowLifecycle: negativeResponse(record) }); }
    catch (error) { if (['STALE_WORKER_REQUEST', 'WORKER_LIFECYCLE_PENDING'].includes(error.code)) return null; throw error; }
    try { await deliver(record); }
    catch (error) {
      const code = typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{0,40}$/.test(error.code) ? error.code : 'NATIVE_DELIVERY_FAILURE';
      await save(stateDir, { ...record, status: 'delivery-unknown', deliveryUnknownAt: stamp(), deliveryFailure: { code, message: 'The native response write did not confirm its outcome. Execution may have occurred; this decision will not be resent.' } });
      throw error;
    }
    return save(stateDir, { ...record, status: 'delivered', deliveredAt: stamp() });
  }));
}
export async function markWorkerRequestDelivered({ stateDir, taskId, runId, approvalId }) {
  return withStateLock(stateDir, '.worker-approvals.lock', async () => {
    const record = await read(stateDir, approvalId);
    if (record.taskId !== taskId || record.runId !== runId) throw new Error('Worker request correlation mismatch');
    if (record.status === 'delivered' || record.status === 'resolved' && record.deliveredAt) return record;
    // Native resolution can arrive before this successful pipe-write callback
    // acquires the store lock. Retain both facts without reopening the request.
    if (record.status === 'resolved') {
      if (!record.response) throw new Error('Worker request has no user decision');
      return save(stateDir, { ...record, deliveredAt: stamp() });
    }
    if (record.status !== 'decided') throw new Error('Worker request has no user decision');
    return save(stateDir, { ...record, status: 'delivered', deliveredAt: stamp() });
  });
}
export async function markWorkerRequestResolved({ stateDir, taskId, runId, approvalId }) {
  return withStateLock(stateDir, '.worker-approvals.lock', async () => {
    const record = await read(stateDir, approvalId);
    if (record.taskId !== taskId || record.runId !== runId) throw new Error('Worker request correlation mismatch');
    if (record.status === 'resolved') return record;
    if (record.status === 'stale') throw new Error('Worker request is stale');
    return save(stateDir, { ...record, status: 'resolved', resolvedAt: stamp(), resolvedWithoutDecision: !record.response });
  });
}
export async function invalidateWorkerRequests({ stateDir, taskId, runId, reason = 'Native worker request is no longer active' }) {
  return withStateLock(stateDir, '.worker-approvals.lock', async () => {
    const records = await listWorkerRequests({ stateDir, taskId, runId });
    for (const record of records) if (['pending', 'decided', 'delivered', 'delivery-unknown'].includes(record.status)) await save(stateDir, { ...record, status: 'stale', staleAt: stamp(), reason });
  });
}
