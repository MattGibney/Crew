import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createTask, updateTask, requestWorkerAction } from '../orchestration-store.mjs';
import { recordWorkerRequest, listWorkerRequests, decideWorkerRequest, workerRequestDecisions, deliverWorkerRequest, markWorkerRequestDelivered, markWorkerRequestResolved, invalidateWorkerRequests, workerApprovalResponse } from '../worker-approvals.mjs';

async function fixture(t) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'crew-approvals-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const taskId = 'approval-task-01', runId = 'approval-run-01', threadId = 'native-thread-01', turnId = 'native-turn-01';
  await createTask(stateDir, { requestId: taskId, ticket: 'GH-13', brief: 'Bounded approval test' });
  await updateTask(stateDir, taskId, task => { task.runId = runId; task.status = 'running'; });
  const input = { stateDir, taskId, runId, threadId, turnId, requestId: 17, method: 'item/commandExecution/requestApproval', params: { threadId, turnId, command: 'docker version', cwd: '/test', availableDecisions: ['accept', 'decline', 'cancel'] } };
  const decide = (request, response, overrides = {}) => decideWorkerRequest({ stateDir, ...request, response, ...overrides });
  return { input, stateDir, taskId, runId, decide };
}
test('pending requests survive a reader restart and remain unanswered until a correlated user decision', async t => {
  const { input, stateDir, taskId, runId, decide } = await fixture(t);
  const request = await recordWorkerRequest(input);
  assert.equal(request.status, 'pending');
  assert.deepEqual(await workerRequestDecisions({ stateDir, taskId, runId }), []);
  assert.equal((await listWorkerRequests({ stateDir, pendingOnly: true }))[0].approvalId, request.approvalId);
  assert.deepEqual(await recordWorkerRequest(input), request);
  await assert.rejects(decide(request, { decision: 'accept' }, { turnId: 'different-turn' }), /correlation mismatch/);
  await assert.rejects(decide(request, { decision: 'accept' }, { requestId: '17' }), /correlation mismatch/);
  const decision = await decide(request, { decision: 'decline' });
  assert.deepEqual(decision.response, { decision: 'decline' });
  assert.deepEqual(await decide(request, { decision: 'decline' }), decision);
  await assert.rejects(decide(request, { decision: 'accept' }), /different decision/);
  assert.equal((await workerRequestDecisions({ stateDir, taskId, runId })).length, 1);
  await markWorkerRequestDelivered({ stateDir, taskId, runId, approvalId: request.approvalId });
  assert.deepEqual(await workerRequestDecisions({ stateDir, taskId, runId }), []);
  assert.equal((await listWorkerRequests({ stateDir }))[0].status, 'delivered');
  await markWorkerRequestResolved({ stateDir, taskId, runId, approvalId: request.approvalId });
  assert.deepEqual(await workerRequestDecisions({ stateDir, taskId, runId }), []);
  assert.equal((await listWorkerRequests({ stateDir }))[0].status, 'resolved');
});
test('native self-resolution is recorded without fabricating a user decision', async t => {
  const { input, stateDir, taskId, runId, decide } = await fixture(t);
  const request = await recordWorkerRequest(input);
  const resolved = await markWorkerRequestResolved({ stateDir, taskId, runId, approvalId: request.approvalId });
  assert.equal(resolved.resolvedWithoutDecision, true);
  assert.equal(resolved.response, undefined);
  await assert.rejects(markWorkerRequestDelivered({stateDir,taskId,runId,approvalId:request.approvalId}),/no user decision/);
  await assert.rejects(decide(request, { decision: 'accept' }), /resolved by Codex/);
});
test('a run change, pending lifecycle action, or invalidated native request cannot acquire approval', async t => {
  const { input, stateDir, taskId, runId, decide } = await fixture(t);
  const request = await recordWorkerRequest(input);
  await updateTask(stateDir, taskId, task => { task.runId = 'new-worker-run'; });
  await assert.rejects(decide(request, { decision: 'accept' }), /stale run/);
  await updateTask(stateDir, taskId, task => { task.runId = runId; });
  await requestWorkerAction(stateDir, { taskId, expectedRunId: runId, actionId: 'pause-action-01', action: 'pause' });
  await assert.rejects(decide(request, { decision: 'accept' }), /lifecycle change/);
  assert.equal((await decide(request, { decision: 'cancel' })).response.decision, 'cancel');
  await invalidateWorkerRequests({ stateDir, taskId, runId, reason: 'Turn interrupted' });
  await assert.rejects(decide(request, { decision: 'accept' }), /stale/);
  assert.equal((await listWorkerRequests({ stateDir, pendingOnly: true })).length, 0);
});
test('distinct concurrent native IDs remain separate and cannot replace request contents', async t => {
  const { input, stateDir, decide } = await fixture(t);
  const first = await recordWorkerRequest(input), second = await recordWorkerRequest({ ...input, requestId: '17' });
  assert.notEqual(first.approvalId, second.approvalId);
  await assert.rejects(recordWorkerRequest({ ...input, params: { ...input.params, command: 'different command' } }), /reused/);
  await Promise.all([decide(first, { decision: 'accept' }), decide(second, { decision: 'cancel' })]);
  const decisions = await workerRequestDecisions({ stateDir, taskId: input.taskId, runId: input.runId });
  assert.equal(decisions.length, 2);
  assert.equal(decisions.find(request => request.requestId === '17').response.decision, 'cancel');
});
test('a positive decision queued before pause is withheld at native delivery while a user denial can drain', async t => {
  const { input, stateDir, taskId, runId, decide } = await fixture(t);
  const allow = await recordWorkerRequest(input), deny = await recordWorkerRequest({ ...input, requestId: 18 });
  await decide(allow, { decision: 'accept' });
  await decide(deny, { decision: 'decline' });
  await requestWorkerAction(stateDir, { taskId, expectedRunId: runId, actionId: 'pause-delivery-01', action: 'pause' });
  const sent = [];
  assert.equal(await deliverWorkerRequest({ stateDir, taskId, runId, approvalId: allow.approvalId }, request => sent.push(request.response)), null);
  const result = await deliverWorkerRequest({ stateDir, taskId, runId, approvalId: deny.approvalId }, request => sent.push(request.response));
  assert.equal(result.status, 'delivered'); assert.ok(result.deliveredAt);
  assert.deepEqual(sent, [{ decision: 'decline' }]);
  assert.equal((await listWorkerRequests({ stateDir })).find(request => request.approvalId === allow.approvalId).status, 'decided');
});
test('an uncertain native write is retained honestly and cannot replay the user decision', async t => {
  const { input, stateDir, taskId, runId, decide } = await fixture(t);
  const request = await recordWorkerRequest(input); await decide(request, { decision: 'accept' });
  const context = { stateDir, taskId, runId, approvalId: request.approvalId };
  let attempts = 0;
  await assert.rejects(deliverWorkerRequest(context, () => { attempts++; throw Object.assign(new Error('Synthetic uncertain write'), { code: 'ERR_NATIVE_WRITE_TIMEOUT' }); }), /uncertain write/);
  const unknown = (await listWorkerRequests({ stateDir }))[0];
  assert.equal(unknown.status, 'delivery-unknown'); assert.equal(unknown.deliveryFailure.code, 'ERR_NATIVE_WRITE_TIMEOUT');
  assert.match(unknown.deliveryFailure.message, /Execution may have occurred/);
  assert.deepEqual(await workerRequestDecisions({ stateDir, taskId, runId }), []);
  assert.equal(await deliverWorkerRequest(context, () => { attempts++; }), null);
  await assert.rejects(decide(request, { decision: 'accept' }), /outcome is unknown/);
  assert.equal(attempts, 1);
  const acknowledged = await markWorkerRequestResolved(context);
  assert.equal(acknowledged.status, 'resolved'); assert.ok(acknowledged.deliveryUnknownAt);
});
test('native responses honour offered choices and never expand requested permissions', () => {
  const request = { method: 'item/permissions/requestApproval', params: { permissions: { fileSystem: { write: ['/test/one'] } } } };
  assert.throws(() => workerApprovalResponse(request, { decision: 'accept', permissions: { fileSystem: { write: ['/'] } } }), /exceed/);
  assert.deepEqual(workerApprovalResponse(request, { decision: 'accept', permissions: { fileSystem: { write: [] } }, scope: 'session' }), { permissions: { fileSystem: { write: [] } }, scope: 'session' });
  assert.deepEqual(workerApprovalResponse(request, { decision: 'decline' }), { permissions: {}, scope: 'turn' });
  assert.throws(() => workerApprovalResponse(request, { decision: 'cancel' }), /Invalid permission/);
  assert.throws(() => workerApprovalResponse({ method: 'item/commandExecution/requestApproval', params: { availableDecisions: ['cancel'] } }, { decision: 'accept' }), /not available/);
  const form = { method: 'mcpServer/elicitation/request', params: { mode: 'form', requestedSchema: { type: 'object', properties: { value: { type: 'integer' } }, required: ['value'] } } };
  assert.throws(() => workerApprovalResponse(form, { action: 'accept' }), /form content/);
  assert.throws(() => workerApprovalResponse(form, { action: 'accept', content: { value: 'bad' } }), /does not match/);
  assert.deepEqual(workerApprovalResponse(form, { action: 'accept', content: { value: 2 } }), { action: 'accept', content: { value: 2 }, _meta: null });
  const question = { method: 'item/tool/requestUserInput', params: { questions: [{ id: 'q1', question: 'Choose', options: [{ label: 'One' }], isOther: false }] } };
  assert.throws(() => workerApprovalResponse(question, { answers: { q1: 'Two' } }), /offered/);
  assert.deepEqual(workerApprovalResponse(question, { answers: { q1: 'One' } }), { answers: { q1: { answers: ['One'] } } });
});
test('native session and exact offered policy amendments are preserved', () => {
  const amendment = { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['docker', 'version'] } };
  const request = { method: 'item/commandExecution/requestApproval', params: { availableDecisions: ['acceptForSession', amendment, 'decline'] } };
  assert.deepEqual(workerApprovalResponse(request, { decision: 'acceptForSession' }), { decision: 'acceptForSession' });
  assert.deepEqual(workerApprovalResponse(request, { decision: structuredClone(amendment) }), { decision: amendment });
  assert.throws(() => workerApprovalResponse(request, { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['docker'] } } }), /not available/);
});
test('manager MCP status and explicit decision route preserve the same native request identity', async t => {
  const { input, stateDir } = await fixture(t);
  const request = await recordWorkerRequest(input);
  const child = spawn(process.execPath, [fileURLToPath(new URL('../orchestration-mcp.mjs', import.meta.url)), stateDir, 'manager'], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); });
  let output = '', stderr = '';
  child.stdout.on('data', value => { output += value; }); child.stderr.on('data', value => { stderr += value; });
  const messages = [
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_status', arguments: { taskId: input.taskId } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'answer_worker_approval', arguments: { taskId: input.taskId, runId: input.runId, approvalId: request.approvalId, threadId: input.threadId, turnId: input.turnId, requestIdJson: JSON.stringify(input.requestId), responseJson: JSON.stringify({ decision: 'cancel' }) } } },
  ];
  const exited = once(child, 'exit'); child.stdin.end(messages.map(message => JSON.stringify(message)).join('\n') + '\n');
  assert.equal((await exited)[0], 0, stderr);
  const replies = output.trim().split('\n').map(line => JSON.parse(line));
  const before = JSON.parse(replies.find(reply => reply.id === 1).result.content[0].text);
  assert.equal(before.approvals[0].approvalId, request.approvalId);
  const decision = JSON.parse(replies.find(reply => reply.id === 2).result.content[0].text);
  assert.equal(decision.status, 'decided'); assert.equal(decision.requestId, 17); assert.equal(decision.response.decision, 'cancel');
  assert.equal((await workerRequestDecisions({ stateDir, taskId: input.taskId, runId: input.runId }))[0].approvalId, request.approvalId);
});
test('startup connector elicitation preserves a genuine null turn through store and manager MCP decisions', async t => {
  const { input, stateDir, decide } = await fixture(t);
  await assert.rejects(recordWorkerRequest({ ...input, turnId: null, params: { ...input.params, turnId: null } }), /Only a connector/);
  const startup = { ...input, turnId: null, method: 'mcpServer/elicitation/request', params: { threadId: input.threadId, turnId: null, mode: 'form', _meta: { codex_approval_kind: 'mcp_tool_call' }, requestedSchema: { type: 'object', properties: {} } } };
  const direct = await recordWorkerRequest(startup);
  assert.equal(direct.turnId, null);
  const declined = await decide(direct, { action: 'decline' });
  assert.equal(declined.turnId, null); assert.equal(declined.response.action, 'decline');
  const request = await recordWorkerRequest({ ...startup, requestId: 19 });
  const args = { taskId: input.taskId, runId: input.runId, approvalId: request.approvalId, threadId: input.threadId, turnIdJson: 'null', requestIdJson: '19', responseJson: JSON.stringify({ action: 'accept' }) };
  const messages = [
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'answer_worker_approval', arguments: { ...args, turnId: 'invented-turn' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'answer_worker_approval', arguments: args } },
  ];
  const child = spawn(process.execPath, [fileURLToPath(new URL('../orchestration-mcp.mjs', import.meta.url)), stateDir, 'manager'], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); });
  let output = ''; child.stdout.on('data', value => { output += value; });
  const exited = once(child, 'exit'); child.stdin.end(messages.map(message => JSON.stringify(message)).join('\n') + '\n');
  assert.equal((await exited)[0], 0);
  const replies = output.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(replies[0].result.isError, true); assert.match(replies[0].result.content[0].text, /exactly one/);
  const accepted = JSON.parse(replies[1].result.content[0].text);
  assert.equal(accepted.turnId, null); assert.equal(accepted.requestId, 19); assert.equal(accepted.status, 'decided');
  assert.deepEqual(accepted.response, { action: 'accept', content: {}, _meta: null });
});

