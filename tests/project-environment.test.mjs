import {workerAppServerFixture} from './helpers/worker-app-server-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,realpath,rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {prepareProjectEnvironment,stopProjectEnvironment,disposeProjectEnvironment,inspectProjectEnvironment,executionPlanHash,reviewProjectRecovery,applyProjectRecovery} from '../runtime/project-environment.mjs';
const exec=promisify(execFile);
async function fixture(t,{ready=true,teardown=true,failSetup=false,gracefulStop=false}={}){
 const dir=await mkdtemp(path.join(tmpdir(),'crew-project-runtime-')),repo=path.join(dir,'repo'),stateDir=path.join(dir,'state'),worktree=path.join(stateDir,'worktrees','worker-unique');await mkdir(repo);await mkdir(path.dirname(worktree),{recursive:true});await mkdir(path.join(stateDir,'runs','project-test'),{recursive:true});
 const script=`import fs from 'node:fs';const phase=process.argv[2],file='.test-data/state.json';fs.mkdirSync('.test-data',{recursive:true});const data=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):{};const save=()=>fs.writeFileSync(file,JSON.stringify(data));if(phase==='setup'){data.seeds=(data.seeds||0)+1;save();${failSetup?'process.exit(7);':''}}else if(phase==='start'){data.starts=(data.starts||0)+1;data.pid=process.pid;data.resources=true;data.stopRequested=false;save();${gracefulStop?"process.on('SIGTERM',()=>{data.forced=true;save();process.exit(0);});setInterval(()=>{if(JSON.parse(fs.readFileSync(file)).stopRequested)process.exit(0);},100);":'setInterval(()=>{},1000);'}}else if(phase==='ready'){process.kill(data.pid,0);if(data.seeds!==1)process.exit(5);}else if(phase==='stop'){data.resources=false;${gracefulStop?'data.stopRequested=true;':''}save();}else if(phase==='teardown'){data.disposed=true;save();}`;
 await writeFile(path.join(repo,'action.mjs'),script);await writeFile(path.join(repo,'.gitignore'),'.test-data/\n');await writeFile(path.join(repo,'AGENTS.md'),'Fixture project instructions.\n');await exec('git',['init','-q','-b','main',repo]);await exec('git',['-C',repo,'add','.']);await exec('git',['-C',repo,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Generic project scripts']);const {stdout}=await exec('git',['-C',repo,'rev-parse','HEAD']);await exec('git',['-C',repo,'worktree','add','--detach',worktree,stdout.trim()]);
 const source={path:'action.mjs',sha256:createHash('sha256').update(script).digest('hex')},action=phase=>({command:`${JSON.stringify(process.execPath)} action.mjs ${phase}`,source,timeoutMs:10000});
 const plan={schemaVersion:1,sources:[source],setup:action('setup'),start:action('start'),resume:null,ready:ready?action('ready'):null,stop:action('stop'),teardown:teardown?action('teardown'):null};
 const args={stateDir,taskId:'project-test',worktree:await realpath(worktree),repositoryPath:await realpath(repo),baseCommit:stdout.trim(),plan};
 t.after(async()=>{await stopProjectEnvironment(args).catch(()=>{});await rm(dir,{recursive:true,force:true});});return{args,dir,read:async()=>JSON.parse(await readFile(path.join(worktree,'.test-data/state.json'),'utf8'))};
}
test('declared scripts prepare once, retain identity/data through stop and resume, then scoped teardown',async t=>{
 const f=await fixture(t),first=await prepareProjectEnvironment(f.args);assert.equal(first.status,'ready');assert.equal(first.readinessKind,'app-verified');assert.equal((await f.read()).seeds,1);
 const adopted=await prepareProjectEnvironment({...f.args,resume:true});assert.equal(adopted.runtime.id,first.runtime.id);assert.equal((await f.read()).starts,1);
 await stopProjectEnvironment(f.args);assert.equal((await f.read()).resources,false);
 const resumed=await prepareProjectEnvironment({...f.args,resume:true});assert.equal(resumed.id,first.id);assert.notEqual(resumed.runtime.id,first.runtime.id);assert.equal((await f.read()).seeds,1);assert.equal((await f.read()).starts,2);
 await stopProjectEnvironment(f.args);await disposeProjectEnvironment(f.args);assert.equal((await f.read()).disposed,true);
});
test('missing readiness is reported honestly and missing teardown preserves resources',async t=>{
 const f=await fixture(t,{ready:false,teardown:false});const value=await prepareProjectEnvironment(f.args);assert.equal(value.status,'running');assert.equal(value.readinessKind,'setup-complete');assert.equal((await inspectProjectEnvironment(f.args)).runtime.status,'running');await stopProjectEnvironment(f.args);await assert.rejects(disposeProjectEnvironment(f.args),/no declared teardown/);assert.equal((await f.read()).disposed,undefined);
});
test('failed setup cannot be silently rerun or reseed retained data',async t=>{
 const f=await fixture(t,{failSetup:true});await assert.rejects(prepareProjectEnvironment(f.args),/setup environment hook failed/);assert.equal((await f.read()).seeds,1);await assert.rejects(prepareProjectEnvironment(f.args),/will not be reseeded/);assert.equal((await f.read()).seeds,1);
});
test('changed source evidence fails before project script execution',async t=>{
 const f=await fixture(t);await writeFile(path.join(f.args.worktree,'action.mjs'),'throw new Error("must not run")');await assert.rejects(prepareProjectEnvironment(f.args),/sources changed/);await assert.rejects(f.read(),{code:'ENOENT'});
});
test('setup-only project runs no invented Start command, resumes without repeating setup',async t=>{
 const f=await fixture(t);f.args.plan.start=null;f.args.plan.ready=null;
 const first=await prepareProjectEnvironment(f.args);assert.equal(first.status,'ready');assert.equal(first.readinessKind,'setup-complete');assert.equal(first.runtime,undefined);assert.equal((await f.read()).seeds,1);
 const again=await prepareProjectEnvironment({...f.args,resume:true});assert.equal(again.id,first.id);assert.equal((await f.read()).seeds,1);await stopProjectEnvironment(f.args);await disposeProjectEnvironment(f.args);assert.equal((await f.read()).disposed,true);
});
test('setup-only work without declared teardown preserves any setup-created resources',async t=>{
 const f=await fixture(t,{ready:false,teardown:false});f.args.plan.start=null;await prepareProjectEnvironment(f.args);await stopProjectEnvironment(f.args);await assert.rejects(disposeProjectEnvironment(f.args),/no declared teardown/);assert.equal((await f.read()).seeds,1);
});
test('worker app-server preserves normal Codex network and sandbox configuration',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'crew-network-plan-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const binary=path.join(dir,'fake-codex');await writeFile(binary,workerAppServerFixture(`#!${process.execPath}\nimport fs from 'node:fs';fs.writeFileSync('captured-args.json',JSON.stringify(process.argv.slice(2)));console.log(JSON.stringify({type:'thread.started',thread_id:'network-test'}));console.log(JSON.stringify({type:'turn.completed'}));`),{mode:0o700});
 for(const networkAccess of [undefined,false,true]){const worktree=path.join(dir,String(networkAccess)),runDir=path.join(worktree,'run');await mkdir(runDir,{recursive:true});const config={taskId:'network-test',runId:String(networkAccess),ticket:'AI-012',brief:'Local network opt-in check',stateDir:dir,worktree,executable:binary,mcpScript:path.resolve('runtime/orchestration-mcp.mjs'),workerPrompt:'Read-only disposable fixture.',sandbox:'read-only',timeoutMs:10000,environment:{kind:'project-execution',status:'ready',plan:{networkAccess}},project:{mode:'repository'}};const configPath=path.join(runDir,'config.json');await writeFile(configPath,JSON.stringify(config));await exec(process.execPath,[path.resolve('runtime/worker-runner.mjs'),configPath],{timeout:15000});const args=JSON.parse(await readFile(path.join(worktree,'captured-args.json'),'utf8'));assert.ok(args.includes('app-server'));assert.ok(!args.includes('--ignore-user-config'));assert.ok(!args.some(arg=>/^(?:permissions\.crew_project(?:\.|=)|sandbox_mode=|approval_policy=)/.test(arg)));}
});
test('local project permission evidence is verified without copying the ignored file',async t=>{
 const f=await fixture(t);const folder=path.join(f.args.repositoryPath,'.codex');await mkdir(folder);const file=path.join(folder,'config.toml'),content='sandbox_mode = "workspace-write"\n';await writeFile(file,content);f.args.plan.permissionsSource={path:file,sha256:createHash('sha256').update(content).digest('hex')};f.args.plan.start=null;f.args.plan.ready=null;
 await prepareProjectEnvironment(f.args);await assert.rejects(readFile(path.join(f.args.worktree,'.codex/config.toml')),{code:'ENOENT'});await writeFile(file,'# changed permission policy\n');await assert.rejects(prepareProjectEnvironment(f.args),/permissions changed/);assert.equal((await f.read()).seeds,1);
});
test('editing instruction provenance does not block retained runtime resume',async t=>{
 const f=await fixture(t);f.args.plan.sources.push({path:'AGENTS.md',sha256:createHash('sha256').update('Fixture project instructions.\n').digest('hex')});await prepareProjectEnvironment(f.args);await stopProjectEnvironment(f.args);await writeFile(path.join(f.args.worktree,'AGENTS.md'),'Updated project guidance for this task.\n');const resumed=await prepareProjectEnvironment({...f.args,resume:true});assert.equal(resumed.status,'ready');assert.equal((await f.read()).seeds,1);
});
test('controller runs independent generic plans with globally unique worktree names and retains runtime across restart',async t=>{
 const {createController}=await import('../runtime/controller.mjs');const {createTask,readTask,requestWorkerAction}=await import('../runtime/orchestration-store.mjs');const {pathToFileURL}=await import('node:url');const f=await fixture(t);const sourceDir=path.resolve('runtime'),binary=path.join(f.dir,'fake-project-worker');
 await writeFile(binary,workerAppServerFixture(`#!${process.execPath}\nimport{readFile}from'node:fs/promises';import{reportTask}from ${JSON.stringify(pathToFileURL(path.join(sourceDir,'orchestration-store.mjs')).href)};const args=process.argv.slice(2),m=JSON.parse(args.find(v=>v.startsWith('mcp_servers.local_orchestration.args=')).slice('mcp_servers.local_orchestration.args='.length));const[,state,,id,runId]=m,task=JSON.parse(await readFile(state+'/tasks/'+id+'.json','utf8'));if(task.environment.status!=='ready'||task.environment.readinessKind!=='app-verified')process.exit(9);console.log(JSON.stringify({type:'thread.started',thread_id:args.includes('resume')?args[args.indexOf('resume')+1]:'generic-worker-'+Math.random().toString(36).slice(2)}));await reportTask(state,id,runId,{reportId:'progress',kind:'progress',message:'Declared setup and readiness succeeded.'});setInterval(()=>{},1000);`),{mode:0o700});
 const project={id:'generic',name:'Generic fixture project',mode:'repository',readiness:{ready:true},repositories:[{id:'repo',path:f.args.repositoryPath,baseRef:'main'}],worker:{sandbox:'read-only',timeoutMs:60000,maxConcurrent:2,environment:{executionPlan:f.args.plan}}};
 const states=[path.join(f.dir,'controller-a'),path.join(f.dir,'controller-b')],controllers=[];const taskId='same-task-request';
 const wait=async fn=>{const until=Date.now()+30000;while(Date.now()<until){const value=await fn();if(value)return value;await new Promise(r=>setTimeout(r,100));}throw new Error('Timed out waiting for generic runtime controller.');};
 const action=async(index,name)=>{await requestWorkerAction(states[index],{taskId,actionId:`${name}-request-${Date.now()}`,action:name});await controllers[index].tick();};
 try{
  for(const stateDir of states){const c=await createController({stateDir,sourceDir,executable:binary,project});controllers.push(c);await createTask(stateDir,{requestId:taskId,ticket:'AI-012',brief:'Inspect this disposable local project after its declared readiness.',projectId:project.id,repositoryId:'repo'});await c.tick();}
  const tasks=await Promise.all(states.map(state=>wait(async()=>{const task=await readTask(state,taskId);if(task.status==='failed')throw new Error(task.failure);return task.threadId?task:null;})));
  assert.notEqual(path.basename(tasks[0].worktree),path.basename(tasks[1].worktree));assert.notEqual(tasks[0].environment.id,tasks[1].environment.id);
  await controllers[0].stop();controllers[0]=await createController({stateDir:states[0],sourceDir,executable:binary,project});await new Promise(r=>setTimeout(r,300));const adopted=await readTask(states[0],taskId);assert.equal(adopted.environment.runtime.id,tasks[0].environment.runtime.id);assert.equal(adopted.runId,tasks[0].runId);
  await action(0,'stop');await wait(async()=>{const task=await readTask(states[0],taskId);return task.status==='stopped'&&task.environment.status==='stopped';});assert.equal((await readTask(states[1],taskId)).status,'running');
  await action(0,'resume');const resumed=await wait(async()=>{const task=await readTask(states[0],taskId);return task.runId!==tasks[0].runId&&task.threadId&&task.execution?.live&&task.environment.runtime.id!==tasks[0].environment.runtime.id&&task.reports.some(r=>r.runId===task.runId&&r.kind==='progress')?task:null;});assert.equal(resumed.threadId,tasks[0].threadId);assert.equal(resumed.worktree,tasks[0].worktree);assert.equal(JSON.parse(await readFile(path.join(resumed.worktree,'.test-data/state.json'),'utf8')).seeds,1);
 }finally{for(let i=0;i<controllers.length;i++){const task=await readTask(states[i],taskId).catch(()=>null);if(task&&!['stopped','disposed'].includes(task.status)){await action(i,'stop');await wait(async()=>['stopped','failed'].includes((await readTask(states[i],taskId)).status));}await controllers[i].stop();}}
});


test('plan identity ignores deep object-key ordering but preserves array order and actual action values',()=>{
 const value={schemaVersion:1,env:{PATH:'/test/bin'},sources:[{path:'first',sha256:'a'},{path:'second',sha256:'b'}],start:{command:'start exactly',source:{path:'first',sha256:'a'},timeoutMs:1000}},reorder=value=>Array.isArray(value)?value.map(reorder):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).reverse().map(([k,v])=>[k,reorder(v)])):value;
 assert.equal(executionPlanHash(value),executionPlanHash(reorder(value)));assert.notEqual(executionPlanHash(value),executionPlanHash({...value,sources:[...value.sources].reverse()}));assert.notEqual(executionPlanHash(value),executionPlanHash({...value,start:{...value.start,timeoutMs:1001}}));assert.notEqual(executionPlanHash(value),executionPlanHash({...value,start:{...value.start,command:'different'}}));
});
test('legacy ordered plan hash migrates on a reordered equivalent stop/resume without reseeding',async t=>{
 const f=await fixture(t),first=await prepareProjectEnvironment(f.args);await stopProjectEnvironment(f.args);const file=path.join(f.args.stateDir,'runs',f.args.taskId,'environment.json'),saved=JSON.parse(await readFile(file,'utf8'));saved.planHash=createHash('sha256').update(JSON.stringify(saved.plan)).digest('hex');await writeFile(file,JSON.stringify(saved));
 const reorder=value=>Array.isArray(value)?value.map(reorder):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).reverse().map(([k,v])=>[k,reorder(v)])):value,reordered=reorder(f.args.plan),resumed=await prepareProjectEnvironment({...f.args,plan:reordered,resume:true});assert.equal(resumed.id,first.id);assert.equal(resumed.worktree,first.worktree);assert.equal(resumed.planHash,executionPlanHash(reordered));assert.equal((await f.read()).seeds,1);assert.equal((await f.read()).starts,2);
 await assert.rejects(prepareProjectEnvironment({...f.args,plan:{...reordered,start:{...reordered.start,timeoutMs:reordered.start.timeoutMs+1}},resume:true}),/execution plan changed/);assert.equal((await f.read()).seeds,1);assert.equal((await f.read()).starts,2);
});


