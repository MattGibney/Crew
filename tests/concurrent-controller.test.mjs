import {workerAppServerFixture} from './helpers/worker-app-server-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,realpath,rm,chmod,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';import path from 'node:path';import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFile,spawn}from'node:child_process';import{promisify}from'node:util';
import{createController}from'../runtime/workers/controller.mjs';
import{createTask,readTask,requestWorkerAction,answerQuestion,updateTask,reportTask,manageArchivedTask}from'../runtime/orchestration/store.mjs';
import{activeTasks,archivedTasks,isArchivedTask}from'../runtime/shared/worker-archive.mjs';
const exec=promisify(execFile),sourceDir=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../runtime');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(fn,description='condition'){const deadline=Date.now()+15000;while(Date.now()<deadline){const value=await fn();if(value)return value;await sleep(50);}throw new Error(`Timed out: ${description}`);}
const currentNativeRun=task=>Boolean(task.runId&&task.threadId&&task.execution?.runId===task.runId&&task.execution.live&&task.reports.some(report=>report.runId===task.runId&&report.kind==='progress'));
async function fixture(t,{environment={},mode='repository',holdResume=false,holdNativeStartup=false,stateName='state',globalCapacity=null}={}){
 const dir=await realpath(await mkdtemp(path.join(tmpdir(),'crew-concurrent-'))),stateDir=path.join(dir,stateName),repo=path.join(dir,'repo');await mkdir(repo);await exec('git',['init','-b','main',repo]);await writeFile(path.join(repo,'README.md'),'fixture');await exec('git',['-C',repo,'add','.']);await exec('git',['-C',repo,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','fixture']);
 const binary=path.join(dir,'fake-codex');
 await writeFile(binary,workerAppServerFixture(`#!${process.execPath}\nimport {spawn} from 'node:child_process';\nimport {readFile,appendFile,writeFile,access} from 'node:fs/promises';\nimport {reportTask} from ${JSON.stringify(pathToFileURL(path.join(sourceDir,'orchestration/store.mjs')).href)};\nconst args=process.argv.slice(2);const m=JSON.parse(args.find(a=>a.startsWith('mcp_servers.local_orchestration.args=')).split('=').slice(1).join('='));const [,state,,id,runId]=m;const task=JSON.parse(await readFile(state+'/tasks/'+id+'.json','utf8'));const resume=args.includes('resume');const thread=resume?args[args.indexOf('resume')+1]:'thread-'+id;if(resume&&${holdResume}){await writeFile(state+'/resume-waiting','held');while(!await access(state+'/resume-release').then(()=>true).catch(()=>false))await new Promise(r=>setTimeout(r,20));}console.log(JSON.stringify({type:'thread.started',thread_id:thread}));await appendFile(state+'/launches.jsonl',JSON.stringify({id,runId,pid:process.pid,thread,resume,at:Date.now()})+'\\n');await reportTask(state,id,runId,{reportId:'progress',kind:'progress',message:'Actual worker process running'});if(task.brief.includes('question')&&!resume){await reportTask(state,id,runId,{reportId:'question',kind:'question',message:'Choose an expected total'});console.log(JSON.stringify({type:'turn.completed'}));process.exit(0);}setInterval(()=>{},1000);\n`),{mode:0o700});
 const releaseNativeStartup=()=>writeFile(path.join(dir,'native-startup-release'),'continue');
 if(holdNativeStartup){
  const held=`await writeFile(${JSON.stringify(path.join(dir,'native-startup-waiting'))},'held');while(!await access(${JSON.stringify(path.join(dir,'native-startup-release'))}).then(()=>true).catch(()=>false))await new Promise(r=>setTimeout(r,20));await startWorkerFixture();`;
  await writeFile(binary,(await readFile(binary,'utf8')).replace('await startWorkerFixture();',held));
 }
 const project={id:'fixture-project',name:'Fixture',mode,readiness:{ready:true},repositories:[{id:'fixture-repo',path:repo,baseRef:'main'}],worker:{sandbox:'read-only',timeoutMs:60000,maxConcurrent:2,environment}};
 let controller=await createController({stateDir,sourceDir,executable:binary,project,globalCapacity});
 const created=[];const add=async(id,brief='long running')=>{created.push(id);await createTask(stateDir,{requestId:id,ticket:'AI-011',brief,projectId:project.id,repositoryId:'fixture-repo'});await controller.tick();};
 const action=async(id,action)=>{await requestWorkerAction(stateDir,{taskId:id,actionId:`action-${action}-${Date.now()}-${id}`,action});await controller.tick();};
 let draining;
 const drain=()=>draining??=(async()=>{
  try{
   if(holdNativeStartup)await releaseNativeStartup();
   for(const id of created){
    const task=await readTask(stateDir,id).catch(()=>null);
    if(task&&!['disposed','completed','failed','stopped','paused'].includes(task.status))await action(id,'stop');
   }
   await wait(async()=>{const tasks=await Promise.all(created.map(id=>readTask(stateDir,id)));return tasks.every(task=>!task.execution?.live);},'cleanup worker exits');
  }finally{await controller.stop();}
 })();
 let cleaned=false;
 const cleanup=async()=>{
  if(cleaned)return;
  await drain();
  const meta=await readFile(path.join(stateDir,'fixture.json'),'utf8').then(JSON.parse).catch(()=>null);
  if(meta?.base?.includes('crew-fixture-'))await rm(meta.base,{recursive:true,force:true});
  await rm(dir,{recursive:true,force:true});cleaned=true;
 };
 t.after(cleanup);
 return{cleanup,drain,releaseNativeStartup,dir,stateDir,repo,project,binary,add,action,get controller(){return controller;},restart:async()=>{await controller.stop();controller=await createController({stateDir,sourceDir,executable:binary,project,globalCapacity});}};
}
async function cleanupSharedFixtures(fixtures,capacityDir){
 // Every registered controller reads every project through the capacity ledger.
 // Stop all producers before removing any state: another controller's lock scan
 // otherwise recreates the directory during rm and skips remaining cleanup.
 const drained=await Promise.allSettled(fixtures.map(f=>f.drain()));
 const removed=await Promise.allSettled(fixtures.map(f=>f.cleanup()));
 const failures=[...drained,...removed].filter(result=>result.status==='rejected').map(result=>result.reason);
 if(failures.length)throw new AggregateError(failures,'Shared capacity fixture cleanup failed');
 await rm(capacityDir,{recursive:true,force:true});
}

test('shared ledger fixture cleanup quiesces every reader before deletion and preserves cleanup errors without skipping peers',async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'crew-capacity-cleanup-'));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 const states=[path.join(directory,'a'),path.join(directory,'b')];
 await Promise.all(states.map(dir=>mkdir(dir)));
 const {loadTasks}=await import('../runtime/orchestration/store.mjs');
 // The capacity reader really recreates a removed registered root when taking
 // its ordinary state lock. This is the producer that raced the old cleanup.
 await rm(states[0],{recursive:true});await loadTasks(states[0]);
 assert.equal((await stat(states[0])).isDirectory(),true);
 const readers=new Set(states),removed=[],injected=new Error('Injected first-state deletion failure');
 const fixtures=states.map((state,index)=>({
  async drain(){await Promise.resolve();readers.delete(state);},
  async cleanup(){
   assert.equal(readers.size,0,'every shared-ledger reader must stop before either root is removed');
   removed.push(state);await rm(state,{recursive:true});
   if(index===0)throw injected;
  },
 }));
 await assert.rejects(cleanupSharedFixtures(fixtures,directory),error=>{
  assert.ok(error instanceof AggregateError);assert.deepEqual(error.errors,[injected]);return true;
 });
 assert.deepEqual(removed,states,'one removal failure must not skip the other project cleanup');
 for(const state of states)await assert.rejects(stat(state),{code:'ENOENT'});
});

