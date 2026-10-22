// GH-50: real detached supervisors and a synthetic subscription app-server.
// Every repository, executable, project hook and state file is disposable.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,realpath,rename,rm} from 'node:fs/promises';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {createController} from '../runtime/workers/controller.mjs';
import * as store from '../runtime/orchestration/store.mjs';
import {listWorkerRequests} from '../runtime/workers/approval-store.mjs';

const exec=promisify(execFile),sourceDir=fileURLToPath(new URL('../runtime/',import.meta.url));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function wait(read,predicate,label){
 const until=Date.now()+30000;let value;
 while(Date.now()<until){value=await read();if(predicate(value))return value;await sleep(40);}
 const diagnostic=value&&typeof value==='object'?Object.fromEntries(['status','runId','currentAssignmentId','failure','followupWait','capacityWait','progress','execution'].map(key=>[key,value[key]])):value;
 throw Error(`Timed out ${label}: ${JSON.stringify(diagnostic)}`);
}

test('manager directions repeatedly continue completed work with uncommitted, missing-hash and externally removed files',async t=>{
 const f=await fixture(t),initial=await f.create();await f.finish(initial,{message:'Research complete.'});const research=await f.completed();
 const tools=await f.manager(null,{},'tools/list');assert.ok(!tools.tools.some(x=>['review_worker_followup','approve_worker_followup_changes'].includes(x.name)),'Crew has no direction review/adoption tools');
 const first=await f.followup('implementation-direction','Implement the fixture file.');const retry=await f.manager('assign_worker_followup',first.args);assert.equal(retry.assignments.length,first.task.assignments.length);
 const implementation=await f.active();await f.finish(implementation,{write:'Uncommitted worker output.\n',message:'Implementation complete.'});const implemented=await f.completed();
 // Legacy records lack terminal hashes; both known output and external edits remain ordinary context.
 await store.updateTask(f.state,f.taskId,n=>{delete n.worktreeEvidence;delete n.terminalWorktreeEvidence;delete n.retainedWorktreeEvidence;if(n.result?.verification)delete n.result.verification.worktreeFingerprint;});
 await rm(path.join(implemented.runDir,'worktree-evidence.json'),{force:true});await writeFile(path.join(implemented.worktree,'outside-note.txt'),'External change without review.\n');
 await f.followup('dirty-legacy-direction','Continue using the current edited files.',null,{expectedRunId:'older-manager-observation',expectedAssignmentId:'initial',ticket:'Optional context metadata',userDecision:'Direction metadata; no separate Crew authorization decision.'});const dirty=await f.active();assert.equal(await readFile(path.join(dirty.worktree,'implementation.txt'),'utf8'),'Uncommitted worker output.\n');await f.finish(dirty,{message:'Dirty legacy continuation complete.'});const preserved=await f.completed();
 await rm(path.join(preserved.worktree,'implementation.txt'));await rm(path.join(preserved.worktree,'outside-note.txt'));await f.followup('removed-output-direction','Continue after the previous output was removed.');const removed=await f.active();await f.finish(removed,{message:'Removal accepted.'});const final=await f.completed();
 assert.equal(final.threadId,research.threadId);assert.equal(final.worktree,research.worktree);await assert.rejects(readFile(path.join(final.worktree,'.fixture/setup-count')),{code:'ENOENT'});assert.equal(final.assignments.length,4);assert.deepEqual(final.assignments.map(a=>a.result.message),['Research complete.','Implementation complete.','Dirty legacy continuation complete.','Removal accepted.']);assert.ok(final.assignments.every(a=>a.status==='completed'));
 const rows=await f.calls();assert.equal(rows.filter(c=>c.method==='thread/start').length,1);assert.equal(rows.filter(c=>c.method==='thread/resume').length,3);assert.deepEqual(await listWorkerRequests({stateDir:f.state,taskId:f.taskId}),[],'stale native approvals never become current requests');
 await assert.rejects(store.reportTask(f.state,f.taskId,research.runId,{reportId:'late-research',kind:'result',message:'Stale result.'}),/Stale/);
});

