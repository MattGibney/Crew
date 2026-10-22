// AI-011: durable, correlated lifecycle intents for concurrent independent workers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTask, readTask, updateTask, reportTask, answerQuestion, requestWorkerAction, updateWorkNotes } from '../runtime/orchestration/store.mjs';
const roots=[];
test.after(async()=>Promise.all(roots.map(root=>rm(root,{recursive:true,force:true}))));
async function fixture(){const dir=await mkdtemp(join(tmpdir(),'crew-lifecycle-test-'));roots.push(dir);return dir;}
const task = id => ({requestId:id,ticket:'AI-011',brief:`Audit ${id}`,projectId:'crew',repositoryId:'primary'});
async function running(dir,id,runId){await createTask(dir,task(id));return updateTask(dir,id,t=>{t.status='running';t.runId=runId;});}
test('independent tasks create and run concurrently while request retries preserve identity',async()=>{
 const dir=await fixture();
 await Promise.all(['worker-alpha','worker-beta'].map(id=>running(dir,id,`run-${id}`)));
 assert.equal((await readTask(dir,'worker-alpha')).status,'running');
 assert.equal((await readTask(dir,'worker-beta')).status,'running');
 const existing=await readTask(dir,'worker-alpha');
 assert.equal((await createTask(dir,task('worker-alpha'))).revision,existing.revision);
 await assert.rejects(createTask(dir,{...task('worker-alpha'),brief:'changed'}),/Request ID/);
 await assert.rejects(updateTask(dir,'worker-alpha',t=>{t.repositoryId='other';}),/immutable/);
});
test('worker lifecycle action retries are idempotent, targeted, correlated and serialized',async()=>{
 const dir=await fixture();await Promise.all(['worker-alpha','worker-beta'].map(id=>running(dir,id,`run-${id}`)));
 const args={taskId:'worker-alpha',actionId:'action-pause',action:'pause',expectedRunId:'run-worker-alpha'};
 const [first,retry]=await Promise.all([requestWorkerAction(dir,args),requestWorkerAction(dir,args)]);
 assert.equal(first.lifecycleRequests.length,1);assert.equal(retry.revision,first.revision);
 assert.equal(first.status,'running');assert.deepEqual((await readTask(dir,'worker-beta')).lifecycleRequests,[]);
 await assert.rejects(requestWorkerAction(dir,{...args,action:'stop'}),/changed content/);
 await assert.rejects(requestWorkerAction(dir,{...args,actionId:'action-stale',expectedRunId:'older-run'}),/Stale/);
 await assert.rejects(requestWorkerAction(dir,{...args,actionId:'action-second',action:'stop'}),/pending/);
 await updateTask(dir,'worker-alpha',t=>{t.lifecycleRequests[0].status='completed';t.runId='next-run';t.status='paused';});
 assert.equal((await requestWorkerAction(dir,args)).lifecycleRequests.length,1);
 await assert.rejects(requestWorkerAction(dir,{...args,actionId:'action-new'}),/Stale/);
 const next=await requestWorkerAction(dir,{...args,actionId:'action-resume',action:'resume',expectedRunId:'next-run'});
 assert.equal(next.lifecycleRequests.length,2);assert.equal(next.status,'paused');
});
test('questions and worker reports cannot cross task or stale run boundaries',async()=>{
 const dir=await fixture();await Promise.all(['worker-alpha','worker-beta'].map(id=>running(dir,id,`run-${id}`)));
 await reportTask(dir,'worker-alpha','run-worker-alpha',{reportId:'question-report',kind:'question',message:'Which scope?'});
 await updateTask(dir,'worker-alpha',t=>{t.status='awaiting_answer';t.question={id:'question-alpha',runId:t.runId,message:'Which scope?'};});
 await assert.rejects(answerQuestion(dir,{taskId:'worker-beta',questionId:'question-alpha',answer:'Read only'}),/stale or unknown/);
 await assert.rejects(reportTask(dir,'worker-beta','run-worker-alpha',{reportId:'wrong-report',kind:'progress',message:'Cross worker'}),/Stale worker/);
 const answered=await answerQuestion(dir,{taskId:'worker-alpha',questionId:'question-alpha',answer:'Read only'});
 assert.equal(answered.status,'resume_queued');
 assert.equal((await answerQuestion(dir,{taskId:'worker-alpha',questionId:'question-alpha',answer:'Read only'})).revision,answered.revision);
 await assert.rejects(answerQuestion(dir,{taskId:'worker-alpha',questionId:'question-alpha',answer:'Edit everything'}),/differently/);
 assert.equal((await readTask(dir,'worker-beta')).status,'running');
});
test('legacy task records accept lifecycle requests; disposal never deletes durable history',async()=>{
 const dir=await fixture();await createTask(dir,task('worker-legacy'));
 await updateTask(dir,'worker-legacy',t=>{delete t.lifecycleRequests;t.status='stopped';});
 const t=await requestWorkerAction(dir,{taskId:'worker-legacy',actionId:'action-dispose',action:'dispose'});
 assert.equal(t.lifecycleRequests[0].expectedRunId,null);
 await updateTask(dir,'worker-legacy',t=>{t.lifecycleRequests[0].status='completed';t.status='disposed';});
 assert.equal((await readTask(dir,'worker-legacy')).ticket,'AI-011');
 await assert.rejects(updateWorkNotes(dir,'worker-legacy',{updateId:'archived-edit',markdown:'Do not overwrite historical notes'}),/read-only/);
 await assert.rejects(requestWorkerAction(dir,{taskId:'worker-legacy',actionId:'action-restart',action:'start'}),/archived/);
});
test('manager lifecycle MCP is project-scoped; bound worker exposes messaging, workflow and environment context without manager lifecycle controls',async()=>{
 const {spawn}=await import('node:child_process');const {writeFile}=await import('node:fs/promises');
 const dir=await fixture();await running(dir,'worker-alpha','run-worker-alpha');
 const runtime=join(dir,'runtime.json');await writeFile(runtime,JSON.stringify({project:{id:'crew',mode:'repository'}}));
 async function rpc(role,extra,method,params){
  const child=spawn(process.execPath,[fileURLToPath(new URL('../runtime/orchestration-mcp.mjs',import.meta.url)),dir,role,...extra]);
  let output='',errors='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>errors+=d);
  child.stdin.end(JSON.stringify({jsonrpc:'2.0',id:1,method,params})+'\n');
  const code=await new Promise(resolve=>child.on('close',resolve));assert.equal(code,0,errors);return JSON.parse(output.trim()).result;
 }
 const args={taskId:'worker-alpha',actionId:'mcp-action-stop',action:'stop',expectedRunId:'run-worker-alpha'};
 const queued=await rpc('manager',[runtime],'tools/call',{name:'worker_action',arguments:args});
 assert.equal(queued.isError,undefined);assert.equal(JSON.parse(queued.content[0].text).lifecycleRequests[0].action,'stop');
 await writeFile(runtime,JSON.stringify({project:{id:'another',mode:'repository'}}));
 const denied=await rpc('manager',[runtime],'tools/call',{name:'worker_action',arguments:{...args,actionId:'mcp-other-action'}});
 assert.match(denied.content[0].text,/another project/);
 await updateTask(dir,'worker-alpha',task=>{task.status='disposed';task.archivedAt='2026-10-21T10:00:00Z';task.lifecycleRequests[0].status='completed';});
 await writeFile(runtime,JSON.stringify({project:{id:'crew',mode:'repository'}}));
 const active=await rpc('manager',[runtime],'tools/call',{name:'get_status',arguments:{}});
 assert.deepEqual(JSON.parse(active.content[0].text),[]);
 const history=await rpc('manager',[runtime],'tools/call',{name:'get_status',arguments:{taskId:'worker-alpha'}});
 assert.equal(JSON.parse(history.content[0].text).status,'disposed');
 await writeFile(runtime,JSON.stringify({project:{id:'another',mode:'repository'}}));
 const foreignHistory=await rpc('manager',[runtime],'tools/call',{name:'get_status',arguments:{taskId:'worker-alpha'}});
 assert.match(foreignHistory.content[0].text,/another project/);
 const tools=await rpc('worker',['worker-alpha','run-worker-alpha'],'tools/list',{});
 assert.deepEqual(tools.tools.map(t=>t.name),['report','set_workflow_state','get_project_environment','update_work_notes','get_preparation_request','report_preparation']);
 const workerDenied=await rpc('worker',['worker-alpha','run-worker-alpha'],'tools/call',{name:'worker_action',arguments:args});
 assert.equal(workerDenied.isError,true);assert.match(workerDenied.content[0].text,/Unknown tool/);
});


test('answering a retained stopped or paused question resumes the same task and rejects competing lifecycle intent',async()=>{
 const dir=await fixture();
 for(const [index,status]of ['stopped','paused'].entries()){
  const id=`question-worker-${index}`,runId=`question-run-${index}`;await running(dir,id,runId);await reportTask(dir,id,runId,{reportId:'retained-question',kind:'question',message:'Continue this same work?'});await updateTask(dir,id,t=>{t.status=status;t.question={id:'retained-question',runId,message:'Continue this same work?'};});
  const action=await requestWorkerAction(dir,{taskId:id,actionId:`pending-stop-${index}`,action:'stop',expectedRunId:runId});await assert.rejects(answerQuestion(dir,{taskId:id,questionId:'retained-question',answer:'Yes, resume the same task.'}),/pending worker lifecycle/);
  await updateTask(dir,id,t=>{t.lifecycleRequests[0].status='completed';});const answered=await answerQuestion(dir,{taskId:id,questionId:'retained-question',answer:'Yes, resume the same task.'});assert.equal(answered.status,'resume_queued');assert.equal(answered.runId,runId);assert.equal(answered.answer.questionId,'retained-question');
 }
});
