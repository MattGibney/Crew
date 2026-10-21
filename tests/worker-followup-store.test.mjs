import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createTask, updateTask, readTask, currentAssignment, ensureAssignments, requestWorkerFollowup, reportTask, requestWorkerAction, requestWorkerFollowupAdoption } from '../orchestration-store.mjs';
import { buildWorkerInstructions } from '../prompt-settings.mjs';
async function fixture(t, status='completed') {
  const dir=await mkdtemp(join(tmpdir(),'crew-followup-store-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  await createTask(dir,{requestId:'worker-alpha',ticket:'AI-42',brief:'Research only',projectId:'crew',repositoryId:'primary'});
  await updateTask(dir,'worker-alpha',task=>{task.status=status;task.runId='run-research';if(status==='completed')task.result={message:'Research result',evidence:['research proof']};});
  return dir;
}
const request=(overrides={})=>({taskId:'worker-alpha',requestId:'followup-implementation',expectedRunId:'run-research',expectedAssignmentId:'initial',ticket:'AI-42',brief:'Implement the researched fix',userDecision:'User explicitly asked this same worker to implement the fix',...overrides});
test('legacy completion queues new immutable scope, exact retry survives later assignments and restart',async t=>{
  const dir=await fixture(t);const before=await readTask(dir,'worker-alpha');
  assert.equal(before.assignments,undefined);assert.equal(currentAssignment(before).id,'initial');
  const queued=await requestWorkerFollowup(dir,request());
  assert.equal(queued.status,'completed');assert.equal(queued.currentAssignmentId,'initial');assert.equal(queued.brief,'Research only');
  assert.deepEqual(queued.assignments[0].result,before.result);assert.equal(queued.assignments[1].status,'queued');
  const research=structuredClone(queued.assignments[0]);
  assert.equal((await requestWorkerFollowup(dir,request())).revision,queued.revision);
  await updateTask(dir,'worker-alpha',task=>{task.currentAssignmentId='followup-implementation';task.status='resume_queued';delete task.result;});
  await updateTask(dir,'worker-alpha',task=>{task.failure=null;});
  assert.deepEqual(currentAssignment(await readTask(dir,'worker-alpha')).runIds,[]);
  await updateTask(dir,'worker-alpha',task=>{task.runId='run-implementation';task.status='running';});
  await reportTask(dir,'worker-alpha','run-implementation',{reportId:'implementation-result',kind:'result',message:'Implemented',evidence:['tested']});
  await updateTask(dir,'worker-alpha',task=>{task.status='completed';task.result={message:'Implemented',evidence:['tested']};});
  let persisted=await readTask(dir,'worker-alpha');assert.deepEqual(persisted.assignments[0],research);
  assert.deepEqual(currentAssignment(persisted).runIds,['run-implementation']);
  // resume_queued retains the old run ID until launch; it belongs to the old assignment only.
  assert.equal(persisted.reports[0].assignmentId,'followup-implementation');
  const retry=await requestWorkerFollowup(dir,request());assert.equal(retry.assignments.length,2);
  await assert.rejects(requestWorkerFollowup(dir,request({brief:'Different scope'})),/changed content/);
  await requestWorkerFollowup(dir,request({requestId:'followup-additional',expectedRunId:'run-implementation',expectedAssignmentId:'followup-implementation',brief:'Additional explicit work'}));
  persisted=await readTask(dir,'worker-alpha');assert.equal(persisted.assignments.length,3);assert.equal(persisted.history.filter(event=>event.kind==='instruction').length,3);
  await assert.rejects(updateTask(dir,'worker-alpha',task=>{task.assignments[0].result.message='Overwritten';}),/immutable/);
  await assert.rejects(updateTask(dir,'worker-alpha',task=>{task.assignments[2].brief='Overwritten';}),/immutable/);
  await assert.rejects(reportTask(dir,'worker-alpha','run-research',{reportId:'late-research',kind:'result',message:'Stale'}),/Stale/);
});
test('busy directions queue without interrupting; stale identity and disposal cannot admit new scope',async t=>{
  const dir=await fixture(t,'running');
  const queued=await requestWorkerFollowup(dir,request());assert.equal(queued.status,'running');assert.equal(queued.runId,'run-research');
  await assert.rejects(requestWorkerFollowup(dir,request({requestId:'followup-stale-run',expectedRunId:'older-run'})),/Stale/);
  await assert.rejects(requestWorkerFollowup(dir,request({requestId:'followup-stale-assignment',expectedAssignmentId:'other-assignment'})),/Stale/);
  await requestWorkerAction(dir,{taskId:'worker-alpha',actionId:'dispose-action',action:'dispose',expectedRunId:'run-research'});
  await assert.rejects(requestWorkerFollowup(dir,request({requestId:'followup-after-dispose'})),/dispos/);
  assert.equal((await requestWorkerFollowup(dir,request())).assignments.length,2);
});
test('malformed authorization and assignment history fail closed',async t=>{
  const dir=await fixture(t);
  for(const overrides of [{userDecision:''},{expectedRunId:undefined},{expectedAssignmentId:''}]) await assert.rejects(requestWorkerFollowup(dir,request(overrides)),/Invalid/);
  await updateTask(dir,'worker-alpha',task=>ensureAssignments(task) && undefined);
  await assert.rejects(updateTask(dir,'worker-alpha',task=>{task.assignments=[];}),/immutable|Malformed/);
});
async function rpc(dir,role,extra,method,params){
  const child=spawn(process.execPath,[fileURLToPath(new URL('../orchestration-mcp.mjs',import.meta.url)),dir,role,...extra]);
  let out='',err='';child.stdout.on('data',v=>out+=v);child.stderr.on('data',v=>err+=v);
  child.stdin.end(JSON.stringify({jsonrpc:'2.0',id:1,method,params})+'\n');
  assert.equal(await new Promise(resolve=>child.on('close',resolve)),0,err);return JSON.parse(out).result;
}
test('follow-up MCP is manager only, project scoped and verifies configured ticket identifiers',async t=>{
  const dir=await fixture(t);const runtime=join(dir,'runtime.json');await writeFile(runtime,JSON.stringify({project:{id:'crew',mode:'repository',repositories:[{id:'primary'}],linear:{teamKey:'AI'}}}));
  const worker=await rpc(dir,'worker',['worker-alpha','run-research'],'tools/list',{});assert.ok(!worker.tools.some(tool=>tool.name==='assign_worker_followup'));
  const invalid=await rpc(dir,'manager',[runtime],'tools/call',{name:'assign_worker_followup',arguments:request({ticket:'OTHER-42'})});assert.equal(invalid.isError,true);
  const valid=await rpc(dir,'manager',[runtime],'tools/call',{name:'assign_worker_followup',arguments:request()});assert.ok(!valid.isError,JSON.stringify(valid));
  await writeFile(runtime,JSON.stringify({project:{id:'other',mode:'fixture'}}));
  const foreign=await rpc(dir,'manager',[runtime],'tools/call',{name:'assign_worker_followup',arguments:request()});assert.equal(foreign.isError,true);assert.match(foreign.content[0].text,/another project/);
});
test('continuation instructions bind current scope and actual user decision without widening permissions',()=>{
  const prompt=buildWorkerInstructions({taskId:'worker-alpha',assignmentId:'followup-implementation',runId:'run-implementation',ticket:'AI-42',brief:'Implement',userDecision:'User approved implementation',project:{mode:'repository'}});
  assert.match(prompt,/followup-implementation/);assert.match(prompt,/User approved implementation/);assert.match(prompt,/Historical research-only scope/);assert.match(prompt,/available permissions do not widen/);
});

test('historical reports cannot exhaust the next retained assignment report budget',async t=>{
  const dir=await fixture(t);
  await updateTask(dir,'worker-alpha',task=>{task.reports=Array.from({length:300},(_,i)=>({reportId:`historical-${i}`,runId:'run-research',kind:'progress',message:'Retained research evidence',evidence:[],at:task.createdAt}));});
  await requestWorkerFollowup(dir,request());
  await updateTask(dir,'worker-alpha',task=>{task.currentAssignmentId='followup-implementation';task.runId='run-implementation';task.status='running';task.result=null;});
  await reportTask(dir,'worker-alpha','run-implementation',{reportId:'new-progress',kind:'progress',message:'Implementation evidence'});
  const task=await readTask(dir,'worker-alpha');assert.equal(task.reports.length,301);assert.equal(task.reports.at(-1).assignmentId,'followup-implementation');
});

test('queued adoption is append-only, explicitly correlated and retries survive activation',async t=>{
 const dir=await fixture(t);await requestWorkerFollowup(dir,request());
 const args={taskId:'worker-alpha',assignmentId:'followup-implementation',requestId:'adoption-reviewed',expectedRunId:'run-research',fingerprint:'a'.repeat(64),userDecision:'User reviewed and adopted these exact preserved edits'};
 const first=await requestWorkerFollowupAdoption(dir,args);assert.equal(first.assignments[1].adoptions.length,1);
 assert.equal((await requestWorkerFollowupAdoption(dir,args)).revision,first.revision);
 await assert.rejects(requestWorkerFollowupAdoption(dir,{...args,requestId:'adoption-stale',expectedRunId:'stale'}),/Stale/);
 await assert.rejects(requestWorkerFollowupAdoption(dir,{...args,fingerprint:'b'.repeat(64)}),/changed content/);
 await assert.rejects(updateTask(dir,'worker-alpha',task=>{task.assignments[1].adoptions[0].userDecision='Invented';}),/immutable/);
 await updateTask(dir,'worker-alpha',task=>{task.currentAssignmentId='followup-implementation';task.status='running';task.runId='run-next';task.result=null;});
 assert.equal((await requestWorkerFollowupAdoption(dir,args)).assignments[1].adoptions.length,1);
 await assert.rejects(requestWorkerFollowupAdoption(dir,{...args,requestId:'adoption-active',expectedRunId:'run-next'}),/queued/);
 await updateTask(dir,'worker-alpha',task=>{task.status='failed';});
 const recovered=await requestWorkerFollowupAdoption(dir,{...args,requestId:'adoption-recovery',expectedRunId:'run-next'});assert.equal(recovered.assignments[1].adoptions.length,2);
});