test('cooperative project pause executes its declared stop without signals and resumes retained data once',async t=>{
 const f=await fixture(t,{gracefulStop:true}),first=await prepareProjectEnvironment(f.args);
 const stopped=await stopProjectEnvironment({...f.args,cooperative:true});assert.equal(stopped.status,'stopped');assert.equal((await f.read()).forced,undefined);
 const terminal=JSON.parse(await readFile(path.join(first.runtime.runDir,'exit.json'),'utf8'));assert.equal(terminal.stopConfirmed,true);assert.equal(terminal.requestedStop,true);
 const stopHook=stopped.hooks.find(h=>h.phase==='stop');assert.equal(stopHook.status,'succeeded');assert.equal(JSON.parse(await readFile(path.join(stopHook.runDir,'config.json'),'utf8')).cooperative,true);
 const resumed=await prepareProjectEnvironment({...f.args,resume:true});assert.equal(resumed.id,first.id);assert.equal((await f.read()).seeds,1);assert.equal((await f.read()).starts,2);assert.notEqual(resumed.runtime.id,first.runtime.id);
 await stopProjectEnvironment({...f.args,cooperative:true});
});

test('missing graceful project stop leaves its owned runtime alive rather than force-killing for update',async t=>{
 const f=await fixture(t);f.args.plan.stop=null;const first=await prepareProjectEnvironment(f.args);const pid=(await f.read()).pid;
 await assert.rejects(stopProjectEnvironment({...f.args,cooperative:true}),/no declared graceful stop action/);assert.doesNotThrow(()=>process.kill(pid,0));
 assert.equal((await inspectProjectEnvironment(f.args)).runtime.id,first.runtime.id);assert.equal((await inspectProjectEnvironment(f.args)).runtime.status,'running');
});