test('continuation snapshots wait for native identity and current-run progress after supervisor liveness',async t=>{
 const f=await fixture(t,{holdNativeStartup:true});await f.add('worker-delayed-native');
 await wait(()=>readFile(path.join(f.dir,'native-startup-waiting'),'utf8').catch(()=>null),'native startup deliberately held');
 const early=await wait(async()=>{const task=await readTask(f.stateDir,'worker-delayed-native');return task.execution?.live?task:null;},'supervisor liveness before native handshake');
 assert.equal(early.threadId,undefined);assert.equal(currentNativeRun(early),false);
 let observations=0,settled=false;
 const observed=wait(async()=>{observations++;const task=await readTask(f.stateDir,early.id);return currentNativeRun(task)?task:null;},'bound native identity and current-run progress');
 void observed.then(()=>{settled=true;},()=>{});
 await wait(()=>observations>=2,'observer remains pending while native startup is held');
 assert.equal(settled,false,'a live supervisor alone cannot capture a continuation baseline');
 await f.releaseNativeStartup();const first=await observed;
 assert.ok(first.threadId);assert.equal(first.runId,early.runId);
 await f.action(first.id,'stop');await wait(async()=>(await readTask(f.stateDir,first.id)).status==='stopped','delayed native worker stopped');
 await f.action(first.id,'resume');const next=await wait(async()=>{const task=await readTask(f.stateDir,first.id);return task.runId!==first.runId&&currentNativeRun(task)?task:null;},'same conversation resumed with current-run evidence');
 assert.equal(next.threadId,first.threadId);assert.equal(next.worktree,first.worktree);
});

test('two real harnesses/worktrees run concurrently; question yields capacity and resumes same chat while another runs',async t=>{
 const f=await fixture(t);await f.add('worker-question','ask question');await f.add('worker-running');
 const question=await wait(async()=>{const q=await readTask(f.stateDir,'worker-question'),other=await readTask(f.stateDir,'worker-running');return q.status==='awaiting_answer'&&other.threadId&&q.execution?.live===false?q:null;},'question and parallel running');
 const other=await readTask(f.stateDir,'worker-running');assert.notEqual(question.worktree,other.worktree);assert.notEqual(question.threadId,other.threadId);
 await f.add('worker-third');await wait(async()=>(await readTask(f.stateDir,'worker-third')).threadId,'third uses yielded slot');
 await f.action('worker-third','stop');await wait(async()=>(await readTask(f.stateDir,'worker-third')).status==='stopped','target stop');
 await answerQuestion(f.stateDir,{taskId:question.id,questionId:question.question.id,answer:'zero'});await f.controller.tick();
 const resumed=await wait(async()=>{const q=await readTask(f.stateDir,question.id);return q.runId!==question.runId&&q.threadId===question.threadId&&q.status==='running'&&currentNativeRun(q)?q:null;},'same conversation resume');assert.equal(resumed.worktree,question.worktree);assert.equal((await readTask(f.stateDir,other.id)).runId,other.runId);
});
test('targeted stop, controller restart adoption, general resume and dirty disposal refusal',async t=>{
 const f=await fixture(t);await f.add('worker-stop');await f.add('worker-other');await wait(async()=>currentNativeRun(await readTask(f.stateDir,'worker-stop'))&&currentNativeRun(await readTask(f.stateDir,'worker-other')),'both started');
 const before=await readTask(f.stateDir,'worker-stop'),other=await readTask(f.stateDir,'worker-other');await f.restart();await sleep(400);assert.equal((await readTask(f.stateDir,before.id)).runId,before.runId);const launchLines=(await readFile(path.join(f.stateDir,'launches.jsonl'),'utf8')).trim().split('\n');assert.equal(launchLines.length,2);
 await f.action(before.id,'pause');await wait(async()=>(await readTask(f.stateDir,before.id)).status==='paused','paused');assert.equal((await readTask(f.stateDir,other.id)).execution.live,true);
 await f.action(before.id,'resume');const resumed=await wait(async()=>{const n=await readTask(f.stateDir,before.id);return n.runId!==before.runId&&n.status==='running'&&currentNativeRun(n)?n:null;},'general resume');assert.equal(resumed.threadId,before.threadId);assert.equal(resumed.worktree,before.worktree);
 await f.action(before.id,'stop');await wait(async()=>(await readTask(f.stateDir,before.id)).status==='stopped','stopped');await writeFile(path.join(before.worktree,'keep-me.txt'),'valuable change');await f.action(before.id,'dispose');const blocked=await wait(async()=>{const n=await readTask(f.stateDir,before.id);return n.lifecycleRequests.at(-1).status==='failed'?n:null;},'dirty disposal refused');assert.equal(blocked.status,'stopped');assert.equal(blocked.lifecycleRequests.at(-1).status,'failed');assert.match(blocked.lifecycleRequests.at(-1).error,/contains changes/);await rm(path.join(before.worktree,'keep-me.txt'));await f.action(before.id,'dispose');await wait(async()=>(await readTask(f.stateDir,before.id)).status==='disposed','disposed');assert.equal((await readTask(f.stateDir,other.id)).execution.live,true);
});
test('configured failing environment commands are agent context and do not block independent workers',async t=>{
 const log=path.join(tmpdir(),`crew-no-auto-hooks-${Date.now()}.jsonl`);t.after(()=>rm(log,{force:true}));
 const bootstrap={command:process.execPath,args:['-e',`require('node:fs').appendFileSync(${JSON.stringify(log)},'unexpected');process.exit(3)`],timeoutMs:1000};
 const f=await fixture(t,{environment:{bootstrap,ready:{command:'/no-such-readiness-command',args:[],timeoutMs:1000}}});await f.add('worker-hookfail');await f.add('worker-hookgood');
 const tasks=await wait(async()=>{const a=await readTask(f.stateDir,'worker-hookfail'),b=await readTask(f.stateDir,'worker-hookgood');return currentNativeRun(a)&&currentNativeRun(b)?[a,b]:null;},'both native workers bypass configured command gates');
 assert.notEqual(tasks[0].worktree,tasks[1].worktree);assert.notEqual(tasks[0].threadId,tasks[1].threadId);await assert.rejects(readFile(log),{code:'ENOENT'});
 for(const task of tasks){const config=JSON.parse(await readFile(path.join(task.runDir,'config.json'),'utf8'));assert.equal(config.agentOwnedEnvironment,true);assert.deepEqual(config.project.worker.environment.bootstrap,bootstrap);assert.equal(task.failure,null);}
});

