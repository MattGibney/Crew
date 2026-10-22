import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {workerAppServerFixture} from './helpers/worker-app-server-fixture.mjs';
import {createBridge} from '../runtime/manager/bridge/index.mjs';
import {createController} from '../runtime/workers/controller.mjs';
import {createTask,readTask,requestWorkerAction} from '../runtime/orchestration/store.mjs';
import {createUpdatePlan,readUpdatePlan,isUpdatePlanHolding} from '../runtime/updates/plan.mjs';
import {inspectUpdateEvidence} from '../runtime/updates/evidence.mjs';
import {updateActivity} from '../runtime/updates/activity.mjs';

const exec=promisify(execFile);
const sourceDir=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../runtime');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,label){const deadline=Date.now()+25000;while(Date.now()<deadline){const result=await check();if(result)return result;await delay(40);}throw new Error(`Timed out: ${label}`);}
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};

test('real manager natural completion during pause enqueue retains worker and chat, then installs only with fresh stopped ownership',async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'crew-manager-update-race-'));
 const repo=path.join(directory,'repo'),stateDir=path.join(directory,'state'),statePath=path.join(directory,'manager-chat.json');
 const control=path.join(directory,'manager-complete'),calls=path.join(directory,'manager-calls.jsonl'),workerSignals=path.join(directory,'worker-signals');
 const taskId='manager-race-worker',enqueued=deferred(),releaseEnqueue=deferred();
 let controller,bridge,pendingTick,cleaning=false,taskCreated=false;
 // Register cleanup before creating either process or waiting for any observation.
 t.after(async()=>{
  releaseEnqueue.resolve();
  if(pendingTick)await pendingTick.catch(()=>{});
  if(controller){
   if(taskCreated){
    const task=await readTask(stateDir,taskId);
    if(task.harnessStarted&&!['paused','stopped','completed'].includes(task.status))await requestWorkerAction(stateDir,{taskId,actionId:'fixture-cleanup-stop',action:'stop',expectedRunId:task.runId}).catch(()=>{});
    cleaning=true;
    await until(async()=>{await controller.tick();const current=await readTask(stateDir,taskId);return !current.harnessStarted||current.execution?.live===false;},'owned worker fixture exit');
   }
   await controller.stop();
  }
  if(bridge)await bridge.shutdown();
  await rm(directory,{recursive:true,force:true});
 });
 await mkdir(repo);await mkdir(stateDir);await writeFile(calls,'');
 await exec('git',['init','-b','main',repo]);await writeFile(path.join(repo,'README.md'),'Disposable baseline\n');
 await exec('git',['-C',repo,'add','.']);await exec('git',['-C',repo,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','fixture']);
 const managerExecutable=path.join(directory,'manager-codex.mjs');
 await writeFile(managerExecutable,`#!${process.execPath}
import{createInterface}from'node:readline';import{existsSync,appendFileSync}from'node:fs';
const threadId='manager-race-thread',turnId='manager-race-turn',send=value=>process.stdout.write(JSON.stringify(value)+'\\n');let active=false;
process.stdin.on('end',()=>process.exit(0));process.on('SIGTERM',()=>{appendFileSync(${JSON.stringify(calls)},JSON.stringify({signal:'SIGTERM'})+'\\n');process.exit(0);});
setInterval(()=>{if(active&&existsSync(${JSON.stringify(control)})){active=false;send({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed',items:[{id:'manager-finished',type:'agentMessage',text:'Retained manager completion.'}]}}});}},10);
createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);appendFileSync(${JSON.stringify(calls)},JSON.stringify(m)+'\\n');if(m.id===undefined)return;
let result={};if(m.method==='account/read')result={account:{type:'chatgpt'}};if(m.method==='config/read')result={config:{}};if(m.method==='thread/start'||m.method==='thread/resume')result={thread:{id:threadId}};
if(m.method==='thread/timeline/list'){send({id:m.id,error:{code:-32601,message:'Method not found'}});return;}
if(m.method==='thread/turns/list'||m.method==='mcpServerStatus/list')result={data:[]};
if(m.method==='turn/start'){active=true;result={turn:{id:turnId,status:'inProgress'}};send({method:'turn/started',params:{threadId,turn:result.turn}});}
if(m.method==='turn/interrupt'){send({id:m.id,error:{code:-32600,message:'Captured manager turn has finished'}});return;}
send({id:m.id,result});});
`,{mode:0o700});
 const workerExecutable=path.join(directory,'worker-codex.mjs');
 await writeFile(workerExecutable,workerAppServerFixture(`#!${process.execPath}
import{appendFile}from'node:fs/promises';import{reportTask}from ${JSON.stringify(pathToFileURL(path.join(sourceDir,'orchestration/store.mjs')).href)};
const raw=process.argv.find(value=>value.startsWith('mcp_servers.local_orchestration.args=')),[,state,,id,run]=JSON.parse(raw.slice(raw.indexOf('=')+1));
process.on('fixtureInterrupt',async()=>{await appendFile(${JSON.stringify(workerSignals)},'turn/interrupt\\n');process.exit(0);});
process.on('SIGTERM',async()=>{await appendFile(${JSON.stringify(workerSignals)},'SIGTERM\\n');process.exit(0);});
await reportTask(state,id,run,{reportId:'live-fixture',kind:'progress',message:'Disposable worker running'});setInterval(()=>{},1000);
`),{mode:0o700});
 const project={id:'manager-race-project',name:'Manager pause race fixture',mode:'repository',readiness:{ready:true},repositories:[{id:'repo',path:repo,baseRef:'main'}],worker:{sandbox:'read-only',timeoutMs:60000,maxConcurrent:1,environment:{}}};
 controller=await createController({stateDir,sourceDir,executable:workerExecutable,project,admissionHeld:async()=>!cleaning&&isUpdatePlanHolding(await readUpdatePlan(stateDir))});
 bridge=createBridge({cwd:sourceDir,statePath,executable:managerExecutable,project,managerPrompt:'Disposable manager completion fixture.'});
 await createTask(stateDir,{requestId:taskId,ticket:'GH-62',brief:'Cooperative disposable update pause',projectId:project.id,repositoryId:'repo'});taskCreated=true;
 await controller.tick();
 const original=await until(async()=>{const task=await readTask(stateDir,taskId);return task.threadId&&task.execution?.live&&task.reports.length?task:null;},'real live worker');
 await writeFile(path.join(original.worktree,'dirty-retained.txt'),'Retain these uncommitted fixture edits.\n');
 await bridge.startWork('Retain this manager conversation.','manager-race-request');
 assert.equal(bridge.state().activeTurnId,'manager-race-turn');assert.equal(bridge.state().workStarting,false);
 const view=async()=>inspectUpdateEvidence({stateDir,view:await controller.view()});
 const activity=async()=>updateActivity({work:bridge.state(),view:await view()});
 const engine=createUpdatePlan({stateDir,version:'0.15.0',getView:view,getManager:()=>bridge.state(),stopVoice:()=>bridge.stopVoice({cooperative:true}),interruptManager:options=>bridge.interrupt(options),requestAction:async request=>{
  enqueued.resolve();await releaseEnqueue.promise;
  return requestWorkerAction(stateDir,request);
 },activity});
 await engine.ready;await engine.begin({targetVersion:'0.16.2'});
 pendingTick=engine.tick();await enqueued.promise;
 assert.equal((await readUpdatePlan(stateDir)).phase,'draining');
 await writeFile(control,'finish manager naturally');
 await until(()=>bridge.state().status==='completed'&&bridge.state().activeTurnId===null&&!bridge.state().workStarting,'real manager terminal notification');
 assert.deepEqual(bridge.state().approvals,[]);
 releaseEnqueue.resolve();await pendingTick;pendingTick=undefined;
 assert.notEqual(engine.status().phase,'blocked',engine.status().reasons.join(' '));
 assert.equal((await engine.markInstalling({planId:engine.status().id,targetVersion:'0.16.2'})).marked,false,'a pause request does not establish install readiness');
 await until(async()=>{await controller.tick();await engine.tick();assert.notEqual(engine.status().phase,'blocked',engine.status().reasons.join(' '));return engine.status().phase==='ready';},'fresh worker process and exact pause proof');
 const paused=await readTask(stateDir,taskId),plan=engine.status();
 assert.equal(paused.status,'paused');assert.equal(paused.runId,original.runId);assert.equal(paused.threadId,original.threadId);assert.equal(paused.worktree,original.worktree);
 assert.equal(paused.execution.live,false);assert.equal(paused.execution.stopConfirmed,true);
 const proof=(await view()).tasks.find(task=>task.id===taskId).updateEvidence;
 assert.equal(proof.worker,'stopped');assert.ok(['stopped','absent'].includes(proof.runtime));assert.ok(proof.hooks.every(hook=>hook.state==='stopped'));
 assert.equal(plan.targets[0].pauseConfirmed,true);assert.equal(plan.targets[0].progress,'paused');assert.equal(plan.manager.interrupted,false);
 assert.equal(paused.lifecycleRequests.filter(request=>request.action==='pause').length,1);assert.equal(paused.lifecycleRequests.some(request=>request.action==='resume'),false);
 assert.equal(await readFile(workerSignals,'utf8'),'turn/interrupt\n','only cooperative native interruption was used');
 const exit=JSON.parse(await readFile(path.join(paused.runDir,'exit.json'),'utf8'));assert.equal(exit.stopConfirmed,true);assert.equal(exit.exitCode,0);assert.equal(exit.ownership.remaining.length,0);
 const managerCalls=(await readFile(calls,'utf8')).trim().split('\n').map(JSON.parse);
 assert.equal(managerCalls.some(call=>call.method==='turn/interrupt'||call.signal),false,'naturally completed manager was neither interrupted nor signaled');
 assert.equal(managerCalls.some(call=>call.id!==undefined&&!call.method),false,'no native approval response was sent automatically');
 assert.equal((await activity()).safe,true);
 assert.equal((await engine.markInstalling({planId:plan.id,targetVersion:plan.targetVersion})).marked,true);assert.equal(engine.status().phase,'installing');
 assert.equal(await readFile(path.join(paused.worktree,'dirty-retained.txt'),'utf8'),'Retain these uncommitted fixture edits.\n');
 assert.match((await exec('git',['-C',paused.worktree,'status','--porcelain'])).stdout,/dirty-retained\.txt/);
 assert.ok((await exec('git',['-C',repo,'worktree','list','--porcelain'])).stdout.includes(`worktree ${await realpath(paused.worktree)}\n`));
 assert.equal(JSON.parse(await readFile(statePath,'utf8')).threadId,'manager-race-thread');
 await until(async()=>{const saved=JSON.parse(await readFile(`${statePath}.conversation.json`,'utf8'));return saved.messages.some(message=>message.text==='Retained manager completion.');},'retained manager chat journal');
 assert.deepEqual(bridge.state().approvals,[]);
});