test('completed work retains its result while update pause gracefully stops its live project runtime',async t=>{
 const {createController}=await import('../runtime/controller.mjs');const {createTask,updateTask,readTask,requestWorkerAction}=await import('../runtime/orchestration-store.mjs');const {randomUUID}=await import('node:crypto');
 const f=await fixture(t,{gracefulStop:true}),environment=await prepareProjectEnvironment(f.args),runId=randomUUID(),runDir=path.join(f.args.stateDir,'runs',f.args.taskId,runId);await mkdir(runDir);
 await createTask(f.args.stateDir,{requestId:f.args.taskId,ticket:'AI-018',brief:'Already completed local fixture',projectId:'completed-project',repositoryId:'repo'});
 await writeFile(path.join(runDir,'exit.json'),JSON.stringify({runId,stopConfirmed:true,exitCode:0,completedTurn:true,threadId:'completed-chat'}));
 await updateTask(f.args.stateDir,f.args.taskId,n=>{n.status='completed';n.runId=runId;n.runDir=runDir;n.harnessStarted=true;n.worktree=f.args.worktree;n.environment=environment;n.threadId='completed-chat';n.result={message:'Previously verified work',verification:{clean:true}};});
 await requestWorkerAction(f.args.stateDir,{taskId:f.args.taskId,actionId:'pause-completed-runtime',action:'pause',cooperative:true,expectedRunId:runId});
 const controller=await createController({stateDir:f.args.stateDir,sourceDir:path.resolve('runtime'),executable:process.execPath,project:{id:'completed-project',mode:'repository',worker:{maxConcurrent:1}},admissionHeld:async()=>true});
 try{const until=Date.now()+10000;let task;for(;;){task=await readTask(f.args.stateDir,f.args.taskId);if(task.lifecycleRequests.at(-1).status==='completed')break;if(Date.now()>until)throw new Error('Completed runtime did not stop');await new Promise(r=>setTimeout(r,50));await controller.tick();}assert.equal(task.status,'completed');assert.equal(task.result.message,'Previously verified work');assert.equal(task.environment.runtime.status,'stopped');assert.equal((await f.read()).forced,undefined);assert.equal(task.threadId,'completed-chat');assert.equal(task.runId,runId);}
 finally{await controller.stop();}
});