test('native resolution racing successful delivery retains both facts without reopening the request',async t=>{
 const {input,stateDir,taskId,runId,decide}=await fixture(t),request=await recordWorkerRequest(input);await decide(request,{decision:'accept'});await markWorkerRequestResolved({stateDir,taskId,runId,approvalId:request.approvalId});const delivered=await markWorkerRequestDelivered({stateDir,taskId,runId,approvalId:request.approvalId});assert.equal(delivered.status,'resolved');assert.ok(delivered.deliveredAt);assert.ok(delivered.resolvedAt);assert.deepEqual(delivered.response,{decision:'accept'});assert.deepEqual(await workerRequestDecisions({stateDir,taskId,runId}),[]);
});

test('restored history rejects old approval decisions and never delivers previously decided historical requests',async t=>{
 const {input,stateDir,taskId,runId,decide}=await fixture(t);
 const pending=await recordWorkerRequest(input);
 await updateTask(stateDir,taskId,task=>{task.status='blocked';task.archiveRestoration={requiresRecovery:true,reason:'history-only'};});
 for(const decision of ['accept','decline','cancel'])await assert.rejects(decide(pending,{decision}),/historical approvals/);
 assert.equal((await listWorkerRequests({stateDir,taskId}))[0].status,'pending');
 for(const [index,decision]of ['accept','decline','cancel'].entries()){
  await updateTask(stateDir,taskId,task=>{task.status='running';delete task.archiveRestoration;});
  const request=await recordWorkerRequest({...input,requestId:200+index});await decide(request,{decision});
  await updateTask(stateDir,taskId,task=>{task.status='blocked';task.archiveRestoration={requiresRecovery:true,reason:'history-only'};});
  await assert.rejects(decide(request,{decision}),/historical approvals/);
  let delivered=false;assert.equal(await deliverWorkerRequest({stateDir,taskId,runId,approvalId:request.approvalId},()=>{delivered=true;}),null);assert.equal(delivered,false);
  assert.equal((await listWorkerRequests({stateDir,taskId})).find(item=>item.approvalId===request.approvalId).status,'decided');
 }
});