test('manager directions accept advanced HEAD, different repository configuration, lifecycle commands, instructions and native settings',async t=>{
 const f=await fixture(t),initial=await f.create();await f.finish(initial,{message:'Original research complete.'});const original=await f.completed();
 await exec('git',['-C',original.worktree,'config','user.name','Fixture']);await exec('git',['-C',original.worktree,'config','user.email','fixture@localhost.invalid']);await writeFile(path.join(original.worktree,'committed.txt'),'Advanced worker history.\n');await exec('git',['-C',original.worktree,'add','committed.txt']);await exec('git',['-C',original.worktree,'commit','-qm','Advance disposable worker HEAD']);
 await writeFile(path.join(original.worktree,'AGENTS.md'),'Updated local instructions.\n');await mkdir(path.join(original.worktree,'.codex'),{recursive:true});await writeFile(path.join(original.worktree,'.codex/config.toml'),'# Native settings changed; Crew must pass through.\n');
 await writeFile(path.join(original.worktree,'actions.mjs'),'throw Error("Crew must not replay project setup or readiness to deliver direction");\n');
 f.project.readiness={ready:false,issues:['Changed settings are not a direction permission']};f.project.repositories[0].path=path.join(f.dir,'different-configured-repository');f.project.repositories[0].baseRef='nonexistent-new-base';f.project.worker.sandbox='read-only';f.project.worker.environment.executionPlan.setup.command='exit 91';f.project.worker.environment.executionPlan.ready={...f.project.worker.environment.executionPlan.setup,command:'exit 92'};
 await f.followup('changed-config-direction','Continue in the existing conversation and current working directory.');const next=await f.active();assert.equal(next.threadId,original.threadId);assert.equal(next.worktree,original.worktree);assert.notEqual((await exec('git',['-C',next.worktree,'rev-parse','HEAD'])).stdout.trim(),original.baseCommit);await f.finish(next,{message:'Advanced HEAD and changed configuration accepted.'});const final=await f.completed();assert.equal(final.assignments.length,2);await assert.rejects(readFile(path.join(final.worktree,'.fixture/setup-count')),{code:'ENOENT'});assert.equal(await readFile(path.join(final.worktree,'committed.txt'),'utf8'),'Advanced worker history.\n');
});

test('busy directions steer in order before completion and survive controller restart without duplicate turns',async t=>{
 const f=await fixture(t),initial=await f.create();
 await f.followup('busy-manager-direction','Perform the next inspection.');
 await f.followup('second-busy-direction','Then inspect once more on the same conversation.');
 const steered=await wait(f.read,x=>x.assignments.slice(-2).every(a=>a.delivery?.state==='acknowledged'),'ordered steering acknowledgement');
 assert.equal(steered.runId,initial.runId);assert.equal(steered.threadId,initial.threadId);assert.equal(steered.worktree,initial.worktree);assert.equal(steered.currentAssignmentId,'initial');assert.equal(steered.status,'running');assert.equal(steered.result,undefined);
 assert.deepEqual(steered.assignments.slice(-2).map(a=>a.status),['steered','steered']);
 assert.ok(steered.reports.some(r=>r.reportId==='steer-busy-manager-direction'));
 assert.ok(steered.reports.some(r=>r.reportId==='steer-second-busy-direction'));
 let calls=await f.calls();assert.equal(calls.filter(c=>c.method==='turn/start').length,1);
 assert.deepEqual(calls.filter(c=>c.method==='turn/steer').map(c=>c.params.clientUserMessageId),['busy-manager-direction','second-busy-direction']);
 await f.stopController();
 const pending=await f.followup('restart-manager-direction','Correct this still-active assignment while the controller is closed.');
 await wait(f.read,x=>x.assignments.at(-1).delivery?.state==='acknowledged','independent supervisor steering');
 await f.restart();await f.manager('assign_worker_followup',pending.args);await f.tick();
 calls=await f.calls();assert.equal(calls.filter(c=>c.method==='turn/start').length,1);assert.equal(calls.filter(c=>c.method==='turn/steer').length,3);
 await f.finish(initial,{message:'Original turn completed after all corrections.'});const completed=await f.completed();assert.equal(completed.runId,initial.runId);assert.equal(completed.assignments.length,4);assert.equal(completed.assignments[0].result.message,'Original turn completed after all corrections.');
 await f.followup('idle-after-steering','Continue now that the original turn ended.');const resumed=await f.active(initial.runId);assert.equal(resumed.threadId,initial.threadId);await f.finish(resumed,{message:'Idle continuation complete.'});await f.completed();
});

