import test from 'node:test';
import assert from 'node:assert/strict';
import {parseApiInput} from '../runtime/http/input.mjs';
import {parseWorkerApproval} from '../runtime/http/approval-input.mjs';
test('worker approval decoder preserves numeric native identity and null startup turn',()=>{
 const input={taskId:'worker-0001',runId:'run-0001',approvalId:'approval-0001',threadId:'thread-0001',turnId:null,requestId:12,response:{action:'cancel'}};
 assert.deepEqual(parseWorkerApproval(input),input);
 assert.equal(parseApiInput(input).requestId,''); // /api/work still rejects non-string id.
 assert.equal(parseWorkerApproval(input).requestId,12);
 assert.throws(()=>parseWorkerApproval({...input,turnId:undefined}),/identity/);
});
test('request decoder rejects malformed structured and primitive fields',()=>{
 assert.throws(()=>parseApiInput([]),/JSON object/);
 assert.throws(()=>parseApiInput({sdp:42}),/sdp/);
 assert.throws(()=>parseApiInput({response:'approve'}),/JSON object/);
});