async function retainedRecovery(t, options={}) {
 const f=await fixture(t,{teardown:false,...options});
 if(options.instructionSource)f.args.plan.sources.push({path:'AGENTS.md',sha256:createHash('sha256').update('Fixture project instructions.\n').digest('hex')});
 const original=structuredClone(f.args.plan);
 await prepareProjectEnvironment(f.args).catch(error=>{if(!options.failSetup)throw error;});
 await stopProjectEnvironment(f.args);
 const task={id:f.args.taskId,projectId:'recovery-project',repositoryId:'repo',status:'failed',worktree:f.args.worktree,worktreeName:path.basename(f.args.worktree),repositoryPath:f.args.repositoryPath,baseCommit:f.args.baseCommit,runId:null,harnessStarted:false};
 const current={...original,teardown:{...original.stop,command:original.stop.command.replace(' stop',' teardown')}};
 const project={id:task.projectId,mode:'repository',repositories:[{id:'repo',path:task.repositoryPath,baseRef:'main'}],worker:{sandbox:'read-only',maxConcurrent:1,environment:{executionPlan:current}}};
 const recovery={stateDir:f.args.stateDir,task,project,mode:'reconcile_plan'};
 const review=()=>reviewProjectRecovery(recovery);
 const apply=async(actionId='recover-plan-one')=>{const viewed=await review();assert.deepEqual(viewed.blockers,[]);return applyProjectRecovery({...recovery,request:{id:actionId,reviewHash:viewed.reviewHash,decision:'Use the reviewed teardown for this worker only.'}});};
 return {...f,task,project,recovery,review,apply,original,current};
}