test('new directions continue question, paused and failed workers without Crew approval or adoption',async t=>{
 const f=await fixture(t),initial=await f.create();await f.finish(initial,{kind:'question',message:'What next?'});const question=await wait(f.read,x=>x.status==='awaiting_answer'&&x.execution?.live===false,'native question boundary');await f.followup('question-new-direction','Here is the next instruction; continue with this.');const directed=await f.active();assert.notEqual(directed.runId,question.runId);assert.equal(directed.question,null);await f.action('pause');const paused=await wait(f.read,x=>x.status==='paused'&&x.execution?.live===false,'confirmed pause');await writeFile(path.join(paused.worktree,'after-pause.txt'),'New external work.\n');await f.followup('paused-new-direction','Continue with these changed files.');const resumed=await f.active();assert.notEqual(resumed.runId,paused.runId);await f.finish(resumed,{message:'Pause continuation complete.'});const completed=await f.completed();
 await store.updateTask(f.state,f.taskId,n=>{n.status='failed';n.failure='Historical failure must not become a communication permission.';});await f.followup('failed-new-direction','Continue after the historical failure.');const recovered=await f.active();assert.equal(recovered.threadId,initial.threadId);assert.equal(recovered.worktree,initial.worktree);await f.finish(recovered,{message:'Failure continuation complete.'});const final=await f.completed();assert.equal(final.assignments.length,4);assert.ok(final.reports.some(r=>r.runId===question.runId&&r.kind==='question'));assert.equal(final.assignments.find(a=>a.id===completed.currentAssignmentId).result.message,'Pause continuation complete.');
});

test('same-assignment question answers and pause/resume continue through changed files without direction review',async t=>{
 const f=await fixture(t),initial=await f.create('Implement this disposable fixture, then ask the manager what comes next.');await f.finish(initial,{write:'Existing worker work.\n',kind:'question',message:'Continue?'});const question=await wait(f.read,x=>x.status==='awaiting_answer'&&x.execution?.live===false,'question boundary');await writeFile(path.join(question.worktree,'external.txt'),'Changed while waiting.\n');await f.manager('answer_question',{taskId:f.taskId,questionId:'fixture-result',answer:'Continue.'});const answered=await f.active();assert.equal(store.currentAssignment(answered).id,store.currentAssignment(question).id);await f.action('pause');const paused=await wait(f.read,x=>x.status==='paused'&&x.execution?.live===false,'pause');await rm(path.join(paused.worktree,'implementation.txt'));await f.action('resume');const resumed=await f.active();assert.equal(store.currentAssignment(resumed).id,store.currentAssignment(question).id);await f.finish(resumed,{message:'Same assignment resumed.'});const final=await f.completed();assert.equal(final.threadId,initial.threadId);assert.equal(final.worktree,initial.worktree);
});

test('missing actual working directory remains truthful unavailability, not fabricated delivery',async t=>{
 const f=await fixture(t),initial=await f.create();await f.finish(initial,{message:'Completed before directory removal.'});const completed=await f.completed();await rm(completed.worktree,{recursive:true});await f.followup('missing-directory-direction','Continue in the existing context.');const unavailable=await wait(f.read,x=>Boolean(x.failure||x.followupWait),'missing actual resource');assert.match(unavailable.failure||unavailable.followupWait,/missing|directory|worktree|ENOENT/i);assert.equal((await f.calls()).filter(c=>c.method==='turn/start').length,1);assert.equal(unavailable.threadId,initial.threadId);assert.equal(unavailable.worktree,initial.worktree);
});

