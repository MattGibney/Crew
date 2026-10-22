// Real local JSON-RPC peers, bound MCP tools, Git worktrees, supervisors and
// ownership evidence. No subscription, network service, installer or microphone.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath,access} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createBridge} from '../runtime/manager/bridge/index.mjs';
import {createController} from '../runtime/workers/controller.mjs';
import {createWorkerDirections} from '../runtime/workers/worker-directions.mjs';
import {createTask,readTask,updateTask,requestWorkerAction,requestWorkerFollowup} from '../runtime/orchestration/store.mjs';
import {createUpdatePlan,readUpdatePlan,isUpdatePlanHolding} from '../runtime/updates/plan.mjs';
import {inspectUpdateEvidence} from '../runtime/updates/evidence.mjs';
import {updateActivity} from '../runtime/updates/activity.mjs';
import {createPreparationCoordinator} from '../runtime/preparation/coordinator.mjs';
import {readPreparation} from '../runtime/preparation/store.mjs';
import {listWorkerRequests} from '../runtime/workers/approval-store.mjs';
import {createWorkspacePauseUpdate} from '../runtime/desktop/workspace-pause-update.mjs';
import {workspaceUpdateActivity} from '../runtime/desktop/workspace-update.mjs';
import {createPauseUpdateCoordinator} from '../runtime/desktop/updater.mjs';
import {createPreparationQuit} from '../runtime/desktop/preparation-quit.mjs';
import {configureGlobalCapacity,globalAdmissionPaused} from '../runtime/orchestration/capacity.mjs';

const exec=promisify(execFile),sourceDir=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../runtime');
const activeId='shared-preparation-worker',completedId='completed-preparation-worker';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,label){const deadline=Date.now()+40000;while(Date.now()<deadline){const result=await check();if(result)return result;await delay(60);}throw Error(`Timed out: ${label}`);}
const actorFile=(record,role,taskId=activeId)=>path.join(record.controls,role==='manager'?'manager':`worker-${taskId}`);
async function calls(record,role,taskId=activeId){return (await readFile(actorFile(record,role,taskId)+'.calls','utf8').catch(()=>'' )).trim().split('\n').filter(Boolean).map(JSON.parse);}

