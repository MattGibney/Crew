import test from 'node:test';
import assert from 'node:assert/strict';
import {toolArguments} from '../runtime/backend/mcp-contracts.mjs';
import {orchestrationTools} from '../runtime/backend/mcp-tools.mjs';

test('nullable native run identity preserves null but rejects blank and overlong strings',()=>{
 const tool=orchestrationTools('manager',true).find(tool=>tool.name==='request_worker_recovery');
 const input={taskId:'retained-task',actionId:'recovery-action',action:'reconcile_plan',expectedRunId:null,reviewHash:'a'.repeat(64),decision:'Human approved these retained lifecycle metadata changes.'};
 assert.equal(toolArguments(tool,input).expectedRunId,null);
 for(const expectedRunId of ['', '   ', 'r'.repeat(161)]) assert.throws(()=>toolArguments(tool,{...input,expectedRunId}),/Invalid expectedRunId/);
 assert.equal(toolArguments(tool,{...input,expectedRunId:'run-current'}).expectedRunId,'run-current');
});
