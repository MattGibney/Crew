import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import os from 'node:os';
import {createController} from '../runtime/controller.mjs';
import {createTask,readTask,requestWorkerAction} from '../runtime/orchestration-store.mjs';
import {listWorkerRequests,decideWorkerRequest} from '../runtime/worker-approvals.mjs';
const exec=promisify(execFile),sourceDir=path.resolve('runtime');
async function wait(observe,predicate,ms=30000){const end=Date.now()+ms;let value;while(Date.now()<end){value=await observe();if(predicate(value))return value;await new Promise(r=>setTimeout(r,40));}throw new Error('Native worker outcome timed out: '+JSON.stringify(value));}
async function fixture(t){
 const dir=await mkdtemp(path.join(os.tmpdir(),'crew-native-worker-')),repo=path.join(dir,'repo'),state=path.join(dir,'state'),binary=path.join(dir,'native.mjs');await mkdir(repo);await exec('git',['init','-b','main',repo]);await writeFile(path.join(repo,'README.md'),'Read-only native protocol acceptance\n');await exec('git',['-C',repo,'add','.']);await exec('git',['-C',repo,'-c','user.name=Fixture','-c','user.email=fixture@localhost.invalid','commit','-m','Fixture']);
 await writeFile(binary,`#!${process.execPath}
import{createInterface}from'node:readline';import{appendFileSync}from'node:fs';import{execFileSync}from'node:child_process';import{reportTask}from${JSON.stringify(new URL('../runtime/orchestration-store.mjs',import.meta.url).href)};
const raw=process.argv.find(x=>x.startsWith('mcp_servers.local_orchestration.args='));const[,state,,task,run]=JSON.parse(raw.slice(raw.indexOf('=')+1));
const threadId='native-'+task,turnId='turn-'+run,send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
process.on('unhandledRejection',error=>{appendFileSync(state+'/'+task+'-fixture-error.txt',String(error.stack));process.exit(1);});const lines=createInterface({input:process.stdin});lines.on('close',()=>process.exit(0));
lines.on('line',async line=>{const m=JSON.parse(line);if(!m.method){appendFileSync(state+'/'+task+'-decisions.jsonl',JSON.stringify(m)+'\\n');send({method:'serverRequest/resolved',params:{threadId,requestId:m.id}});if(m.result.decision==='cancel'){send({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'interrupted',items:[]}}});return;}const output=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'});send({method:'item/completed',params:{threadId,turnId,item:{type:'commandExecution',command:'git rev-parse HEAD',exitCode:0,aggregatedOutput:output}}});await reportTask(state,task,run,{reportId:'native-result',kind:'result',message:'Native decision '+m.result.decision+' reached the same worker.',evidence:['Correlated native round trip; actual read-only Git command succeeded.']});send({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed',items:[]}}});return;}
let result={};if(m.method==='account/read')result={account:{type:'chatgpt'}};if(m.method==='config/read')result={config:{sandbox_mode:'workspace-write',approval_policy:'on-request'}};if(m.method==='thread/start'||m.method==='thread/resume')result={thread:{id:threadId}};if(m.method==='turn/start')result={turn:{id:turnId,status:'inProgress'}};send({id:m.id,result});if(m.method==='turn/start'){send({method:'turn/started',params:{threadId,turn:{id:turnId}}});send({id:700,method:'item/commandExecution/requestApproval',params:{threadId,turnId,itemId:'command',command:'Read-only fixture command',cwd:process.cwd(),availableDecisions:['accept','decline','cancel']}});}if(m.method==='turn/interrupt')send({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'interrupted',items:[]}}});});
`,{mode:0o700});
 const project={id:'native-test',name:'Native test',mode:'repository',readiness:{ready:true},repositories:[{id:'repo',path:repo,baseRef:'main'}],worker:{sandbox:'read-only',timeoutMs:60000,maxConcurrent:2}};
 let controller=await createController({stateDir:state,sourceDir,executable:binary,project});
 const action=async(taskId,action)=>{const task=await readTask(state,taskId);await requestWorkerAction(state,{taskId,actionId:action+'-'+taskId+'-'+Date.now(),action,expectedRunId:task.runId||null});};
 t.after(async()=>{for(const id of ['native-allow-worker','native-deny-worker','native-stop-worker','native-cancel-worker']){try{const task=await readTask(state,id);if(!['completed','failed','stopped'].includes(task.status)){await action(id,'stop');await wait(()=>readTask(state,id),x=>['stopped','failed'].includes(x.status));}}catch{}}await controller.stop();});
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