test('concurrent first fixture launches share one repository and preserve resume ownership',async t=>{const f=await fixture(t,{mode:'fixture'});await f.add('fixture-question','ask question');await f.add('fixture-parallel');const q=await wait(async()=>{const n=await readTask(f.stateDir,'fixture-question');if(n.status==='failed')throw new Error(`Fixture question failed: ${n.failure}; execution=${JSON.stringify(n.execution)}`);return n.status==='awaiting_answer'&&!n.execution?.live?n:null;},'fixture question').catch(async error=>{const n=await readTask(f.stateDir,'fixture-question');throw new Error(`${error.message}; status=${n.status}; execution=${JSON.stringify(n.execution)}; reports=${JSON.stringify(n.reports.map(r=>r.kind))}`);});const other=await wait(async()=>{const n=await readTask(f.stateDir,'fixture-parallel');return currentNativeRun(n)?n:null;},'parallel fixture');assert.equal(q.fixtureRepo,other.fixtureRepo);assert.notEqual(q.worktree,other.worktree);await answerQuestion(f.stateDir,{taskId:q.id,questionId:q.question.id,answer:'zero'});await f.controller.tick();await wait(async()=>{const n=await readTask(f.stateDir,q.id);return n.runId!==q.runId&&n.status==='running'&&currentNativeRun(n);},'fixture same-repository resume');});
test('stop and resume skip environment commands while explicit archive runs only its declared cleanup',async t=>{
 const f=await fixture(t);const marker=path.join(f.dir,'automatic-phase');const hook=phase=>({command:process.execPath,args:['-e',`require('node:fs').appendFileSync(${JSON.stringify(marker)},${JSON.stringify(phase+'\n')})`],timeoutMs:1000});f.project.worker.environment=Object.fromEntries(['bootstrap','start','ready','resume','cleanup'].map(phase=>[phase,hook(phase)]));
 await f.add('worker-cleanup');await f.add('worker-continue');const first=await wait(async()=>{const n=await readTask(f.stateDir,'worker-cleanup');return currentNativeRun(n)?n:null;},'first native worker');await wait(async()=>(await readTask(f.stateDir,'worker-continue')).execution?.live,'independent native worker');
 await f.action(first.id,'stop');await wait(async()=>(await readTask(f.stateDir,first.id)).status==='stopped','first stop');await f.action(first.id,'resume');const resumed=await wait(async()=>{const n=await readTask(f.stateDir,first.id);return n.runId!==first.runId&&currentNativeRun(n)?n:null;},'same context resumed');assert.equal(resumed.threadId,first.threadId);assert.equal(resumed.worktree,first.worktree);
 await f.action(first.id,'stop');await wait(async()=>(await readTask(f.stateDir,first.id)).status==='stopped','second stop');await f.action(first.id,'archive');await f.action('worker-continue','stop');const archived=await wait(async()=>{const n=await readTask(f.stateDir,first.id);return n.status==='disposed'?n:null;},'archive completed');await wait(async()=>(await readTask(f.stateDir,'worker-continue')).status==='stopped','independent stop');assert.equal(await readFile(marker,'utf8'),'cleanup\n');assert.ok(archived.activeMs>0);const time=archived.activeMs;await f.controller.tick();assert.equal((await readTask(f.stateDir,first.id)).activeMs,time);
});

