import {workerAppServerFixture} from './helpers/worker-app-server-fixture.mjs';
// AI-018 acceptance across real controller/worktrees/processes, evidence, plan
// and native coordinator. All executable work is a disposable local fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {EventEmitter} from 'node:events';
import {createController} from '../controller.mjs';
import {createTask,readTask,updateTask,requestWorkerAction} from '../orchestration-store.mjs';
import {createUpdatePlan,readUpdatePlan,isUpdatePlanHolding} from '../update-plan.mjs';
import {inspectUpdateEvidence} from '../update-evidence.mjs';
import {updateActivity} from '../update-activity.mjs';
import {createUpdateCoordinator,createPauseUpdateCoordinator} from '../desktop/updater.mjs';
const exec=promisify(execFile),sourceDir=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,label){const deadline=Date.now()+20000;while(Date.now()<deadline){const value=await check();if(value)return value;await sleep(40);}throw new Error(`Timed out: ${label}`);}
async function fixture(t,{timeoutMs=20000}={}){
 const directory=await mkdtemp(path.join(tmpdir(),'crew-update-integrated-')),repo=path.join(directory,'repo'),stateDir=path.join(directory,'state');
 await mkdir(repo);await mkdir(stateDir);await exec('git',['init','-b','main',repo]);await writeFile(path.join(repo,'README.md'),'disposable baseline\n');
 await exec('git',['-C',repo,'add','.']);await exec('git',['-C',repo,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','fixture']);
 const executable=path.join(directory,'fake-codex.mjs');await writeFile(executable,workerAppServerFixture(`#!${process.execPath}
import{readFile,appendFile}from'node:fs/promises';
import{reportTask}from ${JSON.stringify(pathToFileURL(path.join(sourceDir,'orchestration-store.mjs')).href)};
const args=process.argv.slice(2),raw=args.find(a=>a.startsWith('mcp_servers.local_orchestration.args=')),[,state,,id,run]=JSON.parse(raw.slice(raw.indexOf('=')+1)),task=JSON.parse(await readFile(state+'/tasks/'+id+'.json','utf8'));
const resumed=args.includes('resume'),thread=resumed?args[args.indexOf('resume')+1]:'fixture-thread-'+id;
process.on('fixtureInterrupt',async()=>{await appendFile(state+'/'+id+'-signals','turn/interrupt\\n');if(!task.brief.includes('refuse interrupt'))process.exit(0);});
process.on('SIGTERM',async()=>{await appendFile(state+'/'+id+'-signals','SIGTERM\\n');process.exit(0);});
await appendFile(state+'/launches.jsonl',JSON.stringify({id,run,thread,resumed,cwd:process.cwd()})+'\\n');
console.log(JSON.stringify({type:'thread.started',thread_id:thread}));
await reportTask(state,id,run,{reportId:'fixture-progress',kind:'progress',message:'Disposable worker is running.'});setInterval(()=>{},1000);
`),{mode:0o700});
 let cleanup=false,controller,engine,time=Date.now();const ids=[];
 const manager={status:'completed',voiceActive:false,voiceConnecting:false,workStarting:false,activeTurnId:null,approvals:[]};
 const project={id:'update-fixture',name:'Disposable update fixture',mode:'repository',readiness:{ready:true},repositories:[{id:'repo',path:repo,baseRef:'main'}],worker:{sandbox:'read-only',timeoutMs,maxConcurrent:2,environment:{}}};
 const create=()=>createController({stateDir,sourceDir,executable,project,admissionHeld:async()=>!cleanup&&isUpdatePlanHolding(await readUpdatePlan(stateDir))});
 controller=await create();
 const view=async()=>inspectUpdateEvidence({stateDir,view:await controller.view()});
 const activity=async()=>updateActivity({work:manager,view:await view()});
 let voiceStops=0;
 const options={stateDir,version:'1.0.0',getView:view,getManager:()=>manager,stopVoice:async()=>{assert.equal(isUpdatePlanHolding(await readUpdatePlan(stateDir)),true);voiceStops++;},interruptManager:async()=>assert.fail('Idle manager must not be interrupted'),requestAction:request=>requestWorkerAction(stateDir,request),activity,now:()=>time};
 engine=createUpdatePlan(options);await engine.ready;
 const add=async(id,brief='cooperative fixture work')=>{ids.push(id);await createTask(stateDir,{requestId:id,ticket:'AI-018',brief,projectId:project.id,repositoryId:'repo'});await controller.tick();};
 const histories=async()=>{const raw=await readFile(path.join(stateDir,'launches.jsonl'),'utf8').catch(()=> '');return raw.split('\n').filter(Boolean).map(line=>JSON.parse(line));};
 const waitLive=id=>until(async()=>{const task=await readTask(stateDir,id);return task.threadId&&task.execution?.live&&task.reports.length?task:null;},`live ${id}`);
 t.after(async()=>{
  if(!controller)controller=await create();
  for(const id of ids){
   const task=await readTask(stateDir,id);await updateTask(stateDir,id,next=>{for(const request of next.lifecycleRequests||[])if(['pending','processing'].includes(request.status))request.status='failed';if(!next.harnessStarted&&['queued','launching','resume_queued'].includes(next.status))next.status='canceled';});
   if(task.harnessStarted&&!['paused','stopped','completed'].includes(task.status))await requestWorkerAction(stateDir,{taskId:id,actionId:`cleanup-${id}`,action:'stop'}).catch(()=>{});
  }
  cleanup=true;
  await until(async()=>{await controller.tick();return (await Promise.all(ids.map(id=>readTask(stateDir,id)))).every(task=>!task.harnessStarted||task.execution?.live===false);},'owned fixture process cleanup');
  await controller.stop();controller=null;await rm(directory,{recursive:true,force:true});
 });
 return {directory,repo,stateDir,manager,activity,view,add,waitLive,histories,get engine(){return engine;},get controller(){return controller;},get voiceStops(){return voiceStops;},advanceTime:ms=>time+=ms,
  async tick(){await controller?.tick();await engine.tick();},
  async stopController(){await controller.stop();controller=null;},
  async restart(version){controller=await create();engine=createUpdatePlan({...options,version});await engine.ready;await engine.recover();},
 };
}
async function twoWorkersAndQueue(f){await f.add('plan-alpha');await f.add('plan-beta');const before=[await f.waitLive('plan-alpha'),await f.waitLive('plan-beta')];await f.add('plan-queued');assert.equal((await readTask(f.stateDir,'plan-queued')).status,'queued');return before;}
async function drainReady(f){await until(async()=>{await f.tick();return f.engine.status().phase==='ready';},'durable ready plan');}
class FakeUpdater extends EventEmitter{async checkForUpdates(){this.emit('update-available',{version:'1.1.0'});}async downloadUpdate(){this.emit('update-downloaded',{version:'1.1.0'});}}

test('two real workers pause, native install commits, and target-version recovery resumes only captured eligible work exactly once',async t=>{
 const f=await fixture(t),before=await twoWorkersAndQueue(f),retained=[];
 for(const [id,status]of [['manual-paused','paused'],['retained-failed','failed'],['pending-question','awaiting_answer']]){
  await f.add(id);const worktree=path.join(f.stateDir,'worktrees',id);await mkdir(path.dirname(worktree),{recursive:true});await exec('git',['-C',f.repo,'worktree','add','--detach',worktree,'main']);await writeFile(path.join(worktree,'retained.txt'),id);
  await updateTask(f.stateDir,id,next=>{next.status=status;next.harnessStarted=false;next.worktree=worktree;if(id==='pending-question'){next.runId='manual-question-run';next.question={id:'unanswered-question',runId:next.runId,message:'Retained human question'};}});
  retained.push(await readTask(f.stateDir,id));
 }
 const updater=new FakeUpdater(),nativeCalls=[];
 const native=createUpdateCoordinator({updater,currentVersion:'1.0.0',support:{supported:true},activity:f.activity,prepare:async()=>({reserved:(await f.activity()).safe}),cancel:async()=>nativeCalls.push('rollback'),lease:{acquire:async()=>{nativeCalls.push('lease');return async()=>nativeCalls.push('release');}},otherInstances:async()=>[],stopBackend:async()=>{assert.equal((await readUpdatePlan(f.stateDir)).phase,'installing');nativeCalls.push('stop-controller');await f.stopController();},install:async()=>nativeCalls.push('install')});
 const pause=createPauseUpdateCoordinator({native,begin:async input=>({plan:await f.engine.begin(input)}),status:async()=>({plan:f.engine.status()}),cancel:async()=>({plan:await f.engine.cancel()}),markInstalling:input=>f.engine.markInstalling(input),markBlocked:async input=>({plan:await f.engine.markBlocked(input.reason,input)})});
 await native.request('check');await native.request('download');await pause.request('pause-update');await drainReady(f);
 const plan=f.engine.status();assert.deepEqual(plan.targets.map(target=>target.taskId).sort(),['plan-alpha','plan-beta','plan-queued']);
 for(const old of before){const task=await readTask(f.stateDir,old.id);assert.equal(task.status,'paused');assert.equal(task.threadId,old.threadId);assert.equal(task.worktree,old.worktree);assert.equal(await readFile(path.join(f.stateDir,old.id+'-signals'),'utf8'),'turn/interrupt\n');}
 assert.equal((await readTask(f.stateDir,'plan-queued')).worktree,undefined);assert.equal((await f.activity()).safe,true);
 const registered=(await exec('git',['-C',f.repo,'worktree','list','--porcelain'])).stdout;for(const task of before)assert.ok(registered.includes(`worktree ${await realpath(task.worktree)}\n`));
 await pause.advancePlan();assert.deepEqual(nativeCalls,['lease','stop-controller','install']);assert.equal((await readUpdatePlan(f.stateDir)).phase,'installing');
 await f.restart('1.1.0');await until(async()=>{await f.tick();assert.notEqual(f.engine.status().phase,'blocked',f.engine.status().reasons.join(' ')+' '+JSON.stringify((await readTask(f.stateDir,'plan-queued')).lifecycleRequests));return f.engine.status().phase==='complete';},'version-bound recovery admission');
 const resumed=await Promise.all(before.map(task=>f.waitLive(task.id)));for(const task of resumed){const old=before.find(item=>item.id===task.id);assert.notEqual(task.runId,old.runId);assert.equal(task.threadId,old.threadId);assert.equal(task.worktree,old.worktree);assert.equal(task.lifecycleRequests.filter(request=>request.action==='resume').length,1);}
 await f.engine.recover();await f.tick();await sleep(300);
 const launches=await f.histories();for(const task of before)assert.equal(launches.filter(call=>call.id===task.id).length,2);assert.equal(launches.some(call=>call.id==='plan-queued'),false);
 for(const original of retained){assert.deepEqual(await readTask(f.stateDir,original.id),original);assert.equal(await readFile(path.join(original.worktree,'retained.txt'),'utf8'),original.id);}
 assert.equal(f.voiceStops,1);assert.equal((await exec('git',['-C',f.repo,'status','--porcelain'])).stdout,'');
});

test('cancel retains the real queue hold until explicit Return to work, without resuming paused workers',async t=>{
 const f=await fixture(t);await twoWorkersAndQueue(f);await f.engine.begin({targetVersion:'1.1.0'});await drainReady(f);await f.engine.cancel();assert.equal(isUpdatePlanHolding(f.engine.status()),true);
 const before=await f.histories();await sleep(350);await f.tick();assert.deepEqual(await f.histories(),before);assert.equal((await readTask(f.stateDir,'plan-queued')).status,'paused');
 await f.engine.releaseForReview();await f.tick();assert.equal(f.engine.status().phase,'complete');
 for(const id of ['plan-alpha','plan-beta','plan-queued']){const task=await readTask(f.stateDir,id);assert.equal(task.status,'paused');assert.equal(task.lifecycleRequests.some(request=>request.action==='resume'),false);}
});

test('noncooperative live worker blocks the integrated plan past timeout with no force fallback or queued launch',async t=>{
 const workerBoundMs=10000;const f=await fixture(t,{timeoutMs:workerBoundMs});await f.add('plan-refuses','refuse interrupt');await f.waitLive('plan-refuses');
 // A manual hold captures the queue through the actual plan before a free slot can launch it.
 await f.engine.begin({targetVersion:'1.1.0'});await until(async()=>{await f.tick();return readFile(path.join(f.stateDir,'plan-refuses-signals'),'utf8').then(value=>value.includes('turn/interrupt')).catch(()=>false);},'cooperative interrupt');await f.add('plan-queued');
 // Wait beyond the actual configured harness timeout after turn/interrupt. Cooperative
 // pause must disable that deadline, rather than let load force a normal stop.
 await sleep(workerBoundMs+300);f.advanceTime(120001);await f.engine.tick();assert.equal(f.engine.status().phase,'blocked');
 const worker=await readTask(f.stateDir,'plan-refuses');assert.equal(worker.execution.live,true);assert.notEqual(worker.execution.stopConfirmed,true);assert.equal(await readFile(path.join(f.stateDir,'plan-refuses-signals'),'utf8'),'turn/interrupt\n');
 assert.equal((await f.view()).tasks.find(task=>task.id==='plan-refuses').updateEvidence.worker,'live');assert.equal((await f.activity()).safe,false);assert.equal((await f.histories()).some(call=>call.id==='plan-queued'),false);
});