test('explicit archive ends availability and preserves history without pretending to deliver another direction',async t=>{
 const f=await fixture(t),initial=await f.create();await f.finish(initial,{message:'Completed before explicit archive.'});const completed=await f.completed();await f.action('archive');const archived=await wait(f.read,x=>x.status==='disposed','archive');await assert.rejects(f.followup('archived-direction','Continue if a real session remains.'),/archiv|disposed|unavailable/i);assert.equal((await f.calls()).filter(c=>c.method==='turn/start').length,1);assert.equal(archived.assignments?.[0]?.result?.message||archived.result.message,'Completed before explicit archive.');assert.equal(archived.threadId,completed.threadId);
});

test('agent workflow state is independent of execution and agent-requested environment commands retain native approvals',async t=>{
 const f=await fixture(t),initial=await f.create();await assert.rejects(readFile(path.join(initial.worktree,'.fixture/setup-count')),{code:'ENOENT'});
 const metadata=await f.worker('get_project_environment',{});assert.ok(metadata.configuredEnvironment?.executionPlan?.setup?.command,'agent can inspect configured commands');await assert.rejects(readFile(path.join(initial.worktree,'.fixture/setup-count')),{code:'ENOENT'});
 const state=await f.worker('set_workflow_state',{requestId:'agent-workflow-ready',state:'Ready for review'});assert.equal(state.workflowState.value,'Ready for review');assert.equal(state.workflowState.actor,'worker');assert.equal(state.workflowState.runId,initial.runId);assert.equal(state.status,'running','workflow state does not stop or finish a native turn');
 await f.finish(initial,{approval:true,nativeCommand:metadata.configuredEnvironment.executionPlan.setup.command,message:'Agent explicitly ran configured setup.'});const [request]=await wait(()=>listWorkerRequests({stateDir:f.state,taskId:f.taskId,pendingOnly:true}),x=>x.length===1,'native approval');assert.equal(request.runId,initial.runId);assert.ok(!(await f.calls()).some(c=>c.method==='fixture/native-response'),'accepted direction does not answer native approval');await assert.rejects(readFile(path.join(initial.worktree,'.fixture/setup-count')),{code:'ENOENT'});
 await f.manager('set_workflow_state',{taskId:f.taskId,requestId:'manager-workflow-wait',state:'Awaiting native approval'});assert.equal((await f.read()).status,'running');
 await f.manager('answer_worker_approval',{taskId:f.taskId,runId:request.runId,approvalId:request.approvalId,threadId:request.threadId,turnId:request.turnId,requestIdJson:JSON.stringify(request.requestId),responseJson:JSON.stringify({decision:'accept'})});const completed=await f.completed();assert.equal(await readFile(path.join(completed.worktree,'.fixture/setup-count'),'utf8'),'1');assert.equal(completed.workflowState.value,'Awaiting native approval','execution completion never invents a workflow transition');assert.equal((await f.calls()).filter(c=>c.method==='fixture/native-response').length,1);
 await f.followup('workflow-next-direction','Continue with the existing environment.');const next=await f.active();assert.equal(next.workflowState.value,'Awaiting native approval');await f.worker('set_workflow_state',{requestId:'agent-workflow-done',state:'Done'});const marked=await f.read();assert.equal(marked.status,'running');assert.equal(marked.workflowState.value,'Done');await f.finish(next,{message:'Agent workflow complete.'});const final=await f.completed();assert.equal(final.workflowHistory.length,3);assert.equal(final.workflowState.value,'Done');assert.equal(await readFile(path.join(final.worktree,'.fixture/setup-count'),'utf8'),'1','Crew never reruns agent commands on direction delivery');
});