function peerProgram(record){return String.raw`#!${process.execPath}
import{createInterface}from'node:readline';import{spawn}from'node:child_process';import{readFileSync,existsSync,appendFileSync}from'node:fs';
const raw=process.argv.find(value=>value.startsWith('mcp_servers.local_orchestration.args='));
if(!raw)throw Error('Missing native bound MCP configuration');
const binding=JSON.parse(raw.slice(raw.indexOf('=')+1)),role=binding[2],taskId=binding[3],actor=role==='manager'?'manager':'worker-'+taskId;
const base=${JSON.stringify(record.controls)}+'/'+actor,threadId=${JSON.stringify(record.id)}+'-'+actor+'-thread',turnId=${JSON.stringify(record.id)}+'-'+actor+'-turn';
const log=value=>appendFileSync(base+'.calls',JSON.stringify(value)+'\n');
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
let active=false,delivered=false,workflow=false,reported='',polling=false,approvalSent=false,approvalWithdrawn=false,ending=false;
async function tool(name,args){
 log({kind:'bound-mcp',name,args});
 const child=spawn(process.execPath,binding,{stdio:['pipe','pipe','pipe']});let result,failure='',received=false;
 child.stderr.on('data',data=>{failure+=data.toString().slice(0,2000);});
 const closed=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>code===0?resolve():reject(Error('Bound MCP exited '+code+' '+failure)));});
 createInterface({input:child.stdout}).on('line',line=>{const reply=JSON.parse(line);if(reply.id!==2)return;received=true;
 if(reply.error||reply.result?.isError){failure=reply.error?.message||reply.result?.content?.[0]?.text||'MCP tool failed';}
 else {result=JSON.parse(reply.result.content[0].text);failure='';}
 child.stdin.end();});
 child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'disposable-native-peer',version:'1'}}})+'\n');
 child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name,arguments:args}})+'\n');
 await closed;if(!received||failure)throw Error(failure||'Missing bound MCP response');return result;
}
async function poll(){if(polling||ending)return;polling=true;try{
 if((role==='manager'?existsSync(${JSON.stringify(record.controls)}+'/request-approval'):existsSync(base+'.request-approval'))&&!approvalSent){approvalSent=true;send({id:9000,method:'item/commandExecution/requestApproval',params:{threadId,turnId,itemId:'human-decision',command:'synthetic permission requiring a human'}});}
 if(approvalSent&&!approvalWithdrawn&&(role==='manager'?existsSync(${JSON.stringify(record.controls)}+'/withdraw-approval'):existsSync(base+'.withdraw-approval'))){approvalWithdrawn=true;send({method:'serverRequest/resolved',params:{threadId,requestId:9000}});}
 if(delivered){
  if(role==='worker'&&!workflow){await tool('set_workflow_state',{requestId:'workflow-working-request',state:'Implementing',progressPercent:40});await tool('set_workflow_state',{requestId:'workflow-ready-request',state:'Ready for review',progressPercent:100});workflow=true;log({kind:'workflow-only'});}
  let desired='none';try{desired=readFileSync(base+'.response','utf8').trim();}catch{}
  if(desired!=='none'&&desired!==reported){const request=await tool('get_preparation_request',{});if(!request)throw Error('Bound actor has no preparation request');
   await tool('report_preparation',{preparationId:request.preparationId,participantId:request.participantId,requestId:request.requestId,responseId:actor+'-'+desired,state:desired,note:desired==='needs-input'?'Fixture human decision required.':'Fixture context saved for '+request.purpose+'.',continuation:'Retain '+threadId+' and the dirty fixture file; no project command was needed.'});reported=desired;log({kind:'reported',state:desired});
  }
 }
 if(active&&existsSync(base+'.finish')){ending=true;active=false;send({method:'item/completed',params:{threadId,turnId,item:{id:actor+'-final-message',type:'agentMessage',text:'Final factual continuation for '+threadId+'.'}}});send({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed',items:[]}}});}
 }catch(error){log({kind:'fixture-error',message:error.message});}finally{polling=false;}}
const timer=setInterval(()=>void poll(),35);
process.stdin.on('end',()=>{clearInterval(timer);process.exit(0);});
process.on('SIGTERM',()=>{log({kind:'signal',signal:'SIGTERM'});process.exit(0);});
createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);log(m);if(m.id===undefined)return;if(!m.method)return;
 let result={};if(m.method==='account/read')result={account:{type:'chatgpt'}};if(m.method==='config/read')result={config:{sandbox_mode:'read-only',approval_policy:'on-request'}};
 if(m.method==='thread/start'||m.method==='thread/resume')result={thread:{id:threadId}};
 if(m.method==='thread/timeline/list'){send({id:m.id,error:{code:-32601,message:'Method not found'}});return;}
 if(m.method==='thread/turns/list'||m.method==='mcpServerStatus/list')result={data:[]};
 if(m.method==='turn/start'){active=true;result={turn:{id:turnId,status:'inProgress',items:[]}};send({method:'turn/started',params:{threadId,turn:result.turn}});}
 if(m.method==='turn/steer'){if(m.params.expectedTurnId!==turnId)throw Error('Preparation steered another native turn');result={turnId};delivered=true;}
 if(m.method==='turn/interrupt'){log({kind:'unexpected-interrupt'});send({id:m.id,error:{code:-32600,message:'Preparation must settle without interruption'}});return;}
 send({id:m.id,result});});
`;}