test('missing and changed environment executables never gate initial dispatch or same-context continuation',async t=>{
 const f=await fixture(t,{environment:{bootstrap:{command:'/no-such-crew-hook',args:[],timeoutMs:1000}}});await f.add('worker-missinghook');const first=await wait(async()=>{const n=await readTask(f.stateDir,'worker-missinghook');return currentNativeRun(n)?n:null;},'native execution despite missing configured command');await f.action(first.id,'stop');await wait(async()=>(await readTask(f.stateDir,first.id)).status==='stopped','native stop');f.project.worker.environment.bootstrap={command:'/another-missing-crew-hook',args:[],timeoutMs:1000};await f.action(first.id,'resume');const next=await wait(async()=>{const n=await readTask(f.stateDir,first.id);return n.runId!==first.runId&&currentNativeRun(n)?n:null;},'native continuation despite changed command');assert.equal(next.threadId,first.threadId);assert.equal(next.worktree,first.worktree);assert.equal(next.failure,null);
 const config=JSON.parse(await readFile(path.join(next.runDir,'config.json'),'utf8'));assert.equal(config.project.worker.environment.bootstrap.command,'/another-missing-crew-hook');assert.ok(!next.environment?.hooks?.length);
});

test('declared long preparation is not automatic while a vanished native executable remains an actual per-worker failure',async t=>{
 const f=await fixture(t,{environment:{bootstrap:{command:process.execPath,args:['-e','setTimeout(()=>{},10000)'],timeoutMs:15000}}});await f.add('worker-preparing');const first=await wait(async()=>{const n=await readTask(f.stateDir,'worker-preparing');return currentNativeRun(n)?n:null;},'native worker starts without slow preparation');assert.ok(!first.environment?.hooks?.length);await rm(f.binary);await f.add('worker-missingcodex');const failed=await wait(async()=>{const n=await readTask(f.stateDir,'worker-missingcodex');return n.status==='failed'?n:null;},'actual native executable missing');assert.ok(failed.failure);assert.equal((await readTask(f.stateDir,first.id)).execution.live,true);
});

test('native worker survives controller SIGKILL and is adopted once without automatic environment commands',async t=>{
 const f=await fixture(t,{environment:{bootstrap:{command:'/missing-bootstrap-must-not-run',args:[],timeoutMs:1000}}});await f.controller.stop();await f.add('worker-crashcontext');
 const script=`import{createController}from ${JSON.stringify(pathToFileURL(path.join(sourceDir,'workers/controller.mjs')).href)};await createController(${JSON.stringify({stateDir:f.stateDir,sourceDir,executable:f.binary,project:f.project})});await(await import('node:fs/promises')).writeFile(${JSON.stringify(path.join(f.stateDir,'controller-ready'))},'ready');setInterval(()=>{},1000);`;
 const child=spawn(process.execPath,['--input-type=module','-e',script],{stdio:'ignore'});child.on('error',()=>{});const exited=new Promise(r=>child.once('exit',r));t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});await wait(async()=>readFile(path.join(f.stateDir,'controller-ready'),'utf8').catch(()=>null),'child controller');await requestWorkerAction(f.stateDir,{taskId:'worker-crashcontext',actionId:'explicit-crash-start',action:'start'});const before=await wait(async()=>{const n=await readTask(f.stateDir,'worker-crashcontext');return currentNativeRun(n)?n:null;},'actual native worker');child.kill('SIGKILL');await exited;await f.restart();const adopted=await wait(async()=>{const n=await readTask(f.stateDir,before.id);return currentNativeRun(n)?n:null;},'adopted native process');assert.equal(adopted.runId,before.runId);assert.equal(adopted.threadId,before.threadId);assert.equal((await readFile(path.join(f.stateDir,'launches.jsonl'),'utf8')).trim().split('\n').length,1);await f.action(before.id,'stop');await wait(async()=>(await readTask(f.stateDir,before.id)).status==='stopped','confirmed stop');assert.equal(JSON.parse(await readFile(path.join(before.runDir,'exit.json'),'utf8')).stopConfirmed,true);await f.action(before.id,'archive');await wait(async()=>(await readTask(f.stateDir,before.id)).status==='disposed','safe archive');
});