test('explicit lifecycle resume after completion creates fresh work while preserving every prior result',async t=>{
 const f=await fixture(t),initial=await f.create();await f.finish(initial,{message:'Research result retained.'});const research=await f.completed();await f.followup('resume-test-implementation','Implement and check this fixture file.');const implementation=await f.active();await f.finish(implementation,{write:'Retained implementation.\n',message:'Implementation result retained.'});const completed=await f.completed();const prior=structuredClone(completed.assignments);
 const request={taskId:f.taskId,actionId:'resume-completed-action',action:'resume',expectedRunId:completed.runId};await f.manager('worker_action',request);const resumed=await f.active(completed.runId);assert.equal(resumed.threadId,research.threadId);assert.equal(resumed.worktree,research.worktree);assert.equal(resumed.result,null,'old completed result is not projected as current execution');assert.notEqual(resumed.currentAssignmentId,completed.currentAssignmentId);assert.equal(store.currentAssignment(resumed).brief,store.currentAssignment(completed).brief);assert.deepEqual(resumed.assignments.slice(0,2),prior);await f.manager('worker_action',request);assert.equal((await f.read()).assignments.length,3,'exact lifecycle retry cannot create another assignment');await f.finish(resumed,{message:'Explicit resumed work complete.'});const final=await f.completed();assert.deepEqual(final.assignments.slice(0,2),prior);assert.equal(final.assignments.at(-1).result.message,'Explicit resumed work complete.');assert.equal(final.result.message,'Explicit resumed work complete.');assert.equal(await readFile(path.join(final.worktree,'implementation.txt'),'utf8'),'Retained implementation.\n');
});

