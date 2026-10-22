import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeEnvelope, decodeNotification, decodeRpc, decodeApprovalParams, rpcErrorCode } from '../runtime/manager/bridge/protocol.mjs';

test('native protocol validates consumed identity and history before projection', () => {
 assert.throws(() => decodeRpc('thread/start', { thread: { id: 19 } }), /Invalid native thread\/start/);
 assert.throws(() => decodeRpc('thread/timeline/list', { data: [{ type: 'item', position: 0, turnId: 'turn', item: { type: 'agentMessage' } }] }), /Invalid native thread\/timeline\/list/);
 const result = { thread: { id: 'native-thread', providerMetadata: { capability: true } } };
 assert.equal(decodeRpc('thread/resume', result), result);
 assert.equal(rpcErrorCode({ code: -32601 }), -32601);
 assert.equal(rpcErrorCode({ code: 'ENOENT' }), 'ENOENT');
});

test('native method-bearing requests retain their namespace and nullable startup turn', () => {
 const request = { id: 1, method: 'mcpServer/elicitation/request', params: { threadId: 'startup-thread', turnId: null, mode: 'form', requestedSchema: { type: 'object', properties: {} } } };
 assert.equal(decodeEnvelope(request), request);
 assert.equal(decodeApprovalParams(request.params), request.params);
 assert.equal(decodeNotification(request), null);
 assert.throws(() => decodeApprovalParams({ threadId: 1 }), /Invalid native approval/);
 assert.equal(decodeNotification({ method: 'unknown/future', params: {} }), null);
 assert.throws(() => decodeNotification({ method: 'item/agentMessage/delta', params: { threadId: 'thread', itemId: 'item', delta: 1 } }), /Invalid native notification/);
});

test('silent native command null output is preserved in manager notifications and restored history', () => {
 const item={id:'silent-command',type:'commandExecution',command:'node -e ""',status:'completed',exitCode:0,aggregatedOutput:null};
 const notification={method:'item/completed',params:{threadId:'thread',turnId:'turn',item}};
 assert.equal(decodeNotification(notification).params.item,item);
 const history={data:[{id:'turn',status:'completed',items:[item]}]};
 assert.equal(decodeRpc('thread/turns/list',history),history);
 const timeline={data:[{type:'item',position:0,turnId:'turn',item}]};
 assert.equal(decodeRpc('thread/timeline/list',timeline),timeline);
 assert.throws(()=>decodeNotification({...notification,params:{...notification.params,item:{...item,aggregatedOutput:42}}}),/Invalid native notification/);
});
