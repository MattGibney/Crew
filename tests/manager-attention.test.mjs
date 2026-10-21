import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { managerAttention } from '../manager-attention.mjs';

const request = { requestId: 'attention-decision', message: 'Which account should I use?' };
const result = { ok: true, attention: request };
const item = () => ({ type: 'mcpToolCall', id: 'call-1', server: 'local_orchestration', tool: 'request_attention', status: 'completed', arguments: { ...request }, result: { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result } });

test('successful explicit native MCP result preserves the stable attention identity on repeated delivery', () => {
  assert.deepEqual(managerAttention(item()), { id: request.requestId, message: request.message });
  assert.deepEqual(managerAttention(item()), managerAttention({ ...item(), id: 'retry-call-2' }));
  const legacy = item(); delete legacy.result.structuredContent;
  assert.deepEqual(managerAttention(legacy), managerAttention(item()));
});

test('started, failed, unrelated or malformed tool calls cannot request attention', () => {
  for (const change of [{ status: 'inProgress' }, { status: 'failed' }, { server: 'other' }, { tool: 'report' }, { type: 'agentMessage' }, { error: { message: 'failed' } }, { arguments: { ...request, requestId: 'bad' } }, { arguments: { ...request, extra: true } }, { result: null }, { result: { isError: true, structuredContent: result } }, { result: { structuredContent: { ok: true, attention: { ...request, message: 'Different action' } } } }, { result: { structuredContent: { ok: false, attention: request } } }, { result: { content: [{ type: 'text', text: 'not JSON' }] } }]) {
    assert.equal(managerAttention({ ...item(), ...change }), null, JSON.stringify(change));
  }
});

async function rpc(role, method, params) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../orchestration-mcp.mjs', import.meta.url)), '/tmp/crew-attention-tool-no-state', role, ...(role === 'worker' ? ['worker-test', 'run-test'] : [])]);
  let output = '', errors = '';
  child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => errors += chunk);
  child.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) + '\n');
  assert.equal(await new Promise(resolve => child.on('close', resolve)), 0, errors);
  return JSON.parse(output.trim()).result;
}

test('manager-only notification MCP validates arguments, echoes structured success and starts no task', async () => {
  const tools = await rpc('manager', 'tools/list', {});
  assert.ok(tools.tools.some(tool => tool.name === 'request_attention'));
  const call = () => rpc('manager', 'tools/call', { name: 'request_attention', arguments: request });
  const first = await call(); assert.deepEqual(first.structuredContent, result); assert.deepEqual(await call(), first);
  for (const args of [{ ...request, requestId: 'bad' }, { ...request, message: ' ' }, { ...request, message: 'x'.repeat(2001) }, { ...request, extra: true }]) {
    assert.equal((await rpc('manager', 'tools/call', { name: 'request_attention', arguments: args })).isError, true);
  }
  const workerTools = await rpc('worker', 'tools/list', {});
  assert.deepEqual(workerTools.tools.map(tool => tool.name), ['report', 'update_work_notes']);
  assert.equal((await rpc('worker', 'tools/call', { name: 'request_attention', arguments: request })).isError, true);
});