test('reviewed teardown adoption preserves original plan, data and dirty work; teardown executes only on safe disposal',async t=>{
 const f=await retainedRecovery(t);
 await writeFile(path.join(f.task.worktree,'keep.txt'),'Retained user work');
 const reviewed=await f.review();assert.equal(reviewed.allowed,true);assert.deepEqual(reviewed.differences.map(d=>d.field),['teardown']);
 const applied=await f.apply();assert.equal(applied.plan.teardown.command,f.current.teardown.command);assert.deepEqual(applied.recoveryHistory[0].previousPlan,f.original);
 assert.equal((await f.read()).seeds,1);assert.equal((await f.read()).disposed,undefined);assert.equal(await readFile(path.join(f.task.worktree,'keep.txt'),'utf8'),'Retained user work');
 const replay=await applyProjectRecovery({...f.recovery,request:{id:'recover-plan-one',reviewHash:reviewed.reviewHash,decision:'Use the reviewed teardown for this worker only.'}});assert.equal(replay.recoveryHistory.length,1);
 await rm(path.join(f.task.worktree,'keep.txt'));
 await disposeProjectEnvironment(f.args);assert.equal((await f.read()).disposed,true);
});

test('compatible lifecycle recovery resumes retained environment without repeating setup',async t=>{
 const f=await retainedRecovery(t);f.current.resume={...f.current.start};f.current.ready={...f.current.ready,timeoutMs:11000};
 const before=await inspectProjectEnvironment(f.args);await f.apply();
 const resumed=await prepareProjectEnvironment({...f.args,plan:f.current,resume:true});assert.equal(resumed.id,before.id);assert.equal(resumed.worktree,before.worktree);assert.equal((await f.read()).seeds,1);assert.equal((await f.read()).starts,2);
});

