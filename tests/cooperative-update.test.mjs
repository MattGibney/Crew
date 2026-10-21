import {workerAppServerFixture} from './helpers/worker-app-server-fixture.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';import path from 'node:path';import {tmpdir} from 'node:os';import {fileURLToPath,pathToFileURL} from 'node:url';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import {createController} from '../runtime/controller.mjs';import {createTask,readTask,updateTask,requestWorkerAction} from '../runtime/orchestration-store.mjs';
const exec=promisify(execFile),sourceDir=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../runtime');const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(fn,label){const until=Date.now()+15000;while(Date.now()<until){const result=await fn();if(result)return result;await sleep(40);}throw new Error('Timed out '+label);}
async function fixture(t,{environment={},timeoutMs=30000}={}){
 const dir=await mkdtemp(path.join(tmpdir(),'crew-cooperative-')),repo=path.join(dir,'repo'),stateDir=path.join(dir,'state');await mkdir(repo);await exec('git',['init','-b','main',repo]);await writeFile(path.join(repo,'README.md'),'disposable fixture');await exec('git',['-C',repo,'add','.']);await exec('git',['-C',repo,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','fixture']);
 const executable=path.join(dir,'fake-codex.mjs');await writeFile(executable,workerAppServerFixture(`#!${process.execPath}
import{readFile,appendFile}from'node:fs/promises';import{reportTask}from ${JSON.stringify(pathToFileURL(path.join(sourceDir,'orchestration-store.mjs')).href)};
const args=process.argv.slice(2),m=JSON.parse(args.find(a=>a.startsWith('mcp_servers.local_orchestration.args=')).split('=').slice(1).join('=')),[,state,,id,run]=m,task=JSON.parse(await readFile(state+'/tasks/'+id+'.json','utf8')),thread=args.includes('resume')?args[args.indexOf('resume')+1]:'thread-'+id;
process.on('fixtureInterrupt',async()=>{await appendFile(state+'/'+id+'-signals','turn/interrupt\\n');if(!task.brief.includes('ignore'))process.exit(0);});
process.on('SIGTERM',async()=>{await appendFile(state+'/'+id+'-signals','SIGTERM\\n');process.exit(0);});
console.log(JSON.stringify({type:'thread.started',thread_id:thread}));await reportTask(state,id,run,{reportId:'progress',kind:'progress',message:'Worker running'});setInterval(()=>{},1000);
`),{mode:0o700});
 let held=false;const project={id:'coop-project',mode:'repository',name:'Fixture',readiness:{ready:true},repositories:[{id:'repo',path:repo,baseRef:'main'}],worker:{sandbox:'read-only',timeoutMs,maxConcurrent:2,environment}};
 const controller=await createController({stateDir,sourceDir,executable,project,admissionHeld:async()=>held});const ids=[];
 const add=async(id,brief='cooperative')=>{ids.push(id);await createTask(stateDir,{requestId:id,ticket:'AI-018',brief,projectId:project.id,repositoryId:'repo'});await controller.tick();};
 const action=async(id,action,cooperative=false)=>{await requestWorkerAction(stateDir,{taskId:id,actionId:`${action}-${id}-${Date.now()}`,action,...(cooperative?{cooperative:true}:{})});await controller.tick();};
 t.after(async()=>{held=false;for(const id of ids){const task=await readTask(stateDir,id);await updateTask(stateDir,id,n=>{for(const r of n.lifecycleRequests||[])if(['pending','processing'].includes(r.status))r.status='failed';});if(task.harnessStarted&&!['paused','stopped','completed'].includes(task.status))await action(id,'stop').catch(()=>{});}await wait(async()=>{const tasks=await Promise.all(ids.map(id=>readTask(stateDir,id)));return tasks.every(task=>!task.harnessStarted||task.execution?.live===false);},'fixture cleanup').catch(()=>{});await controller.stop();await rm(dir,{recursive:true,force:true});});
 return{dir,stateDir,controller,add,action,hold:value=>held=value,get held(){return held;}};
}

test('concurrent workers cooperatively pause once and resume with their same chats/worktrees',async t=>{
 const f=await fixture(t);await f.add('cooperative-alpha');await f.add('cooperative-beta');
 const before=await wait(async()=>{const tasks=await Promise.all(['cooperative-alpha','cooperative-beta'].map(id=>readTask(f.stateDir,id)));return tasks.every(n=>n.threadId&&n.execution?.live&&n.reports.length)?tasks:null;},'two live workers');
 f.hold(true);await Promise.all(before.map(n=>f.action(n.id,'pause',true)));
 const paused=await wait(async()=>{const tasks=await Promise.all(before.map(n=>readTask(f.stateDir,n.id)));return tasks.every(n=>n.status==='paused'&&n.execution?.stopConfirmed===true)?tasks:null;},'cooperative pause');
 for(const task of paused){assert.equal(await readFile(path.join(f.stateDir,task.id+'-signals'),'utf8'),'turn/interrupt\n');assert.equal(task.threadId,before.find(n=>n.id===task.id).threadId);assert.equal(task.worktree,before.find(n=>n.id===task.id).worktree);}
 await f.action(paused[0].id,'resume');await sleep(300);assert.equal((await readTask(f.stateDir,paused[0].id)).runId,paused[0].runId);f.hold(false);await f.controller.tick();
 const resumed=await wait(async()=>{const n=await readTask(f.stateDir,paused[0].id);return n.runId!==paused[0].runId&&n.execution?.live?n:null;},'same chat resume');assert.equal(resumed.threadId,paused[0].threadId);assert.equal(resumed.worktree,paused[0].worktree);assert.equal((await readTask(f.stateDir,paused[1].id)).status,'paused');
});

test('held admission never launches queued tasks',async t=>{const f=await fixture(t);f.hold(true);await f.add('cooperative-queued');await sleep(350);let task=await readTask(f.stateDir,'cooperative-queued');assert.equal(task.status,'queued');assert.equal(task.worktree,undefined);f.hold(false);await f.controller.tick();await wait(async()=>(await readTask(f.stateDir,task.id)).threadId,'released queue');});

test('cooperative pause during preparation finishes the current bounded phase and never spawns a late worker',async t=>{
 const f=await fixture(t,{environment:{bootstrap:{command:process.execPath,args:['-e',"setTimeout(()=>require('fs').writeFileSync('setup-finished','yes'),650)"],timeoutMs:3000}}});await f.add('cooperative-preparing');
 await wait(async()=>(await readTask(f.stateDir,'cooperative-preparing')).environment?.hooks[0]?.supervisorPid,'preparation');f.hold(true);await f.action('cooperative-preparing','pause',true);
 const task=await wait(async()=>{const n=await readTask(f.stateDir,'cooperative-preparing');return n.status==='paused'?n:null;},'preparation safe boundary');assert.equal(task.harnessStarted,false);assert.equal(task.spawnIntentAt,null);assert.equal(task.threadId,undefined);assert.equal(await readFile(path.join(task.worktree,'setup-finished'),'utf8'),'yes');assert.equal(task.environment.hooks[0].status,'succeeded');await sleep(300);assert.equal((await readTask(f.stateDir,task.id)).harnessStarted,false);
});

test('noncooperative worker remains live and blocking past its old timeout without force escalation',async t=>{
 const f=await fixture(t,{timeoutMs:2000});await f.add('cooperative-refuses','ignore cooperative interrupt');await wait(async()=>{const n=await readTask(f.stateDir,'cooperative-refuses');return n.threadId&&n.execution?.live&&n.reports.length;},'noncooperative live');f.hold(true);await f.action('cooperative-refuses','pause',true);await wait(async()=>readFile(path.join(f.stateDir,'cooperative-refuses-signals'),'utf8').then(s=>s.includes('turn/interrupt')).catch(()=>false),'cooperative native interrupt');await sleep(2400);
 const task=await readTask(f.stateDir,'cooperative-refuses');assert.equal(task.status,'pausing');assert.equal(task.execution.live,true);assert.notEqual(task.execution.stopConfirmed,true);assert.equal(await readFile(path.join(f.stateDir,task.id+'-signals'),'utf8'),'turn/interrupt\n');
});

test('cooperative request correlation rejects a retry that silently changes pause semantics',async t=>{const f=await fixture(t);f.hold(true);await f.add('cooperative-correlation');const request={taskId:'cooperative-correlation',actionId:'cooperative-request',action:'pause',cooperative:true};await requestWorkerAction(f.stateDir,request);await assert.rejects(requestWorkerAction(f.stateDir,{...request,cooperative:false}),/changed content/);await assert.rejects(requestWorkerAction(f.stateDir,{...request,actionId:'cooperative-invalid',action:'stop'}),/only for pause/);});


test('explicit controller shutdown exits held preparation after its current phase without releasing hold or launching a worker',async t=>{
 const f=await fixture(t,{environment:{bootstrap:{command:process.execPath,args:['-e',"setTimeout(()=>require('fs').writeFileSync('setup-finished','natural'),650)"],timeoutMs:10000}}});await f.add('cooperative-quitprep');
 await wait(async()=>(await readTask(f.stateDir,'cooperative-quitprep')).environment?.hooks[0]?.supervisorPid,'running preparation');f.hold(true);
 let shutdownTimer;try{await Promise.race([f.controller.stop(),new Promise((_,reject)=>{shutdownTimer=setTimeout(()=>reject(new Error('Held preparation deadlocked controller shutdown')),15000);})]);}finally{clearTimeout(shutdownTimer);}
 const task=await readTask(f.stateDir,'cooperative-quitprep');assert.equal(task.status,'paused');assert.equal(task.harnessStarted,false);assert.equal(task.spawnIntentAt,null);assert.equal(task.threadId,undefined);assert.equal(task.preparationPause.reason,'controller-shutdown');assert.equal(f.held,true);assert.equal(task.environment.hooks[0].status,'succeeded');assert.equal(await readFile(path.join(task.worktree,'setup-finished'),'utf8'),'natural');
 await f.add('cooperative-afterquit');await sleep(150);assert.equal((await readTask(f.stateDir,'cooperative-afterquit')).status,'queued');assert.equal((await readTask(f.stateDir,'cooperative-afterquit')).worktree,undefined);
});


test('a queued never-launched task pauses and resumes without a nonexistent question',async t=>{
 const f=await fixture(t);f.hold(true);await f.add('cooperative-neverlaunch');await f.action('cooperative-neverlaunch','pause',true);
 await wait(async()=>(await readTask(f.stateDir,'cooperative-neverlaunch')).status==='paused','queued pause');await f.action('cooperative-neverlaunch','resume');
 const task=await wait(async()=>{const n=await readTask(f.stateDir,'cooperative-neverlaunch');return n.status==='queued'&&n.lifecycleRequests.at(-1)?.action==='resume'&&n.lifecycleRequests.at(-1)?.status==='completed'?n:null;},'queued resume completion');assert.equal(task.question,undefined);
 f.hold(false);await f.controller.tick();await wait(async()=>(await readTask(f.stateDir,task.id)).threadId,'previously queued worker starts');
});
