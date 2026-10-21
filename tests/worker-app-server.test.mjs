import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import os from 'node:os';
import {createController} from '../controller.mjs';
import {createTask,readTask,updateTask,requestWorkerAction,requestWorkerFollowup} from '../orchestration-store.mjs';
import {listWorkerRequests,decideWorkerRequest} from '../worker-approvals.mjs';
import {snapshotProcesses} from '../process-ownership.mjs';
const exec=promisify(execFile),sourceDir=path.resolve('.');
async function wait(observe,predicate,ms=30000){const end=Date.now()+ms;let value;while(Date.now()<end){value=await observe();if(predicate(value))return value;await new Promise(r=>setTimeout(r,40));}throw new Error('Native worker outcome timed out: '+JSON.stringify(value));}
async function fixture(t){
 const dir=await mkdtemp(path.join(os.tmpdir(),'crew-native-worker-')),repo=path.join(dir,'repo'),state=path.join(dir,'state'),binary=path.join(dir,'native.mjs');await mkdir(repo);await exec('git',['init','-b','main',repo]);await writeFile(path.join(repo,'README.md'),'Read-only native protocol acceptance\n');await exec('git',['-C',repo,'add','.']);await exec('git',['-C',repo,'-c','user.name=Fixture','-c','user.email=fixture@localhost.invalid','commit','-m','Fixture']);
 const serviceProgram="process.on('SIGTERM',()=>{require('node:fs').appendFileSync(process.argv[1],'SIGTERM\\n');process.exit(0)});require('node:fs').writeFileSync(process.argv[1]+'.ready','ready');setInterval(()=>{},1000)";
 await writeFile(binary,`#!${process.execPath}
import{createInterface}from'node:readline';import{appendFileSync,writeFileSync}from'node:fs';import{execFileSync,spawn}from'node:child_process';import{reportTask}from${JSON.stringify(new URL('../orchestration-store.mjs',import.meta.url).href)};
const raw=process.argv.find(x=>x.startsWith('mcp_servers.local_orchestration.args='));const[,state,,task,run]=JSON.parse(raw.slice(raw.indexOf('=')+1));
const threadId='native-'+task,turnId='turn-'+run,send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
process.on('unhandledRejection',error=>{appendFileSync(state+'/'+task+'-fixture-error.txt',String(error.stack));process.exit(1);});const lines=createInterface({input:process.stdin});lines.on('close',()=>process.exit(0));
lines.on('line',async line=>{const m=JSON.parse(line);if(m.method)appendFileSync(state+'/'+task+'-calls.jsonl',JSON.stringify(m)+'\\n');if(!m.method){appendFileSync(state+'/'+task+'-decisions.jsonl',JSON.stringify(m)+'\\n');send({method:'serverRequest/resolved',params:{threadId,requestId:m.id}});if(m.result.decision==='cancel'){send({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'interrupted',items:[]}}});return;}const output=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'});send({method:'item/completed',params:{threadId,turnId,item:{type:'commandExecution',command:'git rev-parse HEAD',exitCode:0,aggregatedOutput:output}}});await reportTask(state,task,run,{reportId:'native-result',kind:'result',message:'Native decision '+m.result.decision+' reached the same worker.',evidence:['Correlated native round trip; actual read-only Git command succeeded.']});send({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed',items:[]}}});return;}
let result={};if(m.method==='account/read')result={account:{type:'chatgpt'}};if(m.method==='config/read')result={config:{sandbox_mode:'workspace-write',approval_policy:'on-request'}};if(m.method==='thread/start'||m.method==='thread/resume')result={thread:{id:threadId}};if(m.method==='turn/start')result={turn:{id:turnId,status:'inProgress'}};send({id:m.id,result});if(m.method==='turn/start'&&task==='native-service-worker'){const marker=state+'/'+task+'-service-'+run+'.signals';const service=spawn(process.execPath,['-e',${JSON.stringify(serviceProgram)},marker],{detached:true,stdio:'ignore'});service.unref();writeFileSync(state+'/'+task+'-service-'+run+'.json',JSON.stringify({pid:service.pid,runId:run,marker}));}if(m.method==='turn/start'){send({method:'turn/started',params:{threadId,turn:{id:turnId}}});send({id:700,method:'item/commandExecution/requestApproval',params:{threadId,turnId,itemId:'command',command:'Read-only fixture command',cwd:process.cwd(),availableDecisions:['accept','decline','cancel']}});}if(m.method==='turn/interrupt')send({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'interrupted',items:[]}}});});
`,{mode:0o700});
 const project={id:'native-test',name:'Native test',mode:'repository',readiness:{ready:true},repositories:[{id:'repo',path:repo,baseRef:'main'}],worker:{sandbox:'read-only',timeoutMs:60000,maxConcurrent:2}};
 let controller=await createController({stateDir:state,sourceDir,executable:binary,project});
 const action=async(taskId,action)=>{const task=await readTask(state,taskId);await requestWorkerAction(state,{taskId,actionId:action+'-'+taskId+'-'+Date.now(),action,expectedRunId:task.runId||null});};
 t.after(async()=>{for(const id of ['native-allow-worker','native-deny-worker','native-stop-worker','native-cancel-worker','native-directed-worker','native-delayed-start-worker','native-service-worker']){try{const task=await readTask(state,id);if(!['completed','failed','stopped'].includes(task.status)){await action(id,'stop');await wait(()=>readTask(state,id),x=>['stopped','failed'].includes(x.status));}}catch{}}await controller.stop();});
 return{dir,repo,state,project,binary,action,get controller(){return controller;},async restart(){await controller.stop();controller=await createController({stateDir:state,sourceDir,executable:binary,project});}};
}
test('native allow and deny continue the exact worker after controller restart, without cross-run replies',async t=>{
 const f=await fixture(t);
 for(const taskId of ['native-allow-worker','native-deny-worker'])await createTask(f.state,{requestId:taskId,ticket:'GH-13',brief:'Read-only native approval acceptance',projectId:f.project.id,repositoryId:'repo'});
 await f.action('native-allow-worker','start');await f.action('native-deny-worker','start');
 const pending=await wait(()=>listWorkerRequests({stateDir:f.state,pendingOnly:true}),x=>x.length===2);assert.equal(pending[0].requestId,pending[1].requestId);assert.notEqual(pending[0].threadId,pending[1].threadId);
 for(const request of pending)await assert.rejects(readFile(path.join(f.state,request.taskId+'-decisions.jsonl')),e=>e.code==='ENOENT');
 const before=await readTask(f.state,'native-allow-worker');await f.restart();const recovered=await listWorkerRequests({stateDir:f.state,pendingOnly:true});assert.equal(recovered.length,2);assert.equal((await readTask(f.state,before.id)).runnerPid,before.runnerPid);
 await assert.rejects(decideWorkerRequest({stateDir:f.state,...pending[0],runId:pending[1].runId,response:{decision:'accept'}}),/correlation|stale/);
 for(const request of recovered){const decision=request.taskId==='native-allow-worker'?'accept':'decline';await decideWorkerRequest({stateDir:f.state,...request,response:{decision}});}
 for(const id of ['native-allow-worker','native-deny-worker']){const task=await wait(()=>readTask(f.state,id),x=>['completed','failed'].includes(x.status));assert.equal(task.status,'completed',task.failure);const rows=(await readFile(path.join(f.state,id+'-decisions.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);assert.equal(rows.length,1);assert.equal(rows[0].id,700);assert.equal(rows[0].result.decision,id==='native-allow-worker'?'accept':'decline');assert.equal(task.result.verification.clean,true);}
 const records=await listWorkerRequests({stateDir:f.state});assert.ok(records.every(x=>x.status==='resolved'));assert.ok(records.every(x=>x.deliveredAt&&x.resolvedAt));
});
test('stopping a worker invalidates pending native approval without sending an automatic answer',async t=>{
 const f=await fixture(t),id='native-stop-worker';await createTask(f.state,{requestId:id,ticket:'GH-13',brief:'Read-only cancellation acceptance',projectId:f.project.id,repositoryId:'repo'});await f.action(id,'start');const [request]=await wait(()=>listWorkerRequests({stateDir:f.state,pendingOnly:true}),x=>x.length===1);await f.action(id,'stop');await wait(()=>readTask(f.state,id),x=>x.status==='stopped');await assert.rejects(decideWorkerRequest({stateDir:f.state,...request,response:{decision:'accept'}}),/stale|inactive/);await assert.rejects(readFile(path.join(f.state,id+'-decisions.jsonl')),e=>e.code==='ENOENT');
});

test('malformed lifecycle control retains a bounded failure and never answers a pending native approval',async t=>{
 const f=await fixture(t),id='native-stop-worker';await createTask(f.state,{requestId:id,ticket:'GH-13',brief:'Read-only protocol failure acceptance',projectId:f.project.id,repositoryId:'repo'});await f.action(id,'start');const [request]=await wait(()=>listWorkerRequests({stateDir:f.state,pendingOnly:true}),x=>x.length===1);const task=await readTask(f.state,id);
 await writeFile(path.join(task.runDir,'control.json'),'{"secret":"unpublished-test-content" invalid');
 const failure=await wait(()=>readFile(path.join(task.runDir,'protocol-error.json'),'utf8').then(JSON.parse).catch(()=>null),x=>x?.code==='INVALID_JSON');assert.equal(failure.runId,task.runId);assert.equal(failure.stage,'lifecycle control read');assert.ok(!JSON.stringify(failure).includes('unpublished-test-content'));assert.ok(JSON.stringify(failure).length<1000);
 assert.equal((await listWorkerRequests({stateDir:f.state,pendingOnly:true}))[0].approvalId,request.approvalId);await assert.rejects(readFile(path.join(f.state,id+'-decisions.jsonl')),e=>e.code==='ENOENT');
 await f.action(id,'stop');await wait(()=>readTask(f.state,id),x=>x.status==='stopped');
});

test('native approval cancellation ends the turn honestly and retains explicit resumable history',async t=>{
 const f=await fixture(t),id='native-cancel-worker';await createTask(f.state,{requestId:id,ticket:'GH-13',brief:'Read-only native cancellation acceptance',projectId:f.project.id,repositoryId:'repo'});await f.action(id,'start');const [request]=await wait(()=>listWorkerRequests({stateDir:f.state,pendingOnly:true}),x=>x.length===1);await decideWorkerRequest({stateDir:f.state,...request,response:{decision:'cancel'}});const task=await wait(()=>readTask(f.state,id),x=>['stopped','failed'].includes(x.status));assert.equal(task.status,'stopped',task.failure);assert.equal(task.nativeTurnStatus,'interrupted');assert.equal(task.result,undefined);assert.equal(task.failure,null);assert.equal(task.threadId,request.threadId);assert.ok(task.attention.some(x=>x.id===task.runId+':native-interrupted'));const exit=JSON.parse(await readFile(path.join(task.runDir,'exit.json')));assert.equal(exit.stopConfirmed,true);assert.equal(exit.completedTurn,false);assert.equal(exit.nativeTurnStatus,'interrupted');
});

test('GH50 directions survive dirty advanced HEAD and changed configuration while native approval still forwards', async t => {
 const f=await fixture(t),id='native-directed-worker';
 await createTask(f.state,{requestId:id,ticket:'GH-50',brief:'Inspect the disposable native fixture',projectId:f.project.id,repositoryId:'repo'});
 await f.action(id,'start');
 const [initialRequest]=await wait(()=>listWorkerRequests({stateDir:f.state,pendingOnly:true}),rows=>rows.length===1);
 await decideWorkerRequest({stateDir:f.state,...initialRequest,response:{decision:'accept'}});
 const initial=await wait(()=>readTask(f.state,id),task=>task.status==='completed');
 await writeFile(path.join(initial.worktree,'README.md'),'Advanced by prior worker work\n');
 await exec('git',['-C',initial.worktree,'add','README.md']);
 await exec('git',['-C',initial.worktree,'-c','user.name=Fixture','-c','user.email=fixture@localhost.invalid','commit','-m','Worker advanced HEAD']);
 await writeFile(path.join(initial.worktree,'direction-draft.txt'),'Uncommitted work is ordinary context\n');
 await mkdir(path.join(initial.worktree,'.codex'),{recursive:true});
 await writeFile(path.join(initial.worktree,'.codex','config.toml'),'approval_policy = "on-request"\nsandbox_mode = "workspace-write"\n');
 await writeFile(path.join(initial.worktree,'AGENTS.md'),'Preserve this changed project guidance and accept manager directions.\n');
 const stateFile=path.join(f.state,'tasks',id+'.json');
 const legacy=JSON.parse(await readFile(stateFile,'utf8'));
 for(const result of [legacy.result,...(legacy.assignments||[]).map(item=>item.result)])if(result?.verification){delete result.verification.worktreeFingerprint;delete result.verification.head;}
 await writeFile(stateFile,JSON.stringify(legacy));
 f.project.readiness={ready:false,issues:['Changed project configuration after initial assignment']};
 f.project.repositories[0].baseRef='base-ref-no-longer-available';
 const directed=await requestWorkerFollowup(f.state,{taskId:id,requestId:'native-direction-after-changes',brief:'Continue with the changed files and project configuration.'});
 assert.equal(directed.assignments.at(-1).brief,'Continue with the changed files and project configuration.');
 const [request]=await wait(()=>listWorkerRequests({stateDir:f.state,pendingOnly:true}),rows=>rows.length===1);
 assert.notEqual(request.runId,initial.runId);
 assert.equal(request.threadId,initial.threadId,'Native request belongs to the same retained conversation');
 const current=await readTask(f.state,id);
 assert.equal(current.worktree,initial.worktree);
 assert.equal(current.assignments[0].status,'completed');
 const beforeAnswer=(await readFile(path.join(f.state,id+'-decisions.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
 assert.equal(beforeAnswer.length,1,'The follow-up native approval remains unanswered until the human decision');
 await decideWorkerRequest({stateDir:f.state,...request,response:{decision:'accept'}});
 const final=await wait(()=>readTask(f.state,id),task=>task.status==='completed'&&task.runId===request.runId);
 assert.equal(final.threadId,initial.threadId);
 assert.equal(await readFile(path.join(final.worktree,'direction-draft.txt'),'utf8'),'Uncommitted work is ordinary context\n');
 const decisions=(await readFile(path.join(f.state,id+'-decisions.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
 assert.equal(decisions.length,2,'One explicit native answer per assignment');
 const calls=(await readFile(path.join(f.state,id+'-calls.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
 const resume=calls.find(call=>call.method==='thread/resume');
 assert.equal(resume.params.threadId,initial.threadId);
 assert.equal(resume.params.cwd,initial.worktree);
 assert.equal(Object.hasOwn(resume.params,'sandbox'),false,'Crew does not override the native configuration on repository continuation');
 assert.equal(Object.hasOwn(resume.params,'approvalPolicy'),false);
 assert.equal((await listWorkerRequests({stateDir:f.state})).every(row=>row.status==='resolved'),true);
});

test('GH50 queued directions do not overlap a supervisor before its ownership journal exists', async t => {
 const f=await fixture(t),id='native-delayed-start-worker';
 await f.controller.stop();
 const worktree=path.join(f.dir,'retained-worktree'),runId='delayed-native-bootstrap',runDir=path.join(f.state,'runs',id,runId);
 await exec('git',['-C',f.repo,'worktree','add','--detach',worktree,'main']);
 await mkdir(runDir,{recursive:true});
 const supervisor=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
 await new Promise((resolve,reject)=>{supervisor.once('spawn',resolve);supervisor.once('error',reject);});
 const ended=new Promise(resolve=>supervisor.once('close',resolve));
 t.after(async()=>{if(supervisor.exitCode===null){supervisor.kill('SIGTERM');await ended;}});
 await createTask(f.state,{requestId:id,ticket:'GH-50',brief:'Retained startup fixture',projectId:f.project.id,repositoryId:'repo'});
 await updateTask(f.state,id,task=>{task.runId=runId;task.runDir=runDir;task.threadId='native-'+id;task.worktree=worktree;task.repositoryPath=f.repo;task.status='running';task.harnessStarted='pending';task.runnerPid=supervisor.pid;task.spawnIntentAt=new Date().toISOString();});
 await writeFile(path.join(runDir,'config.json'),JSON.stringify({taskId:id,runId,project:f.project}));
 await writeFile(path.join(runDir,'started.json'),JSON.stringify({runId,pid:supervisor.pid,at:new Date().toISOString()}));
 await requestWorkerFollowup(f.state,{taskId:id,requestId:'direction-during-bootstrap',brief:'Keep the same conversation after startup finishes'});
 await f.restart();
 await new Promise(resolve=>setTimeout(resolve,650));
 const pending=await readTask(f.state,id);
 assert.equal(pending.runId,runId,'Missing owner journal never authorizes a second native connection');
 assert.equal(pending.currentAssignmentId,'initial');
 assert.equal(pending.assignments.at(-1).status,'queued');
 assert.equal((await listWorkerRequests({stateDir:f.state,pendingOnly:true})).length,0);
 await updateTask(f.state,id,task=>{task.spawnIntentAt=new Date(Date.now()-16000).toISOString();});
 const unresolved=await wait(()=>readTask(f.state,id),task=>task.followupWait?.includes('startup ownership is unresolved'));
 assert.equal(unresolved.runId,runId,'An expired bootstrap becomes a truthful transport failure, never a duplicate launch');
 assert.equal(unresolved.assignments.at(-1).status,'queued');
 supervisor.kill('SIGTERM');await ended;
 await writeFile(path.join(runDir,'exit.json'),JSON.stringify({runId,threadId:'native-'+id,exitCode:0,nativeTurnStatus:'completed',completedTurn:true,stopConfirmed:true,commands:[],finalMessage:'Bootstrap fixture ended',at:new Date().toISOString()}));
 const [request]=await wait(()=>listWorkerRequests({stateDir:f.state,pendingOnly:true}),rows=>rows.length===1);
 assert.notEqual(request.runId,runId,'Confirmed terminal evidence releases the transport startup hold');
 assert.equal(request.threadId,'native-'+id);
 await decideWorkerRequest({stateDir:f.state,...request,response:{decision:'accept'}});
 await wait(()=>readTask(f.state,id),task=>task.status==='completed'&&task.runId===request.runId);
});

test('GH50 natural native closure preserves captured agent services and permits same-context direction', async t => {
 const f=await fixture(t),id='native-service-worker',services=[];
 const matches=(expected,actual)=>actual&&actual.start===expected.start&&actual.commandHash===expected.commandHash&&!actual.state?.includes('Z');
 t.after(async()=>{for(const service of services){const actual=(await snapshotProcesses()).get(service.pid);if(matches(service.identity,actual)){process.kill(service.pid,'SIGTERM');await wait(()=>snapshotProcesses(),rows=>!matches(service.identity,rows.get(service.pid)));}}});
 const captureService=async request=>{
  const service=await wait(()=>readFile(path.join(f.state,id+'-service-'+request.runId+'.json'),'utf8').then(JSON.parse).catch(()=>null),value=>Number.isInteger(value?.pid));
  service.identity=await wait(()=>snapshotProcesses(),rows=>Boolean(rows.get(service.pid))).then(rows=>rows.get(service.pid));
  services.push(service);
  await wait(()=>readFile(service.marker+'.ready','utf8').catch(()=>null),value=>value==='ready');
  const task=await readTask(f.state,id);
  await wait(()=>readFile(path.join(task.runDir,'ownership.json'),'utf8').then(JSON.parse).catch(()=>null),value=>value?.records.some(record=>record.pid===service.pid&&record.start===service.identity.start&&record.commandHash===service.identity.commandHash));
  return service;
 };
 await createTask(f.state,{requestId:id,ticket:'GH-50',brief:'Start the disposable agent-owned service and report',projectId:f.project.id,repositoryId:'repo'});
 await f.action(id,'start');
 const [firstRequest]=await wait(()=>listWorkerRequests({stateDir:f.state,pendingOnly:true}),rows=>rows.length===1);
 const firstService=await captureService(firstRequest);
 await decideWorkerRequest({stateDir:f.state,...firstRequest,response:{decision:'accept'}});
 const initial=await wait(()=>readTask(f.state,id),task=>task.status==='completed');
 const exit=JSON.parse(await readFile(path.join(initial.runDir,'exit.json'),'utf8'));
 assert.equal(exit.connectionClosed,true);
 assert.equal(exit.stopConfirmed,false,'Remaining service ownership is separate from native connection closure');
 assert.ok(exit.ownership.remaining.some(record=>record.pid===firstService.pid));
 assert.ok(matches(firstService.identity,(await snapshotProcesses()).get(firstService.pid)),'Natural native closure keeps the captured service alive');
 await assert.rejects(readFile(firstService.marker,'utf8'),error=>error.code==='ENOENT');
 const retained=await wait(()=>readTask(f.state,id),task=>task.retainedResourceRuns?.some(run=>run.runId===initial.runId));
 assert.equal(retained.threadId,firstRequest.threadId);
 await requestWorkerFollowup(f.state,{taskId:id,requestId:'direction-with-retained-service',brief:'Continue in the same context while the service remains running'});
 const [nextRequest]=await wait(()=>listWorkerRequests({stateDir:f.state,pendingOnly:true}),rows=>rows.length===1);
 assert.equal(nextRequest.threadId,initial.threadId);
 assert.notEqual(nextRequest.runId,initial.runId);
 assert.equal((await readTask(f.state,id)).worktree,initial.worktree);
 assert.ok(matches(firstService.identity,(await snapshotProcesses()).get(firstService.pid)));
 const secondService=await captureService(nextRequest);
 await f.action(id,'stop');
 await wait(()=>readTask(f.state,id),task=>task.status==='stopped');
 await wait(()=>snapshotProcesses(),rows=>!matches(secondService.identity,rows.get(secondService.pid)));
 assert.match(await readFile(secondService.marker,'utf8'),/SIGTERM/,'Explicit stop still stops the current captured service');
 assert.ok(matches(firstService.identity,(await snapshotProcesses()).get(firstService.pid)),'Older retained service is not silently torn down by another run');
});