test('recovery rejects incompatible metadata, changed sources, stale reviews and unknown foreground ownership',async t=>{
 const f=await retainedRecovery(t),base=structuredClone(f.current),reviewed=await f.review();
 for(const patch of [{setup:null},{start:null},{env:{PATH:'/different'}},{networkAccess:true},{permissionsSource:{path:'/unknown',sha256:'a'.repeat(64)}},{unknownSetting:true}]){
  f.project.worker.environment.executionPlan={...base,...patch};const review=await f.review();assert.equal(review.allowed,false);assert.match(review.blockers.join(' '),/Incompatible plan changes/);
 }
 f.project.worker.environment.executionPlan={...base,ready:{...base.ready,timeoutMs:12000}};
 await assert.rejects(applyProjectRecovery({...f.recovery,request:{id:'stale-recovery',reviewHash:reviewed.reviewHash,decision:'Reviewed prior plan'}}),/review is stale/);
 f.project.worker.environment.executionPlan=base;
 await writeFile(path.join(f.task.worktree,'action.mjs'),'// changed executable source');assert.match((await f.review()).blockers.join(' '),/sources changed/);
 await writeFile(path.join(f.task.worktree,'action.mjs'),(await exec('git',['-C',f.task.worktree,'show',`${f.task.baseCommit}:action.mjs`])).stdout);
 const file=path.join(f.args.stateDir,'runs',f.task.id,'environment.json'),env=JSON.parse(await readFile(file,'utf8'));env.runtime.id='unresolved-runtime';env.runtime.runDir=path.join(f.args.stateDir,'runs',f.task.id,'project-runtime',env.runtime.id);await writeFile(file,JSON.stringify(env));
 assert.match((await f.review()).blockers.join(' '),/Foreground project runtime/);
});