async function fixture(t,purpose){
 const directory=await realpath(await mkdtemp(path.join(tmpdir(),'crew-agent-preparation-'))),capacity=path.join(directory,'capacity');
 const records=['alpha','beta'].map(id=>({id,root:path.join(directory,id),repo:path.join(directory,id,'repo'),stateDir:path.join(directory,id,'state'),configPath:path.join(directory,id,'project.json'),controls:path.join(directory,id,'controls'),taskIds:[],controller:null,bridge:null,engine:null}));
 let group,cleaning=false;
 // Cleanup is registered before launching or observing any process. Product
 // assertions exclude this explicit fixture-only cancellation/shutdown boundary.
 t.after(async()=>{
  if(group?.isHolding())await group.cancel().catch(()=>{});
  cleaning=true;
  for(const record of records){
   for(const id of record.taskIds)await writeFile(actorFile(record,'worker',id)+'.finish','cleanup');
   await writeFile(actorFile(record,'manager')+'.finish','cleanup').catch(()=>{});
   if(record.controller){
    for(const id of record.taskIds){const task=await readTask(record.stateDir,id);if(task.harnessStarted&&!['paused','stopped','completed'].includes(task.status))await requestWorkerAction(record.stateDir,{taskId:id,actionId:'cleanup-stop-'+id,action:'stop',expectedRunId:task.runId}).catch(()=>{});}
    await until(async()=>{await record.controller.tick();return (await Promise.all(record.taskIds.map(id=>readTask(record.stateDir,id)))).every(task=>!task.harnessStarted||task.execution?.live===false);},'owned fixture worker cleanup');
    await record.controller.stop();
   }
   if(record.bridge)await record.bridge.shutdown();
  }
  await rm(directory,{recursive:true,force:true});
 });
 for(const record of records){
  await mkdir(record.repo,{recursive:true});await mkdir(record.stateDir);await mkdir(record.controls);
  await exec('git',['init','-b','main',record.repo]);await writeFile(path.join(record.repo,'README.md'),'Disposable project '+record.id+'\n');await exec('git',['-C',record.repo,'add','.']);await exec('git',['-C',record.repo,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','fixture']);
  record.project={id:'preparation-'+record.id,name:record.id==='alpha'?'Selected project':'Hidden project',mode:'repository',readiness:{ready:true},repositories:[{id:'repo',path:record.repo,baseRef:'main'}],worker:{sandbox:'read-only',timeoutMs:120000,maxConcurrent:1,environment:{bootstrap:{command:process.execPath,args:['-e',`require('fs').writeFileSync(${JSON.stringify(path.join(record.root,'unexpected-project-command'))},'unexpected')`],timeoutMs:3000}}}};
  await writeFile(record.configPath,JSON.stringify({project:record.project}));record.executable=path.join(record.root,'native-peer.mjs');await writeFile(record.executable,peerProgram(record),{mode:0o700});
 }
 await configureGlobalCapacity({dir:capacity,limit:2,stateDirs:records.map(record=>record.stateDir),admissionPaused:false});
 for(const record of records){
  record.controller=await createController({stateDir:record.stateDir,sourceDir,executable:record.executable,project:record.project,globalCapacity:{dir:capacity},admissionHeld:async()=>!cleaning&&(await globalAdmissionPaused(capacity)||isUpdatePlanHolding(await readUpdatePlan(record.stateDir)))});
  record.bridge=createBridge({cwd:sourceDir,statePath:path.join(record.root,'manager-chat.json'),executable:record.executable,project:record.project,orchestrationDir:record.stateDir,runtimeProjectPath:record.configPath,managerPrompt:'Disposable preparation fixture; retain factual context.'});
  record.view=async()=>inspectUpdateEvidence({stateDir:record.stateDir,view:await record.controller.view()});
  record.activity=async()=>updateActivity({work:record.bridge.state(),view:await record.view()});
  record.engine=createUpdatePlan({stateDir:record.stateDir,version:'0.16.2',getView:record.view,getManager:()=>record.bridge.state(),stopVoice:()=>record.bridge.stopVoice({cooperative:true}),interruptManager:()=>assert.fail('Preparation must never interrupt the manager'),requestAction:input=>requestWorkerAction(record.stateDir,input),activity:record.activity,preparation:createPreparationCoordinator({stateDir:record.stateDir,projectId:record.project.id,getManager:()=>record.bridge.state(),sendManager:(text,id,preparationId)=>record.bridge.startWork(text,id,{origin:{source:'preparation',operationId:preparationId}})})});await record.engine.ready;
  record.host={api:async route=>{if(route==='update-plan-status')return{plan:record.engine.status()};if(route==='update-activity')return record.activity();throw Error('Unexpected fixture route '+route);},updateToken:async(route,input)=>{assert.equal(await globalAdmissionPaused(capacity),true,'global hold precedes every child mutation');if(route==='update-plan-begin')return{plan:await record.engine.begin(input)};if(route==='update-plan-installing')return record.engine.markInstalling(input);if(route==='update-plan-cancel')return{plan:await record.engine.cancel()};if(route==='update-plan-blocked')return{plan:await record.engine.markBlocked(input.reason,input)};throw Error('Unexpected fixture mutation '+route);}};
 }
 const projects=()=>records.map(record=>({id:record.id,name:record.project.name,configPath:record.configPath,host:record.host}));
 group=createWorkspacePauseUpdate({path:path.join(directory,'group.json'),currentVersion:'0.16.2',projects,setAdmissionPaused:admissionPaused=>configureGlobalCapacity({dir:capacity,admissionPaused})});await group.ready;
 async function add(record,id){record.taskIds.push(id);await createTask(record.stateDir,{requestId:id,ticket:'GH-62',brief:'Retain disposable factual continuation',projectId:record.project.id,repositoryId:'repo'});await record.controller.tick();return until(async()=>{const task=await readTask(record.stateDir,id);return task.threadId&&task.execution?.live?task:null;},'live '+record.id+'/'+id);}
 const prior=await add(records[0],completedId);await writeFile(actorFile(records[0],'worker',completedId)+'.finish','finish previous assignment naturally');
 await until(async()=>{await records[0].controller.tick();return(await readTask(records[0].stateDir,completedId)).status==='completed';},'naturally completed prior assignment');
 const completed=await readTask(records[0].stateDir,completedId);
 for(const record of records){record.original=await add(record,activeId);await writeFile(path.join(record.original.worktree,'dirty-continuation.txt'),'Retain uncommitted '+record.id+' facts.\n');await record.bridge.startWork('Existing '+record.id+' manager conversation','initial-manager-'+record.id);assert.ok(record.bridge.state().activeTurnId);}
 const tick=async()=>{for(const record of records){await record.controller.tick();await record.engine.tick();}await group.tick();assert.notEqual(group.status().phase,'blocked',group.status().reasons.join(' '));};
 const targetVersion=purpose==='quit'?'0.16.2':'0.17.0';
 await group.begin({targetVersion,purpose});
 return {directory,capacity,records,projects,group,completed,targetVersion,tick,async response(record,role,state){await writeFile(actorFile(record,role)+'.response',state);},async finish(record,role){await writeFile(actorFile(record,role)+'.finish','finish naturally');}};
}

for(const purpose of ['update','quit'])test(`agent-owned ${purpose} waits for every bound acknowledgement and final native turn across selected and hidden projects`,{timeout:120000},async t=>{
 const f=await fixture(t,purpose),[selected,hidden]=f.records;
 const followup={taskId:activeId,requestId:'direction-after-preparation',brief:'Keep this exact queued direction for ordinary continuation after the user returns to work.',expectedRunId:selected.original.runId};
 await requestWorkerFollowup(selected.stateDir,followup);const queuedTask=await readTask(selected.stateDir,activeId),queuedDirection=queuedTask.assignments.find(item=>item.id===followup.requestId),initialAssignmentId=queuedTask.currentAssignmentId;
 await writeFile(actorFile(selected,'worker')+'.request-approval','retain pending worker input');
 await until(async()=>{await f.tick();return(await Promise.all(f.records.map(record=>readPreparation(record.stateDir)))).every(plan=>plan?.participants.filter(p=>p.required).every(p=>p.delivery.state==='acknowledged'))&&(await Promise.all(f.records.map(record=>calls(record,'worker')))).every(entries=>entries.some(entry=>entry.kind==='workflow-only'));},'all existing native conversations steered exactly once');
 for(const record of f.records){const prep=await readPreparation(record.stateDir);assert.equal(prep.purpose,purpose);assert.ok(prep.participants.filter(p=>p.required).every(p=>p.response===null));const task=await readTask(record.stateDir,activeId);assert.equal(task.lifecycleRequests.length,0,'Ready for review at 100% is not a preparation acknowledgement');assert.equal(task.workflowState.value,'Ready for review');assert.equal(task.workflowState.progressPercent,100);assert.deepEqual(task.workflowHistory.slice(-2).map(event=>event.progressPercent),[40,100]);assert.equal(task.status,'running');assert.equal(task.runId,record.original.runId);}
 await until(async()=>(await listWorkerRequests({stateDir:selected.stateDir,pendingOnly:true})).some(request=>request.taskId===activeId),'pending bound worker approval');
 assert.deepEqual((await readTask(selected.stateDir,activeId)).assignments.find(item=>item.id===followup.requestId),queuedDirection);
 assert.equal(f.group.status().phase,'draining');
 for(const record of f.records){await f.response(record,'manager','ready');await f.response(record,'worker',record===hidden?'needs-input':'ready');}
 await until(async()=>{await f.tick();return(await readPreparation(hidden.stateDir)).participants.find(p=>p.role==='worker'&&p.taskId===activeId)?.response?.state==='needs-input';},'hidden worker needs-input report');
 assert.equal(f.group.status().phase,'draining');assert.match(f.group.status().reasons.join(' '),/human decision|needs-input|explicit/i);
 await writeFile(path.join(selected.controls,'request-approval'),'native input');await until(()=>selected.bridge.state().approvals.length===1,'pending manager native approval');
 await f.response(hidden,'worker','ready');
 await until(async()=>{await f.tick();return(await Promise.all(f.records.map(record=>readPreparation(record.stateDir)))).every(plan=>plan.participants.filter(p=>p.required).every(p=>p.response?.state==='ready'));},'all explicit ready acknowledgements');
 assert.equal(f.group.status().phase,'draining','ready acknowledgements cannot end native turns');assert.equal(selected.bridge.state().approvals.length,1);assert.equal((await listWorkerRequests({stateDir:selected.stateDir,pendingOnly:true})).filter(request=>request.taskId===activeId).length,1,'progress and preparation never answer the native worker request');
 assert.equal((await f.group.markInstalling({planId:f.group.status().id,targetVersion:f.targetVersion})).marked,false);
 await writeFile(actorFile(selected,'worker')+'.withdraw-approval','native worker request withdrawn');await until(async()=>(await listWorkerRequests({stateDir:selected.stateDir,pendingOnly:true})).length===0,'worker native approval withdrawal without a response');
 await writeFile(path.join(selected.controls,'withdraw-approval'),'native request withdrawn');await until(()=>selected.bridge.state().approvals.length===0,'native approval withdrawal without a response');
 for(const record of f.records)await f.finish(record,'manager');
 await until(async()=>{await f.tick();return f.records.every(record=>record.bridge.state().status==='completed');},'both managers final messages');
 assert.equal(f.group.status().phase,'draining','live workers remain an independent barrier');
 await f.finish(selected,'worker');await until(async()=>{await f.tick();const task=await readTask(selected.stateDir,activeId);return task.execution?.live===false&&Boolean(task.result);},'selected worker natural exit and durable result');
 assert.equal(f.group.status().phase,'draining','hidden worker keeps shared installation and Quit blocked');
 const selectedSettled=await readTask(selected.stateDir,activeId);assert.deepEqual(selectedSettled.assignments.find(item=>item.id===followup.requestId),queuedDirection,'preparation holds the exact queued direction instead of selecting another assignment');assert.equal(selectedSettled.currentAssignmentId,initialAssignmentId);assert.ok(selectedSettled.result,'the settled original result stays attached during preparation');
 await f.finish(hidden,'worker');await until(async()=>{await f.tick();return f.group.status().phase==='ready';},'all-project agent acknowledgements and fresh natural settlement');
 const grouped=f.group.status();assert.equal(grouped.purpose,purpose);assert.equal(grouped.projects.length,2);assert.equal(grouped.targets.filter(target=>target.taskId===activeId).length,2,'duplicate worker IDs retain project boundaries');
 assert.ok(!grouped.targets.some(target=>target.taskId===completedId));
 for(const record of f.records){
  const task=await readTask(record.stateDir,activeId),prep=await readPreparation(record.stateDir),nativeCalls=await calls(record,'worker'),managerCalls=await calls(record,'manager');
  assert.equal(task.workflowState.progressPercent,100);assert.deepEqual(task.workflowHistory.slice(-2).map(event=>event.progressPercent),[40,100]);
  assert.equal(task.runId,record.original.runId);assert.equal(task.threadId,record.original.threadId);assert.equal(task.worktree,record.original.worktree);assert.equal(task.execution.live,false);
  const proof=(await record.view()).tasks.find(task=>task.id===activeId).updateEvidence;assert.ok(['stopped','absent'].includes(proof.worker));assert.ok(['stopped','absent'].includes(proof.runtime));
  assert.ok(task.lifecycleRequests.every(request=>request.action==='pause'&&request.settleNaturally===true&&request.cooperative===true));
  assert.ok(prep.participants.filter(p=>p.required).every(p=>p.response.state==='ready'&&p.response.continuation.includes(record.id)));
  for(const entries of [nativeCalls,managerCalls]){assert.equal(entries.filter(entry=>entry.method==='turn/steer').length,1);assert.equal(entries.some(entry=>entry.method==='turn/interrupt'||entry.kind==='signal'),false);assert.equal(entries.some(entry=>entry.id===9000&&!entry.method),false);assert.ok(entries.some(entry=>entry.kind==='bound-mcp'&&entry.name==='get_preparation_request'));assert.ok(entries.some(entry=>entry.kind==='bound-mcp'&&entry.name==='report_preparation'));}
  assert.equal(await readFile(path.join(task.worktree,'dirty-continuation.txt'),'utf8'),'Retain uncommitted '+record.id+' facts.\n');assert.match((await exec('git',['-C',task.worktree,'status','--porcelain'])).stdout,/dirty-continuation/);
  await assert.rejects(access(path.join(record.root,'unexpected-project-command')),{code:'ENOENT'});
  assert.equal(JSON.parse(await readFile(path.join(record.root,'manager-chat.json'),'utf8')).threadId,record.id+'-manager-thread');
  await until(async()=>JSON.parse(await readFile(path.join(record.root,'manager-chat.json.conversation.json'),'utf8')).messages.some(message=>message.text==='Final factual continuation for '+record.id+'-manager-thread.'),'retained final manager message');
  assert.equal(record.bridge.state().messages.some(message=>message.text==='Final factual continuation for '+record.id+'-manager-thread.'),false,'application preparation remains durable without appearing as human chat');
 }
 assert.deepEqual(await readTask(selected.stateDir,completedId),f.completed,'completed assignment is neither paused nor queued for automatic resume');
 const consumers=[];
 const consume=kind=>{assert.ok(f.records.every(record=>record.engine.status().phase==='installing'),'every child marker precedes the first simulated native consumer');consumers.push(kind);};
 if(purpose==='quit') {
  const quit=createPreparationQuit({currentVersion:'0.16.2',group:f.group,assertCanBegin:async()=>{},showProgress:async()=>{},activity:()=>workspaceUpdateActivity(f.projects()),lease:{acquire:async()=>async()=>{}},setQuitting:value=>{assert.equal(value,true);},stopOwnedControllers:async()=>{for(const record of f.records)consume('stop-'+record.id);},finish:()=>consumers.push('quit')});
  await quit.advance();assert.deepEqual(consumers,['stop-alpha','stop-beta','quit']);
 } else {
  const nativeStatus={supported:true,phase:'downloaded',availableVersion:f.targetVersion,currentVersion:'0.16.2'};
  const native={getStatus:()=>nativeStatus,request:async(action,options)=>{assert.equal(action,'restart');await options.beforeInstall();consume('install-disposable-bundle');return nativeStatus;}};
  const update=createPauseUpdateCoordinator({native,begin:async input=>({plan:await f.group.begin(input)}),status:async()=>({plan:f.group.status()}),cancel:async()=>({plan:await f.group.cancel()}),markInstalling:input=>f.group.markInstalling(input),markBlocked:async input=>({plan:await f.group.markBlocked(input.reason,input)})});
  await update.restart();assert.deepEqual(consumers,['install-disposable-bundle']);
 }
 assert.equal(await globalAdmissionPaused(f.capacity),true);assert.deepEqual(await readTask(selected.stateDir,completedId),f.completed);
});

test('returning to ordinary admissions selects the retained direction once without rewriting the completed assignment',async t=>{
 const stateDir=await mkdtemp(path.join(tmpdir(),'crew-prepared-directions-')),taskId='held-direction-worker',runId='retained-completed-run',runDir=path.join(stateDir,'runs',taskId,runId),worktree=path.join(stateDir,'worktree');t.after(()=>rm(stateDir,{recursive:true,force:true}));await mkdir(runDir,{recursive:true});await mkdir(worktree);
 await createTask(stateDir,{requestId:taskId,ticket:'GH-62',brief:'Preserve this completed assignment',projectId:'project'});await updateTask(stateDir,taskId,task=>{task.runId=runId;task.runDir=runDir;task.threadId='retained-thread';task.worktree=worktree;task.harnessStarted=true;task.status='completed';task.result={message:'Original durable result',evidence:['Retained evidence']};});await writeFile(path.join(runDir,'exit.json'),JSON.stringify({runId,connectionClosed:true,stopConfirmed:true,completedTurn:true,exitCode:0,threadId:'retained-thread'}));await requestWorkerFollowup(stateDir,{taskId,requestId:'retained-direction',brief:'Ordinary authorized continuation after the hold clears'});
 const original=await readTask(stateDir,taskId),completed=structuredClone(original.assignments[0]),queued=structuredClone(original.assignments[1]);let held=true;
 const directions=createWorkerDirections({stateDir,launches:new Map(),operations:new Map(),admissionHeld:async()=>held,ownedRunnerAlive:async()=>false,getProcessSnapshot:()=>new Map(),verify:async()=>assert.fail('Completed history must not be reverified'),fail:async()=>assert.fail('Completed history must not fail')});
 await directions.activateFollowup(original);let task=await readTask(stateDir,taskId);assert.equal(task.status,'completed');assert.deepEqual(task.result,original.result);assert.deepEqual(task.assignments[0],completed);assert.deepEqual(task.assignments[1],queued);
 held=false;await directions.activateFollowup(task);task=await readTask(stateDir,taskId);assert.equal(task.currentAssignmentId,'retained-direction');assert.equal(task.status,'resume_queued');assert.equal(task.runId,runId,'Selection alone never launches another native run');assert.deepEqual(task.assignments[0],completed);assert.equal(task.assignments[1].status,'active');const selected=structuredClone(task);await directions.activateFollowup(task);assert.deepEqual(await readTask(stateDir,taskId),selected);
});