test('restart adopts live supervisor before lifecycle despite interrupted harnessStarted persistence',async t=>{const f=await fixture(t,{holdResume:true});await f.add('worker-spawnrace');const original=await wait(async()=>{const n=await readTask(f.stateDir,'worker-spawnrace');return currentNativeRun(n)?n:null;},'actual harness started');await f.controller.stop();await updateTask(f.stateDir,original.id,n=>{n.harnessStarted=false;n.runnerPid=null;n.threadId=null;});await requestWorkerAction(f.stateDir,{taskId:original.id,actionId:'spawn-race-stop',action:'stop'});await f.restart();const stopped=await wait(async()=>{const n=await readTask(f.stateDir,original.id);return n.status==='stopped'&&n.lifecycleRequests.at(-1).status==='completed'?n:null;},'owned stop after interrupted persistence');assert.equal(stopped.harnessStarted,true);assert.equal(stopped.threadId,original.threadId);const exit=JSON.parse(await readFile(path.join(original.runDir,'exit.json'),'utf8'));assert.equal(exit.stopConfirmed,true);assert.equal(exit.stopped,true);assert.equal(exit.stopRequestId,'spawn-race-stop');await f.action(original.id,'resume');await wait(async()=>readFile(path.join(f.stateDir,'resume-waiting'),'utf8').catch(()=>null),'held resumed process before its launch evidence');const dispatch=await readTask(f.stateDir,original.id);assert.notEqual(dispatch.runId,original.runId);assert.equal(dispatch.status,'running');assert.equal(dispatch.threadId,original.threadId);assert.equal((await readFile(path.join(f.stateDir,'launches.jsonl'),'utf8')).trim().split('\n').length,1,'dispatch state and inherited thread do not prove resumed CLI startup');await writeFile(path.join(f.stateDir,'resume-release'),'continue');const resumed=await wait(async()=>{const n=await readTask(f.stateDir,original.id);return n.runId!==original.runId&&n.threadId&&n.status==='running'&&n.execution?.runId===n.runId&&n.execution.live&&n.reports.some(r=>r.runId===n.runId&&r.kind==='progress')?n:null;},'single same-session resume with current-run execution evidence');assert.equal(resumed.threadId,original.threadId);assert.equal(resumed.worktree,original.worktree);const records=(await readFile(path.join(f.stateDir,'launches.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);assert.equal(records.filter(r=>r.id===original.id).length,2);});

test('uncertain pending spawn with no PID or matching terminal record cannot dispose its worktree',async t=>{const f=await fixture(t);await f.add('worker-uncertain');const original=await wait(async()=>{const n=await readTask(f.stateDir,'worker-uncertain');return currentNativeRun(n)?n:null;},'initial owned run');await f.action(original.id,'stop');await wait(async()=>{const n=await readTask(f.stateDir,original.id);return n.status==='stopped'&&n.lifecycleRequests.at(-1).status==='completed';},'initial stop confirmed');const uncertainDir=path.join(f.stateDir,'runs',original.id,'uncertain-run');await mkdir(uncertainDir);await updateTask(f.stateDir,original.id,n=>{n.status='failed';n.harnessStarted='pending';n.runnerPid=null;n.runId='uncertain-run';n.runDir=uncertainDir;});await f.action(original.id,'dispose');const refused=await wait(async()=>{const n=await readTask(f.stateDir,original.id);return n.lifecycleRequests.at(-1).status==='failed'?n:null;},'unknown spawn disposal refused');assert.match(refused.lifecycleRequests.at(-1).error,/no matching confirmed terminal record/);assert.equal(refused.status,'failed');assert.equal(await readFile(path.join(original.worktree,'README.md'),'utf8'),'fixture');});

test('historical exit confirmation metadata does not gate continuation after the actual native connection exited',async t=>{
 const f=await fixture(t);await f.add('worker-unconfirmed');const original=await wait(async()=>{const n=await readTask(f.stateDir,'worker-unconfirmed');return currentNativeRun(n)?n:null;},'native worker');await f.action(original.id,'stop');await wait(async()=>{const n=await readTask(f.stateDir,original.id);return n.status==='stopped'&&n.lifecycleRequests.at(-1).status==='completed';},'actual native stop');await f.controller.stop();const file=path.join(original.runDir,'exit.json'),exit=JSON.parse(await readFile(file,'utf8'));exit.stopConfirmed=false;exit.ownership.confirmed=false;await writeFile(file,JSON.stringify(exit));await updateTask(f.stateDir,original.id,n=>{n.status='failed';});await f.restart();await f.action(original.id,'resume');const next=await wait(async()=>{const n=await readTask(f.stateDir,original.id);return n.runId!==original.runId&&n.execution?.runId===n.runId&&n.execution.live&&n.reports.some(r=>r.runId===n.runId)?n:null;},'retained context resumes without historical confirmation gate');assert.equal(next.threadId,original.threadId);assert.equal(next.worktree,original.worktree);assert.equal((await readFile(path.join(f.stateDir,'launches.jsonl'),'utf8')).trim().split('\n').length,2);assert.equal(JSON.parse(await readFile(file,'utf8')).stopConfirmed,false,'historical evidence is not rewritten to invent confirmation');
});

test('state mutation locks recover a SIGKILL owner without losing or duplicating the task',async t=>{const dir=await mkdtemp(path.join(tmpdir(),'crew-state-lock-'));t.after(()=>rm(dir,{recursive:true,force:true}));await createTask(dir,{requestId:'worker-lockproof',ticket:'AI-012',brief:'Crash lock proof'});const script=`import{updateTask}from ${JSON.stringify(pathToFileURL(path.join(sourceDir,'orchestration/store.mjs')).href)};setInterval(()=>{},1000);await updateTask(${JSON.stringify(dir)},'worker-lockproof',async()=>{console.log('LOCKED');await new Promise(()=>{});});`;const child=spawn(process.execPath,['--input-type=module','-e',script],{stdio:['ignore','pipe','ignore']});child.on('error',()=>{});const exited=new Promise(r=>child.once('exit',r));t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});await new Promise((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(new Error('Child did not acquire state locks')),5000);child.stdout.on('data',chunk=>{output+=String(chunk);if(output.includes('LOCKED')){clearTimeout(timer);resolve();}});});child.kill('SIGKILL');await exited;const writer=`import{updateTask}from ${JSON.stringify(pathToFileURL(path.join(sourceDir,'orchestration/store.mjs')).href)};await updateTask(${JSON.stringify(dir)},'worker-lockproof',task=>{task.recoveryCount=(task.recoveryCount||0)+1;});`;await Promise.all([exec(process.execPath,['--input-type=module','-e',writer]),exec(process.execPath,['--input-type=module','-e',writer])]);await updateTask(dir,'worker-lockproof',task=>{task.progress='Recovered after verified owner exit';});const task=await readTask(dir,'worker-lockproof');assert.equal(task.revision,4);assert.equal(task.recoveryCount,2);assert.equal(task.progress,'Recovered after verified owner exit');const {readdir}=await import('node:fs/promises');const entries=await readdir(dir);assert.ok(!entries.some(name=>name.startsWith('.schedule.lock.stale-')),'retired barriers are reclaimed once no observers remain');assert.ok(!entries.includes('.schedule.lock'));});

test('execution timing records actual native processes while configured bootstrap and resume commands stay inert',async t=>{
 const f=await fixture(t,{environment:{bootstrap:{command:'/missing-bootstrap',args:[],timeoutMs:1000}}});await f.add('worker-timing');const first=await wait(async()=>{const n=await readTask(f.stateDir,'worker-timing');return currentNativeRun(n)?n:null;},'actual first native process and retained native thread');assert.ok(first.startedAt);assert.equal(first.execution.runId,first.runId);assert.ok(!first.environment?.hooks?.length);await f.action(first.id,'stop');const stopped=await wait(async()=>{const n=await readTask(f.stateDir,first.id);return n.status==='stopped'&&n.accountedRuns?.includes(first.runId)?n:null;},'first run accounted');assert.ok(stopped.activeMs>0);f.project.worker.environment.resume={command:'/missing-resume',args:[],timeoutMs:1000};await f.action(first.id,'resume');const next=await wait(async()=>{const n=await readTask(f.stateDir,first.id);return n.runId!==first.runId&&currentNativeRun(n)?n:null;},'next real native process');assert.ok(next.startedAt);assert.ok(next.activeMs>=stopped.activeMs);assert.ok(!next.environment?.hooks?.length);assert.equal(next.threadId,first.threadId);
});

test('supervisor startup observation uses fresh spawn evidence rather than an older controller timestamp',async t=>{
 const f=await fixture(t,{holdResume:true});await f.add('worker-startgrace');const first=await wait(async()=>{const n=await readTask(f.stateDir,'worker-startgrace');return currentNativeRun(n)?n:null;},'first process');await f.action(first.id,'stop');await wait(async()=>(await readTask(f.stateDir,first.id)).status==='stopped','initial stop');await f.action(first.id,'resume');await wait(async()=>readFile(path.join(f.stateDir,'resume-waiting'),'utf8').catch(()=>null),'resumed native child waiting');await updateTask(f.stateDir,first.id,n=>{n.launchAt=new Date(Date.now()-120000).toISOString();});await f.controller.tick();const held=await readTask(f.stateDir,first.id);assert.equal(held.status,'running');assert.equal(held.failure,null);assert.notEqual(held.runId,first.runId);await writeFile(path.join(f.stateDir,'resume-release'),'continue');await wait(async()=>{const n=await readTask(f.stateDir,first.id);return n.runId!==first.runId&&n.execution?.runId===n.runId&&n.execution.live&&n.reports.some(r=>r.runId===n.runId)?n:null;},'real resumed native execution');
});

test('private state with spaces uses a registered no-space checkout and retains it through stop/resume/disposal',async t=>{
 const f=await fixture(t,{stateName:'Application Support Crew State'});await f.add('worker-spacepath');
 const first=await wait(async()=>{const n=await readTask(f.stateDir,'worker-spacepath');if(n.status==='failed')throw new Error(n.failure);return currentNativeRun(n)?n:null;},'owned worker in compact checkout');
 assert.match(f.stateDir,/\s/);assert.equal(/\s/.test(first.worktree),false);assert.equal(first.worktreeRoot,path.dirname(first.worktree));assert.match(path.basename(first.worktree),/^crew-[a-f0-9]{32}$/);
 const listed=(await exec('git',['-C',f.repo,'worktree','list','--porcelain'])).stdout;assert.ok(listed.includes(first.worktree));
 await f.action(first.id,'stop');await wait(async()=>{const n=await readTask(f.stateDir,first.id);return n.status==='stopped'&&n.lifecycleRequests.at(-1).status==='completed';},'confirmed stop');await f.action(first.id,'resume');
 const resumed=await wait(async()=>{const n=await readTask(f.stateDir,first.id);if(n.status==='failed')throw new Error(n.failure);return n.runId!==first.runId&&n.execution?.runId===n.runId&&n.execution.live&&n.reports.some(r=>r.runId===n.runId&&r.kind==='progress')?n:null;},'same compact checkout resumed');assert.equal(resumed.worktree,first.worktree);assert.equal(resumed.worktreeRoot,first.worktreeRoot);assert.equal(resumed.threadId,first.threadId);
 await f.action(first.id,'stop');await wait(async()=>{const n=await readTask(f.stateDir,first.id);return n.status==='stopped'&&n.lifecycleRequests.at(-1).status==='completed';},'resumed stop confirmed');await f.action(first.id,'dispose');await wait(async()=>(await readTask(f.stateDir,first.id)).status==='disposed','clean owned checkout disposal');
 const {access,rmdir}=await import('node:fs/promises');await assert.rejects(access(first.worktree),{code:'ENOENT'});assert.equal((await exec('git',['-C',f.repo,'worktree','list','--porcelain'])).stdout.includes(first.worktree),false);await rmdir(first.worktreeRoot);
});


test('stopped questions do not gate same-context resume and reused report IDs retain exact run correlation',async t=>{
 const f=await fixture(t);await f.add('worker-retained-question','ask question');const first=await wait(async()=>{const n=await readTask(f.stateDir,'worker-retained-question');return n.status==='awaiting_answer'&&n.execution?.live===false?n:null;},'question boundary');await f.action(first.id,'stop');await wait(async()=>(await readTask(f.stateDir,first.id)).status==='stopped','question stopped');await updateTask(f.stateDir,first.id,n=>{n.answer={questionId:'older-question',text:'Historical answer',at:new Date().toISOString()};});await f.action(first.id,'resume');const resumed=await wait(async()=>{const n=await readTask(f.stateDir,first.id);return n.runId!==first.runId&&n.execution?.runId===n.runId&&n.execution.live&&n.reports.some(r=>r.runId===n.runId)?n:null;},'resume without mandatory answer');assert.equal(resumed.threadId,first.threadId);await reportTask(f.stateDir,first.id,resumed.runId,{reportId:first.question.id,kind:'question',message:'Current-run question reusing a historical report ID'});const next=await wait(async()=>{const n=await readTask(f.stateDir,first.id);return n.question?.runId===resumed.runId?n:null;},'current question correlation');assert.equal(next.answer,null);await f.action(first.id,'stop');await wait(async()=>(await readTask(f.stateDir,first.id)).status==='stopped','second stop');await f.action(first.id,'resume');const continued=await wait(async()=>{const n=await readTask(f.stateDir,first.id);return n.runId!==resumed.runId&&currentNativeRun(n)?n:null;},'second resume without question gate');assert.equal(continued.threadId,first.threadId);
});

test('separate project controllers share one capacity ledger; restart preserves workers and holds queued backlog for explicit start', async t => {
 const capacityDir=await mkdtemp(path.join(tmpdir(),'crew-global-capacity-'));
 const fixtures=[];t.after(()=>cleanupSharedFixtures(fixtures,capacityDir));
 const {configureGlobalCapacity}=await import('../runtime/orchestration/capacity.mjs');
 await configureGlobalCapacity({dir:capacityDir,limit:1});
 const a=await fixture(t,{globalCapacity:{dir:capacityDir}});fixtures.push(a);const b=await fixture(t,{globalCapacity:{dir:capacityDir}});fixtures.push(b);
 await Promise.all([a.add('project-a-worker'),b.add('project-b-worker')]);
 const first=await wait(async()=>{const tasks=await Promise.all([readTask(a.stateDir,'project-a-worker'),readTask(b.stateDir,'project-b-worker')]);return tasks.some(n=>n.execution?.live)?tasks:null;},'one global worker');
 await sleep(500);
 const aLive=(await readTask(a.stateDir,'project-a-worker')).execution?.live;
 const active=aLive?a:b,waiting=aLive?b:a,activeId=aLive?'project-a-worker':'project-b-worker',waitingId=aLive?'project-b-worker':'project-a-worker';
 assert.equal((await readTask(waiting.stateDir,waitingId)).status,'queued');
 assert.match((await readTask(waiting.stateDir,waitingId)).capacityWait,/shared worker capacity/);
 const original=await readTask(active.stateDir,activeId);await active.restart();
 assert.equal((await readTask(active.stateDir,activeId)).runId,original.runId);
 await waiting.restart();await active.action(activeId,'stop');
 await wait(async()=>(await readTask(active.stateDir,activeId)).status==='stopped','owned stop releases global slot');
 await sleep(500);assert.equal((await readTask(waiting.stateDir,waitingId)).status,'queued','reopen cannot execute old backlog');
 await configureGlobalCapacity({dir:capacityDir,admissionPaused:true});await waiting.action(waitingId,'start');await sleep(400);assert.equal((await readTask(waiting.stateDir,waitingId)).status,'queued');const held=await readTask(waiting.stateDir,waitingId);assert.equal(Boolean(held.harnessStarted),false);assert.equal(held.threadId,undefined);assert.equal(JSON.parse(await readFile(path.join(capacityDir,'capacity.json'),'utf8')).admissionPaused,true);await waiting.restart();await waiting.action(waitingId,'start');await sleep(400);assert.equal((await readTask(waiting.stateDir,waitingId)).status,'queued','global update pause survives controller restart');await configureGlobalCapacity({dir:capacityDir,admissionPaused:false});await wait(async()=>(await readTask(waiting.stateDir,waitingId)).execution?.live,'explicit start admits waiting workspace').catch(async error=>{throw new Error(error.message+' '+JSON.stringify(await waiting.controller.view())+' ledger '+await readFile(path.join(capacityDir,'capacity.json'),'utf8'));});
 assert.equal((await readTask(active.stateDir,activeId)).runId,original.runId);
});


test('recovery interrupts old pending start and processing resume requests until fresh correlated manager actions',async t=>{
 const f=await fixture(t);await f.add('worker-stored-resume');
 const prior=await wait(async()=>{const n=await readTask(f.stateDir,'worker-stored-resume');return currentNativeRun(n)?n:null;},'initial saved session');
 await f.action(prior.id,'stop');await wait(async()=>(await readTask(f.stateDir,prior.id)).status==='stopped','initial worker stopped');
 await f.controller.stop();await f.add('worker-stored-start');
 await requestWorkerAction(f.stateDir,{taskId:'worker-stored-start',actionId:'stored-start-request',action:'start',expectedRunId:null});
 await requestWorkerAction(f.stateDir,{taskId:prior.id,actionId:'stored-resume-request',action:'resume',expectedRunId:prior.runId});
 await updateTask(f.stateDir,prior.id,n=>{n.lifecycleRequests.find(request=>request.id==='stored-resume-request').status='processing';});
 await f.restart();await sleep(400);
 const queued=await readTask(f.stateDir,'worker-stored-start'),stopped=await readTask(f.stateDir,prior.id);
 assert.equal(queued.status,'queued');assert.equal(queued.runId,undefined);assert.equal(stopped.status,'stopped');assert.equal(stopped.runId,prior.runId);
 for(const task of [queued,stopped]){const request=task.lifecycleRequests.at(-1);assert.equal(request.status,'failed');assert.match(request.error,/Controller restarted before start\/resume completed/);assert.ok(request.handledAt);}
 assert.equal((await readFile(path.join(f.stateDir,'launches.jsonl'),'utf8')).trim().split('\n').length,1,'no new harness from stored lifecycle intent');
 await f.action(queued.id,'start');await f.action(prior.id,'resume');
 await wait(async()=>{const a=await readTask(f.stateDir,queued.id),b=await readTask(f.stateDir,prior.id);return a.execution?.live&&b.runId!==prior.runId&&b.execution?.runId===b.runId&&b.execution.live;},'fresh correlated start and resume launch');
 const resumed=await readTask(f.stateDir,prior.id);assert.equal(resumed.threadId,prior.threadId);assert.equal(resumed.worktree,prior.worktree);assert.equal(resumed.lifecycleRequests.find(r=>r.id==='stored-resume-request').status,'failed');
});

test('archive retains dirty-resource failures and confirmed history across restart without automatic cleanup commands', async t => {
 const f=await fixture(t,{environment:{cleanup:{command:process.execPath,args:['-e','setTimeout(()=>{},700)'],timeoutMs:5000}}});
 await f.add('worker-archive');
 const first=await wait(async()=>{const n=await readTask(f.stateDir,'worker-archive');return currentNativeRun(n)?n:null;},'owned archive worker');
 await f.action(first.id,'stop');
 await wait(async()=>{const n=await readTask(f.stateDir,first.id);return n.status==='stopped'&&n.lifecycleRequests.at(-1).status==='completed';},'confirmed inactive worker');
 await writeFile(path.join(first.worktree,'preserve.txt'),'unreviewed changes');
 await f.action(first.id,'archive');
 const failed=await wait(async()=>{const n=await readTask(f.stateDir,first.id);return n.lifecycleRequests.at(-1).status==='failed'?n:null;},'dirty archive refusal');
 assert.equal(isArchivedTask(failed),false);assert.equal(failed.archivedAt,undefined);assert.match(failed.lifecycleRequests.at(-1).error,/contains changes/);
 await rm(path.join(first.worktree,'preserve.txt'));
 const request={taskId:first.id,actionId:'confirmed-archive-request',action:'archive',expectedRunId:first.runId};
 await requestWorkerAction(f.stateDir,request);await f.controller.tick();
 const archived=await wait(async()=>{const n=await readTask(f.stateDir,first.id);return isArchivedTask(n)?n:null;},'confirmed archive');
 assert.equal(archived.status,'disposed');assert.equal(archived.archivedAt,archived.disposedAt);assert.ok(Date.parse(archived.archivedAt));
 assert.equal(archived.brief,first.brief);assert.deepEqual(archived.reports,failed.reports);assert.equal(archived.threadId,first.threadId);assert.ok(archived.history.some(event=>event.id==='assignment'));
 const retained=await f.controller.view();assert.equal(activeTasks(retained.tasks).length,0);assert.equal(archivedTasks(retained.tasks)[0].id,first.id);
 await requestWorkerAction(f.stateDir,request);await f.restart();await f.controller.tick();
 const recovered=await readTask(f.stateDir,first.id);assert.equal(isArchivedTask(recovered),true);assert.equal(recovered.archivedAt,archived.archivedAt);assert.equal(recovered.lifecycleRequests.filter(r=>r.id===request.actionId).length,1);
 assert.equal(recovered.history.filter(event=>event.id==='assignment').length,1);
 await assert.rejects(requestWorkerAction(f.stateDir,{...request,actionId:'no-archived-resume',action:'resume'}),/archived/);
 await manageArchivedTask(f.stateDir,{taskId:first.id,action:'restore',operationId:'real-history-restore',expectedRevision:recovered.revision},f.project);
 await f.restart();await f.controller.tick();
 const restored=await readTask(f.stateDir,first.id);assert.equal(restored.status,'blocked');assert.equal(restored.archiveRestoration.requiresRecovery,true);assert.equal(restored.runId,first.runId);
 for(const action of ['start','resume']){
   await f.action(first.id,action);const refused=await wait(async()=>{const n=await readTask(f.stateDir,first.id);return n.lifecycleRequests.at(-1).status==='failed'?n:null;},'history restore refuses '+action);
   assert.equal(refused.status,'blocked');assert.equal(refused.runId,first.runId);assert.match(refused.lifecycleRequests.at(-1).error,/history-only|working directory.*unavailable|reconstruction is not currently supported/);
 }
 // A newly present path must not be hidden or cleaned by record-only rearchive.
 await mkdir(first.worktree);await writeFile(path.join(first.worktree,'preserve.txt'),'new resource');await f.action(first.id,'archive');
 const pathBlocked=await wait(async()=>{const n=await readTask(f.stateDir,first.id);return n.lifecycleRequests.at(-1).status==='failed'?n:null;},'existing restored path blocks rearchive');assert.equal(pathBlocked.status,'blocked');assert.equal(await readFile(path.join(first.worktree,'preserve.txt'),'utf8'),'new resource');await rm(first.worktree,{recursive:true});
 await exec('git',['-C',f.repo,'worktree','add','--detach',first.worktree,first.baseCommit]);await rm(first.worktree,{recursive:true});await f.action(first.id,'archive');const registrationBlocked=await wait(async()=>{const n=await readTask(f.stateDir,first.id);return n.lifecycleRequests.at(-1).status==='failed'?n:null;},'registered missing worktree blocks rearchive');assert.match(registrationBlocked.lifecycleRequests.at(-1).error,/registered/);await exec('git',['-C',f.repo,'worktree','remove','--force',first.worktree]);
 await f.action(first.id,'archive');const rearchived=await wait(async()=>{const n=await readTask(f.stateDir,first.id);return isArchivedTask(n)?n:null;},'record-only rearchive');assert.ok(rearchived.archiveRestoration.rearchivedAt);assert.equal(rearchived.disposedAt,archived.disposedAt);assert.ok(rearchived.history.some(event=>/No environment cleanup was run/.test(event.message)));
 assert.equal((await readFile(path.join(f.stateDir,'launches.jsonl'),'utf8')).trim().split('\n').length,1,'restore/start refusal/rearchive never launches a second worker');
});

test('history-only records keep unavailable execution honest and never reconstruct missing resources',async t=>{
 const f=await fixture(t);await f.controller.stop();
 await createTask(f.stateDir,{requestId:'restored-history',ticket:'AI-045',brief:'Historical task requiring recovery',projectId:f.project.id,repositoryId:'fixture-repo'});
 await updateTask(f.stateDir,'restored-history',task=>{task.status='stopped';task.archiveRestoration={requiresRecovery:true};});await f.restart();
 for(const action of ['start','resume','retry_setup']){await f.action('restored-history',action);const task=await wait(async()=>{const n=await readTask(f.stateDir,'restored-history');return n.lifecycleRequests.at(-1)?.status==='failed'?n:null;},'history-only '+action+' refused');assert.match(task.lifecycleRequests.at(-1).error,action==='retry_setup'?/Setup is agent-initiated/:/history.only|working directory.*unavailable/);assert.equal(task.runId||null,null);assert.ok(!task.worktree);}
 await updateTask(f.stateDir,'restored-history',task=>{task.status='queued';});await f.controller.tick();const blocked=await wait(async()=>{const n=await readTask(f.stateDir,'restored-history');return n.status==='failed'?n:null;},'history-only queued dispatch refused');assert.match(blocked.failure,/history.only|working directory.*unavailable/);assert.equal(blocked.runId||null,null);assert.ok(!blocked.worktree);await assert.rejects(readFile(path.join(f.stateDir,'launches.jsonl')),{code:'ENOENT'});
});