test('failed setup permits adding teardown but never replays incomplete provisioning',async t=>{
 const f=await retainedRecovery(t,{failSetup:true});await f.apply();await assert.rejects(prepareProjectEnvironment({...f.args,plan:f.current,resume:true}),/will not be reseeded/);assert.equal((await f.read()).seeds,1);await disposeProjectEnvironment(f.args);assert.equal((await f.read()).disposed,true);
});

test('missing recovery requires absence and no registration, rejects foreign paths and dangling links',async t=>{
 const {symlink}=await import('node:fs/promises');const f=await retainedRecovery(t);f.recovery.mode='retire_missing';
 assert.match((await f.review()).blockers.join(' '),/path still exists/);
 await rm(f.task.worktree,{recursive:true});assert.match((await f.review()).blockers.join(' '),/still registered/);
 await exec('git',['-C',f.task.repositoryPath,'worktree','prune']);assert.equal((await f.review()).allowed,true);
 await symlink(path.join(f.dir,'absent'),f.task.worktree);assert.match((await f.review()).blockers.join(' '),/path still exists/);await rm(f.task.worktree);
 f.task.worktree=path.join(f.dir,'foreign-absent');assert.match((await f.review()).blockers.join(' '),/does not belong|owned workspace/);
});

test('controller processes exact reviewed recovery, preserves unrelated workers, refuses dirty disposal and retires missing history honestly',async t=>{
 let controller;t.after(()=>controller?.stop());
 const {createController}=await import('../runtime/controller.mjs');const {createTask,updateTask,readTask,requestWorkerRecovery,requestWorkerAction}=await import('../runtime/orchestration-store.mjs');
 const f=await retainedRecovery(t);
 await createTask(f.args.stateDir,{requestId:f.task.id,ticket:'GH-24',brief:'Retained recovery fixture',projectId:f.task.projectId,repositoryId:f.task.repositoryId});
 await updateTask(f.args.stateDir,f.task.id,n=>Object.assign(n,f.task));
 await createTask(f.args.stateDir,{requestId:'unrelated-worker',ticket:'GH-24',brief:'Untouched worker',projectId:f.task.projectId,repositoryId:f.task.repositoryId});await updateTask(f.args.stateDir,'unrelated-worker',n=>{n.status='paused';});
 const other=await readFile(path.join(f.args.stateDir,'tasks','unrelated-worker.json'),'utf8');
 controller=await createController({stateDir:f.args.stateDir,sourceDir:path.resolve('runtime'),executable:process.execPath,project:f.project});
 const wait=async id=>{const until=Date.now()+15000;for(;;){await controller.tick();const task=await readTask(f.args.stateDir,f.task.id),request=task.lifecycleRequests.find(r=>r.id===id);if(['completed','failed'].includes(request?.status))return{task,request};if(Date.now()>until)throw Error('Recovery did not complete');await new Promise(r=>setTimeout(r,25));}};
 const runtimeFile=path.join(f.dir,'manager-runtime.json');await writeFile(runtimeFile,JSON.stringify({project:f.project}));
 const managerTool=async(name,args)=>{const {spawn}=await import('node:child_process');const child=spawn(process.execPath,[path.resolve('runtime/orchestration-mcp.mjs'),f.args.stateDir,'manager',runtimeFile]);let output='',errors='';child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>errors+=data);child.stdin.end(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})+'\n');const code=await new Promise(resolve=>child.once('close',resolve));assert.equal(code,0,errors);const result=JSON.parse(output.trim()).result;assert.equal(result.isError,undefined,result.content[0].text);return JSON.parse(result.content[0].text);};
 const viewed=await managerTool('review_worker_recovery',{taskId:f.task.id,action:'reconcile_plan'}),request={taskId:f.task.id,actionId:'controller-recovery',action:'reconcile_plan',expectedRunId:null,reviewHash:viewed.reviewHash,decision:'Adopt only the reviewed teardown for this environment.'};
 await controller.stop();
 await managerTool('request_worker_recovery',request);
 // Simulate a crash after durable environment adoption but before task completion.
 await updateTask(f.args.stateDir,f.task.id,n=>{n.lifecycleRequests[0].status='processing';});
 await applyProjectRecovery({...f.recovery,task:await readTask(f.args.stateDir,f.task.id),request:{...request,id:request.actionId}});
 controller=await createController({stateDir:f.args.stateDir,sourceDir:path.resolve('runtime'),executable:process.execPath,project:f.project});
 assert.equal((await wait(request.actionId)).request.status,'completed');
 assert.equal((await readTask(f.args.stateDir,f.task.id)).environment.recoveryHistory.length,1);
 assert.equal((await f.read()).seeds,1);
 await requestWorkerRecovery(f.args.stateDir,request);await assert.rejects(requestWorkerRecovery(f.args.stateDir,{...request,decision:'Changed decision'}),/changed content/);
 await writeFile(path.join(f.task.worktree,'dirty.txt'),'Keep this work');await requestWorkerAction(f.args.stateDir,{taskId:f.task.id,actionId:'dirty-disposal',action:'dispose',expectedRunId:null});assert.match((await wait('dirty-disposal')).request.error,/contains changes/);assert.equal((await f.read()).disposed,undefined);
 await rm(path.join(f.task.worktree,'dirty.txt'));await exec('git',['-C',f.task.repositoryPath,'worktree','remove',f.task.worktree]);
 const currentTask=await readTask(f.args.stateDir,f.task.id);const missing=await reviewProjectRecovery({...f.recovery,task:currentTask,mode:'retire_missing'});assert.equal(missing.allowed,true);
 await requestWorkerRecovery(f.args.stateDir,{taskId:f.task.id,actionId:'retire-missing-one',action:'retire_missing',expectedRunId:null,reviewHash:missing.reviewHash,decision:'Retire this missing record; resource cleanup remains unverified.'});const retired=await wait('retire-missing-one');assert.equal(retired.request.status,'completed');assert.equal(retired.task.status,'disposed');assert.equal(retired.task.retirement.cleanupVerified,false);assert.ok(retired.task.history.some(h=>h.kind==='recovery'&&h.message.includes('not independently verified')));
 assert.equal(await readFile(path.join(f.args.stateDir,'tasks','unrelated-worker.json'),'utf8'),other);
});

test('recovery rejects a worktree repointed to another registered worktree at the same baseline',async t=>{
 const {symlink}=await import('node:fs/promises');const f=await retainedRecovery(t);
 await exec('git',['-C',f.task.repositoryPath,'worktree','remove',f.task.worktree]);
 const other=path.join(f.args.stateDir,'worktrees','other-worker');await exec('git',['-C',f.task.repositoryPath,'worktree','add','--detach',other,f.task.baseCommit]);
 await symlink(other,f.task.worktree);const reviewed=await f.review();assert.equal(reviewed.allowed,false);assert.match(reviewed.blockers.join(' '),/canonical directory/);assert.equal((await exec('git',['-C',other,'rev-parse','HEAD'])).stdout.trim(),f.task.baseCommit);
});

test('reviewed lifecycle adoption retains edited non-executable instruction files',async t=>{
 const f=await retainedRecovery(t,{instructionSource:true});await writeFile(path.join(f.task.worktree,'AGENTS.md'),'Retained worker guidance edits.\n');
 assert.equal((await f.review()).allowed,true);await f.apply();assert.equal(await readFile(path.join(f.task.worktree,'AGENTS.md'),'utf8'),'Retained worker guidance edits.\n');
});
