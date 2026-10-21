import {workerAppServerFixture} from './helpers/worker-app-server-fixture.mjs';
// Grouped acceptance: real subprocess workers and Git worktrees, two controllers,
// one capacity ledger. Native installation and voice remain synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,realpath,rm} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {EventEmitter} from 'node:events';
import {createController} from '../controller.mjs';
import {promptSnapshot} from '../prompt-settings.mjs';
import {createTask,readTask,updateTask,requestWorkerAction} from '../orchestration-store.mjs';
import {configureGlobalCapacity,globalAdmissionPaused} from '../global-capacity.mjs';
import {createUpdatePlan,readUpdatePlan,isUpdatePlanHolding} from '../update-plan.mjs';
import {inspectUpdateEvidence} from '../update-evidence.mjs';
import {updateActivity} from '../update-activity.mjs';
import {workspaceUpdateActivity,reserveWorkspaceUpdate} from '../desktop/workspace-update.mjs';
import {createWorkspacePauseUpdate} from '../desktop/workspace-pause-update.mjs';
import {createUpdateCoordinator,createPauseUpdateCoordinator} from '../desktop/updater.mjs';
const exec=promisify(execFile),sourceDir=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const sleep=ms=>new Promise(done=>setTimeout(done,ms));
async function until(check,label){const deadline=Date.now()+25000;while(Date.now()<deadline){const value=await check();if(value)return value;await sleep(40);}throw Error('Timed out '+label);}
async function fixture(t){
 const directory=await realpath(await mkdtemp(join(tmpdir(),'crew-multi-update-'))),capacity=join(directory,'capacity'),groupPath=join(directory,'workspace-update.json');let cleanup=false,group;
 const records=[];
 for(const id of ['alpha','beta']){
  const root=join(directory,id),repo=join(root,'repo'),stateDir=join(root,'state'),configPath=join(root,'project.json'),promptPath=join(root,'worker.md');await mkdir(repo,{recursive:true});await mkdir(stateDir);await writeFile(configPath,JSON.stringify({project:{id}}));await writeFile(promptPath,`fixture-prompt-${id}-v1`);
  await exec('git',['init','-b','main',repo]);await writeFile(join(repo,'README.md'),'isolated fixture '+id);await exec('git',['-C',repo,'add','.']);await exec('git',['-C',repo,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','fixture']);
  records.push({id,name:id==='alpha'?'Selected':'Hidden',repo,stateDir,configPath,promptPath,controller:null,engine:null,ids:[],voiceStops:0});
 }
 await configureGlobalCapacity({dir:capacity,limit:2,stateDirs:records.map(record=>record.stateDir),admissionPaused:false});
 const executable=join(directory,'fake-codex.mjs');await writeFile(executable,workerAppServerFixture(`#!${process.execPath}
import{readFile,appendFile}from'node:fs/promises';import{reportTask}from ${JSON.stringify(pathToFileURL(join(sourceDir,'orchestration-store.mjs')).href)};
const args=process.argv.slice(2),raw=args.find(value=>value.startsWith('mcp_servers.local_orchestration.args=')),[,state,,id,run]=JSON.parse(raw.slice(raw.indexOf('=')+1)),task=JSON.parse(await readFile(state+'/tasks/'+id+'.json','utf8')),resumed=args.includes('resume'),thread=resumed?args[args.indexOf('resume')+1]:'thread-'+task.projectId+'-'+id;
process.on('fixtureInterrupt',async()=>{await appendFile(state+'/'+id+'-signals','turn/interrupt\\n');process.exit(0);});process.on('SIGTERM',()=>process.exit(0));
await appendFile(state+'/launches.jsonl',JSON.stringify({id,run,thread,resumed,cwd:process.cwd(),promptV2:args.at(-1).includes('fixture-prompt-'+task.projectId+'-v2')})+'\\n');
console.log(JSON.stringify({type:'thread.started',thread_id:thread}));await reportTask(state,id,run,{reportId:'progress',kind:'progress',message:'Disposable project worker running'});
// Finite queued admission probes yield their slot with a real durable question.
// This tests global capacity without relying on per-project scheduler fairness.
if(id==='zz-queued-worker'){await reportTask(state,id,run,{reportId:'fixture-question',kind:'question',message:'Fixture admission verified; retain this unanswered question.'});console.log(JSON.stringify({type:'turn.completed'}));process.exit(0);}
setInterval(()=>{},1000);
`),{mode:0o700});
 const manager={status:'completed',voiceActive:false,voiceConnecting:false,workStarting:false,activeTurnId:null,approvals:[]};
 async function start(record,version){
  const project={id:record.id,name:record.name,mode:'repository',readiness:{ready:true},repositories:[{id:'repo',path:record.repo,baseRef:'main'}],worker:{sandbox:'read-only',maxConcurrent:2,timeoutMs:60000,environment:{}}};
  record.controller=await createController({stateDir:record.stateDir,sourceDir,executable,project,getWorkerPrompt:async()=>promptSnapshot(await readFile(record.promptPath,'utf8')),globalCapacity:{dir:capacity},admissionHeld:async()=>!cleanup&&(await globalAdmissionPaused(capacity)||isUpdatePlanHolding(await readUpdatePlan(record.stateDir)))});
  record.view=async()=>inspectUpdateEvidence({stateDir:record.stateDir,view:await record.controller.view()});record.activity=async()=>updateActivity({work:manager,view:await record.view()});
  record.engine=createUpdatePlan({stateDir:record.stateDir,version,getView:record.view,getManager:()=>manager,stopVoice:async()=>{record.voiceStops++;},interruptManager:async()=>assert.fail('No manager work to replay or interrupt'),requestAction:input=>requestWorkerAction(record.stateDir,input),activity:record.activity});await record.engine.ready;await record.engine.recover();
 }
 for(const record of records){record.host={api:async route=>route==='update-plan-status'?{plan:record.engine.status()}:route==='update-activity'?record.activity():assert.fail('Unexpected fixture API'),updateToken:async(route,input={})=>{
  if(route==='update-prepare')return {reserved:(await record.activity()).safe};if(route==='update-cancel')return {reserved:false};
  if(route==='update-plan-begin')return {plan:await record.engine.begin(input)};
  const plan=record.engine.status();if(input.planId!==plan?.id||input.targetVersion!==plan?.targetVersion)throw Error('Fixture child correlation changed');
  if(route==='update-plan-installing')return record.engine.markInstalling(input);
  if(route==='update-plan-blocked')return {plan:await record.engine.markBlocked(input.reason,input)};
  if(route==='update-plan-cancel')return {plan:await record.engine.cancel()};
  if(route==='update-plan-resume')return {plan:await record.engine.resumeAfterCancel()};
  if(route==='update-plan-review')return {plan:await record.engine.releaseForReview()};throw Error('Unexpected fixture mutation');
 }};}
 const groupOptions={path:groupPath,currentVersion:'1.0.0',projects:async()=>records,setAdmissionPaused:admissionPaused=>configureGlobalCapacity({dir:capacity,admissionPaused})};
 group=createWorkspacePauseUpdate(groupOptions);await group.ready;for(const record of records)await start(record,'1.0.0');
 async function tick(){for(const record of records){await record.controller?.tick();await record.engine.tick();}return group.tick();}
 async function launches(record){return (await readFile(join(record.stateDir,'launches.jsonl'),'utf8').catch(()=> '')).split('\n').filter(Boolean).map(line=>JSON.parse(line));}
 t.after(async()=>{
  // Keep the global barrier while canceling fixture queues, then explicitly stop
  // owned live workers. Never release capacity before queue cancellation.
  await configureGlobalCapacity({dir:capacity,admissionPaused:true});
  for(const record of records){if(!record.controller)await start(record,'1.1.0');for(const id of record.ids){const task=await readTask(record.stateDir,id);await updateTask(record.stateDir,id,next=>{for(const request of next.lifecycleRequests||[])if(['pending','processing'].includes(request.status))request.status='failed';if(!next.harnessStarted&&['queued','resume_queued','launching'].includes(next.status))next.status='canceled';});if(task.harnessStarted&&!['paused','stopped','completed'].includes(task.status))await requestWorkerAction(record.stateDir,{taskId:id,actionId:'cleanup-'+id,action:'stop'});}}
  cleanup=true;
  await until(async()=>{for(const record of records)await record.controller.tick();return (await Promise.all(records.flatMap(record=>record.ids.map(id=>readTask(record.stateDir,id))))).every(task=>!task.harnessStarted||task.execution?.live===false);},'fixture owned-process shutdown');
  for(const record of records)await record.controller.stop();await rm(directory,{recursive:true,force:true});
 });
 return {records,capacity,groupPath,get group(){return group;},tick,launches,
  async add(record,id,status){record.ids.push(id);await createTask(record.stateDir,{requestId:id,ticket:'AI-018',brief:'Explicit disposable project task',projectId:record.id,repositoryId:'repo'});if(status)await updateTask(record.stateDir,id,next=>{next.status=status;next.harnessStarted=false;});await record.controller.tick();},
  live:record=>until(async()=>{const task=await readTask(record.stateDir,'shared-worker');assert.notEqual(task.status,'failed',String(task.failure));return task.threadId&&task.execution?.live&&task.reports.length?task:null;},'live '+record.id).catch(async error=>{const task=await readTask(record.stateDir,'shared-worker');throw Error(error.message+' '+JSON.stringify({status:task.status,runId:task.runId,execution:task.execution,capacityWait:task.capacityWait,requests:task.lifecycleRequests,launches:await launches(record)}));}),
  async restart(version){for(const record of records){await record.controller.stop();record.controller=null;}group=createWorkspacePauseUpdate({...groupOptions,currentVersion:version});await group.ready;assert.equal(await globalAdmissionPaused(capacity),true);for(const record of records)await start(record,version);await group.recover();},
 };
}
async function runningPair(f){const before=[];for(const record of f.records){await f.add(record,'shared-worker');before.push(await f.live(record));}for(const record of f.records)await f.add(record,'zz-queued-worker');return before;}
async function ready(f){try{await until(async()=>{await f.tick();assert.notEqual(f.group.status().phase,'blocked',f.group.status().reasons.join());return f.group.status().phase==='ready';},'every project paused');}catch(error){throw Error(error.message+': '+f.group.status().reasons.join(' '));}}
class FakeUpdater extends EventEmitter{async checkForUpdates(){this.emit('update-available',{version:'1.1.0'});}async downloadUpdate(){this.emit('update-downloaded',{version:'1.1.0'});}}

test('hidden project and duplicate task IDs pause under one ledger; target recovery resumes each project once with current instructions and retained historical snapshots',async t=>{
 const f=await fixture(t),before=await runningPair(f);const originalConfigs=await Promise.all(before.map(task=>readFile(join(task.runDir,'config.json'),'utf8')));const claims=JSON.parse(await readFile(join(f.capacity,'capacity.json'),'utf8')).claims;assert.equal(claims.length,2);assert.equal(new Set(claims.map(claim=>claim.stateDir)).size,2);assert.ok(claims.every(claim=>claim.taskId==='shared-worker'));assert.notEqual(before[0].threadId,before[1].threadId);assert.notEqual(before[0].worktree,before[1].worktree);
 const nativeCalls=[],native=createUpdateCoordinator({updater:new FakeUpdater(),currentVersion:'1.0.0',support:{supported:true},activity:()=>workspaceUpdateActivity(f.records),prepare:()=>reserveWorkspaceUpdate(f.records,{setAdmissionPaused:admissionPaused=>configureGlobalCapacity({dir:f.capacity,admissionPaused})}),cancel:async()=>nativeCalls.push('rollback'),otherInstances:async()=>[],lease:{acquire:async()=>async()=>{}},stopBackend:async()=>{assert.equal(JSON.parse(await readFile(f.groupPath,'utf8')).phase,'installing');for(const record of f.records){assert.equal(record.engine.status().phase,'installing');assert.equal((await f.launches(record)).length,1);}nativeCalls.push('stop');},install:async()=>nativeCalls.push('install')});
 const pause=createPauseUpdateCoordinator({native,begin:async input=>({plan:await f.group.begin(input)}),status:async()=>({plan:f.group.status()}),cancel:async()=>({plan:await f.group.cancel()}),markInstalling:input=>f.group.markInstalling(input),markBlocked:async input=>({plan:await f.group.markBlocked(input.reason,input)})});
 await native.request('check');await native.request('download');await pause.request('pause-update');await ready(f);
 assert.equal(f.group.status().targets.filter(target=>target.taskId==='shared-worker').length,2);assert.equal(await globalAdmissionPaused(f.capacity),true);
 for(const record of f.records){assert.equal((await readTask(record.stateDir,'zz-queued-worker')).worktree,undefined);assert.equal(await readFile(join(record.stateDir,'shared-worker-signals'),'utf8'),'turn/interrupt\n');await writeFile(record.promptPath,`fixture-prompt-${record.id}-v2`);}
 await pause.advancePlan();assert.deepEqual(nativeCalls,['stop','install']);
 await f.restart('1.1.0');await until(async()=>{await f.tick();assert.notEqual(f.group.status().phase,'blocked',f.group.status().reasons.join());return f.group.status().phase==='complete';},'all-project recovery');
 assert.equal(await globalAdmissionPaused(f.capacity),false);const resumed=await Promise.all(f.records.map(record=>f.live(record)));
 for(let index=0;index<f.records.length;index++){const record=f.records[index],task=resumed[index];assert.notEqual(task.runId,before[index].runId);assert.equal(task.threadId,before[index].threadId);assert.equal(task.worktree,before[index].worktree);assert.equal(task.lifecycleRequests.filter(request=>request.action==='resume').length,1);assert.equal((await f.launches(record)).filter(call=>call.id==='shared-worker').length,2);assert.equal((await f.launches(record)).find(call=>call.resumed).promptV2,true);assert.equal(await readFile(join(before[index].runDir,'config.json'),'utf8'),originalConfigs[index],'Original instruction snapshot remains historical evidence');assert.equal(JSON.parse(originalConfigs[index]).workerPrompt,`fixture-prompt-${record.id}-v1`);assert.equal(JSON.parse(await readFile(join(task.runDir,'config.json'),'utf8')).workerPrompt,`fixture-prompt-${record.id}-v2`);assert.equal(record.voiceStops,1);for(const queued of (await f.launches(record)).filter(call=>call.id==='zz-queued-worker')){assert.equal(queued.promptV2,true);const retainedQuestion=await readTask(record.stateDir,queued.id);assert.equal(retainedQuestion.question?.id,'fixture-question');assert.equal(retainedQuestion.answer==null,true);}}
 await f.group.recover();await f.tick();for(const record of f.records)assert.equal((await readTask(record.stateDir,'shared-worker')).lifecycleRequests.filter(request=>request.action==='resume').length,1);
});

test('canceled group retains both queues; explicit old-version selective recovery leaves manual paused work untouched',async t=>{
 const f=await fixture(t),before=await runningPair(f);for(const record of f.records)await f.add(record,'manual-paused','paused');
 await f.group.begin({targetVersion:'1.1.0'});await ready(f);await f.group.cancel();assert.equal(f.group.isHolding(),true);assert.equal(await globalAdmissionPaused(f.capacity),true);
 await sleep(300);await f.tick();for(const record of f.records){assert.equal((await f.launches(record)).length,1);assert.equal((await readTask(record.stateDir,'zz-queued-worker')).status,'paused');assert.equal((await readTask(record.stateDir,'manual-paused')).lifecycleRequests.length,0);}
 await f.group.resumeAfterCancel();await until(async()=>{await f.tick();assert.notEqual(f.group.status().phase,'blocked',f.group.status().reasons.join());return f.group.status().phase==='complete';},'explicit all-project retained resume');
 const resumed=await Promise.all(f.records.map(record=>f.live(record)));for(let index=0;index<f.records.length;index++){const record=f.records[index];assert.equal(resumed[index].threadId,before[index].threadId);assert.equal(resumed[index].worktree,before[index].worktree);assert.equal((await readTask(record.stateDir,'manual-paused')).status,'paused');assert.equal((await readTask(record.stateDir,'manual-paused')).lifecycleRequests.length,0);assert.equal((await readTask(record.stateDir,'shared-worker')).lifecycleRequests.filter(request=>request.action==='resume').length,1);}
});