async function fixture(t){
 const dir=await realpath(await mkdtemp(path.join(os.tmpdir(),'crew-followup-'))),repo=path.join(dir,'repo'),state=path.join(dir,'state'),gates=path.join(dir,'gates'),binary=path.join(dir,'native.mjs'),log=path.join(dir,'calls.jsonl');
 await mkdir(repo);await mkdir(gates);
 const script=`import fs from 'node:fs';fs.mkdirSync('.fixture',{recursive:true});if(process.argv[2]==='setup'){const p='.fixture/setup-count';const n=fs.existsSync(p)?Number(fs.readFileSync(p,'utf8')):0;fs.writeFileSync(p,String(n+1));}else if(process.argv[2]==='teardown')fs.writeFileSync('.fixture/disposed','yes');`;
 await writeFile(path.join(repo,'actions.mjs'),script);await writeFile(path.join(repo,'.gitignore'),'.fixture/\n');await writeFile(path.join(repo,'README.md'),'Disposable worker assignment fixture.\n');
 await exec('git',['init','-q','-b','main',repo]);await exec('git',['-C',repo,'add','.']);await exec('git',['-C',repo,'-c','user.name=Fixture','-c','user.email=fixture@localhost.invalid','commit','-qm','Fixture']);
 const source={path:'actions.mjs',sha256:createHash('sha256').update(script).digest('hex')};
 const hook=phase=>({command:`${JSON.stringify(process.execPath)} actions.mjs ${phase}`,source,timeoutMs:10000});
 const plan={schemaVersion:1,sources:[source],setup:hook('setup'),start:null,resume:null,ready:null,stop:null,teardown:hook('teardown')};
 await writeFile(binary,`#!${process.execPath}
import{createInterface}from'node:readline';import{execFileSync}from'node:child_process';import{appendFileSync,existsSync,readFileSync,writeFileSync,openSync,closeSync,unlinkSync}from'node:fs';import{reportTask}from${JSON.stringify(new URL('../runtime/orchestration/store.mjs',import.meta.url).href)};
const raw=process.argv.find(x=>x.startsWith('mcp_servers.local_orchestration.args='));const[,state,,task,run]=JSON.parse(raw.slice(raw.indexOf('=')+1));
const log=${JSON.stringify(log)},gate=${JSON.stringify(gates)}+'/'+run,lock=${JSON.stringify(path.join(dir,'active'))},threadId='followup-retained-thread',turnId='turn-'+run,send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
process.on('uncaughtException',error=>{appendFileSync(log,JSON.stringify({method:'fixture/error',run,message:error.message,stack:error.stack})+'\\n');process.exit(1);});
closeSync(openSync(lock,'wx'));const lines=createInterface({input:process.stdin});let timer,pendingDecision;
const release=()=>{clearInterval(timer);appendFileSync(log,JSON.stringify({method:'fixture/exit',run})+'\\n');try{unlinkSync(lock);}catch(error){if(error.code!=='ENOENT')throw error;}process.exit(0);};
lines.on('close',release);process.on('SIGTERM',release);
async function finishDecision(decision){if(decision.write)writeFileSync('implementation.txt',decision.write);if(decision.nativeCommand){const output=execFileSync('/bin/zsh',['-lc',decision.nativeCommand],{encoding:'utf8'});send({method:'item/completed',params:{threadId,turnId,item:{type:'commandExecution',id:'agent-command',command:decision.nativeCommand,exitCode:0,aggregatedOutput:output}}});}await reportTask(state,task,run,{reportId:'fixture-result',kind:decision.kind||'result',message:decision.message||'Completed '+run,evidence:['Synthetic local command and retained context checked.']});send({method:'item/completed',params:{threadId,turnId,item:{type:'agentMessage',id:'current-reply',text:decision.message||'Completed '+run}}});send({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed',items:[]}}});}
for await(const line of lines){const m=JSON.parse(line);if(m.id===undefined)continue;appendFileSync(log,JSON.stringify({...m,run,cwd:process.cwd()})+'\\n');if(!m.method){appendFileSync(log,JSON.stringify({method:'fixture/native-response',run,response:m.result})+'\\n');send({method:'serverRequest/resolved',params:{threadId,requestId:m.id}});if(pendingDecision)await finishDecision(pendingDecision);continue;}let result={};
if(m.method==='account/read')result={account:{type:'chatgpt'}};
if(m.method==='config/read')result={config:{sandbox_mode:'workspace-write',approval_policy:'on-request'}};
if(m.method==='turn/steer'){result={turnId};await reportTask(state,task,run,{reportId:'steer-'+m.params.clientUserMessageId,kind:'progress',message:'Consumed manager correction: '+m.params.input[0].text});}
if(m.method==='thread/start'||m.method==='thread/resume')result={thread:{id:threadId}};
if(m.method==='thread/resume')send({method:'turn/completed',params:{threadId,turn:{id:'stale-prior-turn',status:'completed',items:[]}}});
if(m.method==='turn/start'){
 result={turn:{id:turnId,status:'inProgress'}};
 // The current item arrives before the RPC ack; old events must not cross assignments.
 send({method:'item/completed',params:{threadId,turnId,item:{type:'commandExecution',id:'current-check',command:'node --version',exitCode:0,aggregatedOutput:'synthetic command evidence'}}});
 send({method:'turn/started',params:{threadId,turn:{id:'stale-prior-turn',status:'inProgress'}}});
 send({id:909,method:'item/commandExecution/requestApproval',params:{threadId,turnId:'stale-prior-turn',itemId:'stale-command',command:'echo stale',reason:'Old turn approval must remain stale.'}});
 send({method:'item/completed',params:{threadId,turnId:'stale-prior-turn',item:{type:'agentMessage',id:'stale-reply',text:'stale research reply'}}});
 send({method:'turn/completed',params:{threadId,turn:{id:'stale-prior-turn',status:'completed',items:[]}}});
}
send({id:m.id,result});
if(m.method==='turn/start'){
 send({method:'turn/started',params:{threadId,turn:{id:turnId,status:'inProgress'}}});
 await reportTask(state,task,run,{reportId:'fixture-progress',kind:'progress',message:'Waiting at synthetic assignment boundary.'});
 timer=setInterval(async()=>{if(!existsSync(gate))return;clearInterval(timer);const decision=JSON.parse(readFileSync(gate,'utf8'));if(decision.approval){pendingDecision=decision;send({id:700,method:'item/commandExecution/requestApproval',params:{threadId,turnId,itemId:'agent-command',command:decision.nativeCommand||'node --version',cwd:process.cwd(),availableDecisions:['accept','decline','cancel']}});}else await finishDecision(decision);},20);
}
if(m.method==='turn/interrupt'){clearInterval(timer);send({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'interrupted',items:[]}}});}}
`,{mode:0o700});
 const project={id:'followup-fixture',name:'Follow-up fixture',mode:'repository',readiness:{ready:true},repositories:[{id:'repo',path:repo,baseRef:'main'}],worker:{sandbox:'workspace-write',timeoutMs:60000,maxConcurrent:1,environment:{executionPlan:plan}}},taskId='retained-worker';
 let admissionHeld=false;
 const controllerOptions={stateDir:state,sourceDir,executable:binary,project,admissionHeld:async()=>admissionHeld};
 let controller=await createController(controllerOptions);
 const read=()=>store.readTask(state,taskId);
 const action=async(action)=>{const task=await read();await store.requestWorkerAction(state,{taskId,actionId:action+'-'+Date.now(),action,expectedRunId:task.runId||null});await controller.tick();};
 const active=(previousRun=null)=>wait(read,x=>x.runId!==previousRun&&x.status==='running'&&x.threadId&&x.reports.some(r=>r.runId===x.runId&&r.kind==='progress'&&r.message==='Waiting at synthetic assignment boundary.'),'worker turn');
 const completed=()=>wait(read,x=>x.status==='completed'&&x.execution?.live===false,'verified completion');
 const finish=async(task,decision={})=>{const file=path.join(gates,task.runId);await writeFile(file+'.tmp',JSON.stringify(decision));await rename(file+'.tmp',file);};
 const runtime=path.join(dir,'manager-runtime.json');
 const rpc=async(role,name,args={},method='tools/call')=>{
  await writeFile(runtime,JSON.stringify({project}));
  const task=role==='worker'?await read():null;const binding=role==='worker'?[taskId,task.runId]:[runtime];const child=spawn(process.execPath,[path.join(sourceDir,'orchestration-mcp.mjs'),state,role,...binding]);let output='',errors='';
  child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>errors+=d);
  child.stdin.end(JSON.stringify({jsonrpc:'2.0',id:1,method,params:method==='tools/list'?{}:{name,arguments:args}})+'\n');
  const code=await new Promise(resolve=>child.on('close',resolve));assert.equal(code,0,errors);
  const result=JSON.parse(output.trim()).result;assert.ok(!result.isError,result.content?.[0]?.text);return method==='tools/list'?result:JSON.parse(result.content[0].text);
 };
 const manager=(name,args,method)=>rpc('manager',name,args,method),worker=(name,args,method)=>rpc('worker',name,args,method);
 const followup=async(requestId,brief,from,extra={})=>{const args={taskId,requestId,brief,...extra};return{args,task:await manager('assign_worker_followup',args)};};
 const calls=async()=>{try{return(await readFile(log,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));}catch(error){if(error.code==='ENOENT')return[];throw error;}};
 t.after(async()=>{try{const task=await read().catch(()=>null);if(task?.status==='failed')t.diagnostic(JSON.stringify({failure:task.failure,fixtureErrors:(await calls()).filter(c=>c.method==='fixture/error')}));if(task&&!['completed','stopped','paused','failed','blocked','disposed'].includes(task.status)){await action('pause');await wait(read,x=>['paused','stopped','failed'].includes(x.status),'cleanup stop');}}finally{await controller.stop();await rm(dir,{recursive:true,force:true});}});
 return{dir,repo,state,project,manager,worker,taskId,read,action,active,completed,finish,followup,calls,setAdmissionHeld:value=>{admissionHeld=value;},create:async(brief='Research only. Inspect the disposable fixture; do not edit it.')=>{await store.createTask(state,{requestId:taskId,ticket:'GH-50',brief,projectId:project.id,repositoryId:'repo'});await action('start');return active();},stopController:()=>controller.stop(),restart:async()=>{await controller.stop();controller=await createController(controllerOptions);},tick:()=>controller.tick()};
}
