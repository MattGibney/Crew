import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createTask, updateTask, readTask, currentAssignment, ensureAssignments, requestWorkerFollowup, reportTask, requestWorkerAction, setWorkflowState } from '../runtime/orchestration/store.mjs';
import { buildWorkerInstructions } from '../runtime/manager/instructions/settings.mjs';
async function fixture(t, status='completed') {
  const dir=await mkdtemp(join(tmpdir(),'crew-followup-store-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  await createTask(dir,{requestId:'worker-alpha',ticket:'AI-42',brief:'Research only',projectId:'crew',repositoryId:'primary'});
  await updateTask(dir,'worker-alpha',task=>{task.status=status;task.runId='run-research';if(status==='completed')task.result={message:'Research result',evidence:['research proof']};});
  return dir;
}
const request=(overrides={})=>({taskId:'worker-alpha',requestId:'followup-implementation',expectedRunId:'run-research',expectedAssignmentId:'initial',ticket:'AI-42',brief:'Implement the researched fix',...overrides});
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
test('busy directions accept observed stale IDs while actual disposal remains unavailable',async t=>{
  const dir=await fixture(t,'running');
  const queued=await requestWorkerFollowup(dir,request());assert.equal(queued.status,'running');assert.equal(queued.runId,'run-research');
  const observed=await requestWorkerFollowup(dir,request({requestId:'followup-stale-run',expectedRunId:'older-run'}));assert.equal(observed.assignments.at(-1).enqueuedRunId,'run-research');
  await requestWorkerFollowup(dir,request({requestId:'followup-stale-assignment',expectedAssignmentId:'other-assignment'}));
  await requestWorkerAction(dir,{taskId:'worker-alpha',actionId:'dispose-action',action:'dispose',expectedRunId:'run-research'});
  await assert.rejects(requestWorkerFollowup(dir,request({requestId:'followup-after-dispose'})),/dispos/);
  assert.equal((await requestWorkerFollowup(dir,request())).assignments.length,4);
});
test('malformed transport data and assignment history fail closed',async t=>{
  const dir=await fixture(t);
  for(const overrides of [{brief:''},{requestId:'bad'},{expectedAssignmentId:''}]) await assert.rejects(requestWorkerFollowup(dir,request(overrides)),/Invalid/);
  await updateTask(dir,'worker-alpha',task=>ensureAssignments(task) && undefined);
  await assert.rejects(updateTask(dir,'worker-alpha',task=>{task.assignments=[];}),/immutable|Malformed/);
});
async function rpc(dir,role,extra,method,params){
  const child=spawn(process.execPath,[fileURLToPath(new URL('../runtime/orchestration-mcp.mjs',import.meta.url)),dir,role,...extra]);
  let out='',err='';child.stdout.on('data',v=>out+=v);child.stderr.on('data',v=>err+=v);
  child.stdin.end(JSON.stringify({jsonrpc:'2.0',id:1,method,params})+'\n');
  assert.equal(await new Promise(resolve=>child.on('close',resolve)),0,err);return JSON.parse(out).result;
}
test('follow-up MCP is manager only and project scoped without ticket or adoption gates',async t=>{
  const dir=await fixture(t);const runtime=join(dir,'runtime.json');await writeFile(runtime,JSON.stringify({project:{id:'crew',mode:'repository',repositories:[{id:'primary'}],linear:{teamKey:'AI'}}}));
  const worker=await rpc(dir,'worker',['worker-alpha','run-research'],'tools/list',{});assert.ok(!worker.tools.some(tool=>tool.name==='assign_worker_followup'));
  const tools=await rpc(dir,'manager',[runtime],'tools/list',{});assert.ok(!tools.tools.some(tool=>['review_worker_followup','approve_worker_followup_changes'].includes(tool.name)));
  const accepted=await rpc(dir,'manager',[runtime],'tools/call',{name:'assign_worker_followup',arguments:request({requestId:'direction-other-ticket',ticket:'OTHER-42'})});assert.ok(!accepted.isError);
  const valid=await rpc(dir,'manager',[runtime],'tools/call',{name:'assign_worker_followup',arguments:request()});assert.ok(!valid.isError,JSON.stringify(valid));
  await writeFile(runtime,JSON.stringify({project:{id:'other',mode:'fixture'}}));
  const foreign=await rpc(dir,'manager',[runtime],'tools/call',{name:'assign_worker_followup',arguments:request()});assert.equal(foreign.isError,true);assert.match(foreign.content[0].text,/another project/);
});
test('continuation instructions carry direction and native Codex approval boundary',()=>{
  const prompt=buildWorkerInstructions({taskId:'worker-alpha',assignmentId:'followup-implementation',runId:'run-implementation',ticket:'AI-42',brief:'Implement',userDecision:'User approved implementation',project:{mode:'repository'}});
  assert.match(prompt,/followup-implementation/);assert.match(prompt,/Native Codex configuration and approvals remain the execution boundary/);assert.doesNotMatch(prompt,/Actual user authorization|Human decision preserving/);
});

test('historical reports cannot exhaust the next retained assignment report budget',async t=>{
  const dir=await fixture(t);
  await updateTask(dir,'worker-alpha',task=>{task.reports=Array.from({length:300},(_,i)=>({reportId:`historical-${i}`,runId:'run-research',kind:'progress',message:'Retained research evidence',evidence:[],at:task.createdAt}));});
  await requestWorkerFollowup(dir,request());
  await updateTask(dir,'worker-alpha',task=>{task.currentAssignmentId='followup-implementation';task.runId='run-implementation';task.status='running';task.result=null;});
  await reportTask(dir,'worker-alpha','run-implementation',{reportId:'new-progress',kind:'progress',message:'Implementation evidence'});
  const task=await readTask(dir,'worker-alpha');assert.equal(task.reports.length,301);assert.equal(task.reports.at(-1).assignmentId,'followup-implementation');
});

test('fresh directions need only worker target, stable request and text; legacy adoption evidence remains',async t=>{
 const dir=await fixture(t);
 const args={taskId:'worker-alpha',requestId:'simple-direction',brief:'Implement this now'};
 const first=await requestWorkerFollowup(dir,args);const assignment=first.assignments.at(-1);
 assert.equal(assignment.ticket,'AI-42');assert.equal(assignment.userDecision,undefined);assert.equal(assignment.enqueuedAssignmentId,'initial');
 await updateTask(dir,'worker-alpha',task=>{task.assignments.at(-1).adoptions=[{id:'legacy-adoption',expectedRunId:'run-research',fingerprint:'a'.repeat(64),userDecision:'Historical decision',at:task.createdAt}];});
 await updateTask(dir,'worker-alpha',task=>{task.currentAssignmentId='simple-direction';task.runId='run-next';task.status='running';task.result=null;});
 const retry=await requestWorkerFollowup(dir,args);assert.equal(retry.assignments.length,2);assert.equal(retry.assignments[1].adoptions.length,1);
 await assert.rejects(requestWorkerFollowup(dir,{...args,brief:'Different direction'}),/changed content/);
});

test('report history never expires a live worker and instruction profiles can refresh',async t=>{
 const dir=await fixture(t,'running');
 await updateTask(dir,'worker-alpha',task=>{task.reports=Array.from({length:300},(_,i)=>({reportId:`progress-${i}`,runId:'run-research',kind:'progress',message:'Retained progress',evidence:[],at:task.createdAt}));});
 await reportTask(dir,'worker-alpha','run-research',{reportId:'progress-after-history',kind:'progress',message:'Still working'});
 assert.equal((await readTask(dir,'worker-alpha')).reports.length,301);
 const {promptSnapshot}=await import('../runtime/manager/instructions/settings.mjs');
 await updateTask(dir,'worker-alpha',task=>{task.workerPromptSnapshot=promptSnapshot('Original instructions');});
 await updateTask(dir,'worker-alpha',task=>{task.workerPromptSnapshot=promptSnapshot('Current instructions');});
 const current=await readTask(dir,'worker-alpha');assert.equal(current.workerPromptSnapshot.text,'Current instructions');assert.equal(current.history.filter(event=>event.kind==='configuration').length,2);
});

test('explicit project workflow state is durable, arbitrary, and independent of reports or execution',async t=>{
 const dir=await fixture(t,'running');
 await setWorkflowState(dir,{taskId:'worker-alpha',requestId:'workflow-review-ready',state:'Ready for design review / team custom state'});
 let task=await readTask(dir,'worker-alpha');assert.equal(task.status,'running');assert.equal(task.workflowState.value,'Ready for design review / team custom state');assert.equal(task.workflowState.runId,'run-research');
 await reportTask(dir,'worker-alpha','run-research',{reportId:'reported-question',kind:'question',message:'Can you review this?'});
 await reportTask(dir,'worker-alpha','run-research',{reportId:'reported-result',kind:'result',message:'Current result for discussion'});
 await reportTask(dir,'worker-alpha','run-research',{reportId:'reported-after-result',kind:'progress',message:'Continuing the same native turn'});
 await updateTask(dir,'worker-alpha',task=>{task.status='paused';});
 task=await readTask(dir,'worker-alpha');assert.equal(task.workflowHistory.length,1);assert.equal(task.workflowState.value,'Ready for design review / team custom state');
 await setWorkflowState(dir,{taskId:'worker-alpha',requestId:'workflow-native-review',state:'Changes requested',actor:'worker',runId:'run-research'});
 await updateTask(dir,'worker-alpha',task=>{task.runId='run-new';task.status='running';});
 const retry=await setWorkflowState(dir,{taskId:'worker-alpha',requestId:'workflow-review-ready',state:'Ready for design review / team custom state'});assert.equal(retry.workflowState.value,'Changes requested');assert.equal(retry.workflowHistory.length,2);
 await assert.rejects(setWorkflowState(dir,{taskId:'worker-alpha',requestId:'workflow-stale-worker',state:'Wrong run',actor:'worker',runId:'run-research'}),/Stale/);
 await assert.rejects(setWorkflowState(dir,{taskId:'worker-alpha',requestId:'workflow-review-ready',state:'Different value'}),/changed content/);
 await assert.rejects(updateTask(dir,'worker-alpha',task=>{task.workflowHistory[0].value='Overwritten';}),/immutable/);
});
test('manager and worker workflow tools preserve identity and expose environment as context without running commands',async t=>{
 const dir=await fixture(t,'running'),runtime=join(dir,'runtime.json');
 const project={id:'crew',mode:'repository',readiness:{ready:false,issues:['No Linear connection']},repositories:[{id:'primary',path:'/configured/repository'}],worker:{environment:{bootstrap:'echo setup-not-automatic',start:'echo agent-start-command',executionPlan:{env:{PRIVATE_VALUE:'not-command-context'},instructions:[{path:'AGENTS.md',content:'Run existing tools.'}]}}}};
 await writeFile(runtime,JSON.stringify({project}));
 const created=await rpc(dir,'manager',[runtime],'tools/call',{name:'submit_task',arguments:{requestId:'worker-no-policy-gates',repositoryId:'primary',brief:'Research and implement'}});assert.ok(!created.isError,JSON.stringify(created));assert.equal(JSON.parse(created.content[0].text).ticket,'');
 const ownDir=join(dir,'runs','worker-alpha','run-research');await mkdir(ownDir,{recursive:true});await writeFile(join(ownDir,'config.json'),JSON.stringify({taskId:'worker-alpha',runId:'run-research',project}));
 for(const [role,extra,args] of [['manager',[runtime],{taskId:'worker-alpha'}],['worker',['worker-alpha','run-research'],{}]]){
  const env=await rpc(dir,role,extra,'tools/call',{name:'get_project_environment',arguments:args});assert.ok(!env.isError,JSON.stringify(env));const value=JSON.parse(env.content[0].text);assert.equal(value.configuredEnvironment.start,'echo agent-start-command');assert.equal(value.configuredEnvironment.executionPlan.env,undefined);assert.equal(value.configuredEnvironment.executionPlan.instructions[0].content,'Run existing tools.');
  const label=await rpc(dir,role,extra,'tools/call',{name:'set_workflow_state',arguments:{...args,requestId:`workflow-tool-${role}`,state:`Custom ${role} state`}});assert.ok(!label.isError,JSON.stringify(label));assert.equal(JSON.parse(label.content[0].text).workflowState.actor,role);
 }
 const task=await readTask(dir,'worker-alpha');assert.equal(task.status,'running');assert.equal(task.environment,undefined);assert.equal(task.workflowHistory.length,2);
 const wrong=await rpc(dir,'worker',['worker-alpha','older-run'],'tools/call',{name:'set_workflow_state',arguments:{requestId:'workflow-tool-stale',state:'Wrong'}});assert.equal(wrong.isError,true);
});
test('legacy exact direction retries retain idempotency without requiring new metadata',async t=>{
 const dir=await fixture(t);await updateTask(dir,'worker-alpha',task=>{ensureAssignments(task);task.assignments.push({id:'legacy-followup-request',ticket:'AI-42',brief:'Legacy direction',userDecision:'Recorded historical authorization',reviewedWorktreeFingerprint:'a'.repeat(64),expectedRunId:'run-research',expectedAssignmentId:'initial',status:'queued',createdAt:task.createdAt,runIds:[]});});
 const before=await readTask(dir,'worker-alpha');
 const retry=await requestWorkerFollowup(dir,{taskId:'worker-alpha',requestId:'legacy-followup-request',ticket:'AI-42',brief:'Legacy direction',userDecision:'Recorded historical authorization',reviewedWorktreeFingerprint:'a'.repeat(64),expectedRunId:'run-research',expectedAssignmentId:'initial'});
 assert.equal(retry.revision,before.revision);assert.equal(retry.assignments.length,2);
});
