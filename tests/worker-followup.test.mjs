// GH-42: real detached supervisors and a synthetic subscription app-server.
// Every repository, executable, project hook and state file is disposable.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,realpath,rename,rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {createController} from '../controller.mjs';
import * as store from '../orchestration-store.mjs';
import {listWorkerRequests} from '../worker-approvals.mjs';
import {captureWorktreeEvidence} from '../worker-worktree-evidence.mjs';

const exec=promisify(execFile),sourceDir=fileURLToPath(new URL('..',import.meta.url));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function wait(read,predicate,label){
 const until=Date.now()+30000;let value;
 while(Date.now()<until){value=await read();if(predicate(value))return value;await sleep(40);}
 const diagnostic=value&&typeof value==='object'?Object.fromEntries(['status','runId','currentAssignmentId','failure','followupWait','capacityWait','progress','execution'].map(key=>[key,value[key]])):value;
 throw Error(`Timed out ${label}: ${JSON.stringify(diagnostic)}`);
}

async function fixture(t){
 const dir=await mkdtemp(path.join(os.tmpdir(),'crew-followup-')),repo=path.join(dir,'repo'),state=path.join(dir,'state'),gates=path.join(dir,'gates'),binary=path.join(dir,'native.mjs'),log=path.join(dir,'calls.jsonl');
 await mkdir(repo);await mkdir(gates);
 const script=`import fs from 'node:fs';fs.mkdirSync('.fixture',{recursive:true});if(process.argv[2]==='setup'){const p='.fixture/setup-count';const n=fs.existsSync(p)?Number(fs.readFileSync(p,'utf8')):0;fs.writeFileSync(p,String(n+1));}else if(process.argv[2]==='teardown')fs.writeFileSync('.fixture/disposed','yes');`;
 await writeFile(path.join(repo,'actions.mjs'),script);await writeFile(path.join(repo,'.gitignore'),'.fixture/\n');await writeFile(path.join(repo,'README.md'),'Disposable worker assignment fixture.\n');
 await exec('git',['init','-q','-b','main',repo]);await exec('git',['-C',repo,'add','.']);await exec('git',['-C',repo,'-c','user.name=Fixture','-c','user.email=fixture@localhost.invalid','commit','-qm','Fixture']);
 const source={path:'actions.mjs',sha256:createHash('sha256').update(script).digest('hex')};
 const hook=phase=>({command:`${JSON.stringify(process.execPath)} actions.mjs ${phase}`,source,timeoutMs:10000});
 const plan={schemaVersion:1,sources:[source],setup:hook('setup'),start:null,resume:null,ready:null,stop:null,teardown:hook('teardown')};
 await writeFile(binary,`#!${process.execPath}
import{createInterface}from'node:readline';import{appendFileSync,existsSync,readFileSync,writeFileSync,openSync,closeSync,unlinkSync}from'node:fs';import{reportTask}from${JSON.stringify(new URL('../orchestration-store.mjs',import.meta.url).href)};
const raw=process.argv.find(x=>x.startsWith('mcp_servers.local_orchestration.args='));const[,state,,task,run]=JSON.parse(raw.slice(raw.indexOf('=')+1));
const log=${JSON.stringify(log)},gate=${JSON.stringify(gates)}+'/'+run,lock=${JSON.stringify(path.join(dir,'active'))},threadId='followup-retained-thread',turnId='turn-'+run,send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
process.on('uncaughtException',error=>{appendFileSync(log,JSON.stringify({method:'fixture/error',run,message:error.message,stack:error.stack})+'\\n');process.exit(1);});
closeSync(openSync(lock,'wx'));const lines=createInterface({input:process.stdin});let timer;
const release=()=>{clearInterval(timer);appendFileSync(log,JSON.stringify({method:'fixture/exit',run})+'\\n');try{unlinkSync(lock);}catch(error){if(error.code!=='ENOENT')throw error;}process.exit(0);};
lines.on('close',release);process.on('SIGTERM',release);
for await(const line of lines){const m=JSON.parse(line);if(m.id===undefined)continue;appendFileSync(log,JSON.stringify({...m,run,cwd:process.cwd()})+'\\n');let result={};
if(m.method==='account/read')result={account:{type:'chatgpt'}};
if(m.method==='config/read')result={config:{sandbox_mode:'workspace-write',approval_policy:'on-request'}};
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
 timer=setInterval(async()=>{if(!existsSync(gate))return;clearInterval(timer);const decision=JSON.parse(readFileSync(gate,'utf8'));if(decision.write)writeFileSync('implementation.txt',decision.write);await reportTask(state,task,run,{reportId:'fixture-result',kind:decision.kind||'result',message:decision.message||'Completed '+run,evidence:['Synthetic local command and retained context checked.']});send({method:'item/completed',params:{threadId,turnId,item:{type:'agentMessage',id:'current-reply',text:decision.message||'Completed '+run}}});send({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed',items:[]}}});},20);
}
if(m.method==='turn/interrupt'){clearInterval(timer);send({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'interrupted',items:[]}}});}}
`,{mode:0o700});
 const project={id:'followup-fixture',name:'Follow-up fixture',mode:'repository',readiness:{ready:true},repositories:[{id:'repo',path:repo,baseRef:'main'}],worker:{sandbox:'workspace-write',timeoutMs:60000,maxConcurrent:1,environment:{executionPlan:plan}}},taskId='retained-worker';
 let admissionHeld=false;
 const controllerOptions={stateDir:state,sourceDir,executable:binary,project,admissionHeld:async()=>admissionHeld};
 let controller=await createController(controllerOptions);
 const read=()=>store.readTask(state,taskId);
 const action=async(action)=>{const task=await read();await store.requestWorkerAction(state,{taskId,actionId:action+'-'+Date.now(),action,expectedRunId:task.runId||null});await controller.tick();};
 const active=()=>wait(read,x=>x.status==='running'&&x.threadId&&x.reports.some(r=>r.runId===x.runId&&r.kind==='progress'&&r.message==='Waiting at synthetic assignment boundary.'),'worker turn');
 const completed=()=>wait(read,x=>x.status==='completed'&&x.execution?.live===false,'verified completion');
 const finish=async(task,decision={})=>{const file=path.join(gates,task.runId);await writeFile(file+'.tmp',JSON.stringify(decision));await rename(file+'.tmp',file);};
 const followup=async(requestId,brief,from,extra={})=>{const task=from||await read();const args={taskId,requestId,expectedRunId:task.runId,expectedAssignmentId:store.currentAssignment(task).id,ticket:'GH-42',brief,userDecision:'The user explicitly authorizes this follow-up scope: '+brief,...extra};return{args,task:await store.requestWorkerFollowup(state,args)};};
 const calls=async()=>{try{return(await readFile(log,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));}catch(error){if(error.code==='ENOENT')return[];throw error;}};
 t.after(async()=>{try{const task=await read().catch(()=>null);if(task?.status==='failed')t.diagnostic(JSON.stringify({failure:task.failure,fixtureErrors:(await calls()).filter(c=>c.method==='fixture/error')}));if(task&&!['completed','stopped','paused','failed','blocked','disposed'].includes(task.status)){await action('pause');await wait(read,x=>['paused','stopped','failed'].includes(x.status),'cleanup stop');}}finally{await controller.stop();await rm(dir,{recursive:true,force:true});}});
 return{dir,repo,state,project,taskId,read,action,active,completed,finish,followup,calls,setAdmissionHeld:value=>{admissionHeld=value;},create:async()=>{await store.createTask(state,{requestId:taskId,ticket:'GH-42',brief:'Research only. Inspect the disposable fixture; do not edit it.',projectId:project.id,repositoryId:'repo'});await action('start');return active();},stopController:()=>controller.stop(),restart:async()=>{await controller.stop();controller=await createController(controllerOptions);},tick:()=>controller.tick()};
}

test('completed research supports repeated authorized assignments on one thread/worktree with immutable historical results',async t=>{
 const f=await fixture(t),initial=await f.create();await f.finish(initial,{message:'Research found the fixture needs an implementation.'});const research=await f.completed();
 const identity={threadId:research.threadId,worktree:research.worktree,workerPromptSnapshot:research.workerPromptSnapshot,environmentId:research.environment.id};
 const first=await f.followup('implement-after-research','Implement the agreed fixture file only.',research);
 const retry=await store.requestWorkerFollowup(f.state,first.args);assert.equal(retry.assignments.length,first.task.assignments.length,'exact retry creates no second assignment');
 await assert.rejects(store.requestWorkerFollowup(f.state,{...first.args,brief:'Different work'}),/changed|different|reused/i);
 const implementation=await f.active();assert.notEqual(implementation.runId,research.runId);assert.notEqual(implementation.currentAssignmentId,research.currentAssignmentId);assert.equal(implementation.result,null,'current run must not advertise the previous completed result');
 await assert.rejects(store.reportTask(f.state,f.taskId,research.runId,{reportId:'late-old-result',kind:'result',message:'Late research must not complete implementation.'}),/Stale/);
 await f.finish(implementation,{message:'Implementation complete.',write:'First authorized implementation.\n'});const implemented=await f.completed();
 const second=await f.followup('refine-after-implementation','Refine the same fixture file and preserve all earlier work.',implemented);const refinement=await f.active();await f.finish(refinement,{message:'Refinement complete.',write:'First authorized implementation.\nRefinement.\n'});const final=await f.completed();
 for(const task of [implementation,implemented,refinement,final]){assert.equal(task.threadId,identity.threadId);assert.equal(task.worktree,identity.worktree);assert.deepEqual(task.workerPromptSnapshot,identity.workerPromptSnapshot);assert.equal(task.environment.id,identity.environmentId);}
 assert.equal(await readFile(path.join(final.worktree,'.fixture/setup-count'),'utf8'),'1','setup never replays');assert.match(await readFile(path.join(final.worktree,'implementation.txt'),'utf8'),/Refinement/);
 assert.equal(final.assignments.length,3);assert.deepEqual(final.assignments.map(a=>a.status),['completed','completed','completed']);assert.deepEqual(final.assignments.map(a=>a.result.message),['Research found the fixture needs an implementation.','Implementation complete.','Refinement complete.']);
 for(const assignment of research.assignments||[store.currentAssignment(research)])assert.deepEqual(final.assignments.find(a=>a.id===assignment.id),assignment,'completed assignment is immutable');
 const rows=await f.calls(),turns=rows.filter(c=>c.method==='turn/start');assert.equal(rows.filter(c=>c.method==='thread/start').length,1);assert.equal(rows.filter(c=>c.method==='thread/resume').length,2);assert.equal(turns.length,3);assert.ok(rows.filter(c=>c.method==='thread/resume').every(c=>c.params.threadId===identity.threadId));for(const turn of turns)assert.equal(await realpath(turn.cwd),await realpath(identity.worktree));
 assert.match(turns[1].params.input[0].text,/Implement the agreed fixture file only/);assert.match(turns[1].params.input[0].text,/explicitly authorizes/);assert.match(turns[2].params.input[0].text,/Refine the same fixture file/);
 for(const task of [research,implemented,final]){const exit=JSON.parse(await readFile(path.join(task.runDir,'exit.json'),'utf8'));assert.deepEqual(exit.commands.map(c=>c.command),['node --version']);assert.notEqual(exit.finalMessage,'stale research reply');assert.equal(exit.threadId,identity.threadId);}
 assert.deepEqual(await listWorkerRequests({stateDir:f.state,taskId:f.taskId}),[],'old pre-ack approval never becomes a current actionable request');
 // Disposal cannot erase retained edits; the manager receives an actionable failure.
 await f.action('dispose');const denied=await wait(f.read,x=>x.lifecycleRequests.at(-1).status==='failed','dirty disposal refused');assert.match(denied.lifecycleRequests.at(-1).error,/changes|dirty/i);assert.equal(denied.status,'completed');assert.equal(denied.assignments.length,3);assert.equal(second.task.id,initial.id);
});

test('busy follow-up remains queued until natural completion; restart holds another queued assignment until explicit start',async t=>{
 const f=await fixture(t),initial=await f.create();const queued=await f.followup('busy-followup','Perform the next authorized read-only inspection.',initial);
 await f.tick();assert.equal((await f.read()).runId,initial.runId);assert.equal((await f.calls()).filter(c=>c.method==='turn/start').length,1);assert.equal(queued.task.assignments.at(-1).status,'queued');
 await f.finish(initial,{message:'Research completed before queued work.'});const next=await wait(f.read,x=>x.runId!==initial.runId&&x.progress==='Waiting at synthetic assignment boundary.','automatic queued follow-up');
 assert.equal(next.threadId,initial.threadId);assert.equal(next.worktree,initial.worktree);assert.equal(next.assignments[0].status,'completed');await f.finish(next,{message:'Queued follow-up complete.'});const completed=await f.completed();
 // Stop the controller to create persisted queued intent without a racing dispatch.
 await f.stopController();const pending=await f.followup('restart-followup','Inspect again after explicit restart confirmation.',completed);await f.restart();await f.tick();
 const held=await f.read();assert.equal(held.runId,completed.runId);assert.equal(held.assignments.at(-1).status,'queued');assert.equal((await f.calls()).filter(c=>c.method==='turn/start').length,2,'reopen does not dispatch backlog');
 await f.action('start');const restarted=await f.active();assert.equal(restarted.threadId,initial.threadId);assert.equal(restarted.worktree,initial.worktree);assert.notEqual(restarted.runId,completed.runId);
 await store.requestWorkerFollowup(f.state,pending.args);assert.equal((await f.read()).assignments.length,3,'retry after activation remains idempotent');await f.finish(restarted,{message:'Explicitly restarted assignment complete.'});const final=await f.completed();assert.equal(final.assignments.length,3);assert.equal(await readFile(path.join(final.worktree,'.fixture/setup-count'),'utf8'),'1');
 await f.action('dispose');const disposed=await wait(f.read,x=>x.status==='disposed','explicit disposal');assert.equal(disposed.assignments.length,3);await assert.rejects(f.followup('after-disposal','Unavailable resources must not be recreated.',disposed),/archived|disposed/i);await assert.rejects(readFile(path.join(final.worktree,'README.md')),{code:'ENOENT'});
});

test('a follow-up queued behind blocked work requires explicit recovery and preserves the previous assignment evidence',async t=>{
 const f=await fixture(t),initial=await f.create();await f.followup('blocked-followup','Continue with the authorized next inspection.',initial);await f.finish(initial,{kind:'blocked',message:'Need an explicit manager recovery decision.'});
 const blocked=await wait(f.read,x=>x.status==='blocked'&&x.execution?.live===false,'blocked terminal run');await f.tick();assert.equal((await f.read()).runId,initial.runId);assert.equal((await f.calls()).filter(c=>c.method==='turn/start').length,1,'blocked work never silently advances');
 await f.action('resume');const next=await f.active();assert.notEqual(next.runId,initial.runId);assert.equal(next.threadId,initial.threadId);assert.equal(next.worktree,initial.worktree);assert.ok(next.reports.some(r=>r.runId===initial.runId&&r.kind==='blocked'));assert.notEqual(next.currentAssignmentId,blocked.currentAssignmentId);
 await f.finish(next,{message:'Recovered follow-up complete.'});const final=await f.completed();assert.equal(final.assignments.length,2);assert.equal(final.assignments.at(-1).status,'completed');
});

test('admission reservation holds a completed worker follow-up without dispatch or scope activation',async t=>{
 const f=await fixture(t),initial=await f.create();await f.finish(initial,{message:'Initial inspection complete.'});const completed=await f.completed();f.setAdmissionHeld(true);await f.followup('reserved-followup','Inspect this fixture after the reservation ends.',completed);
 await f.tick();const held=await f.read();assert.equal(held.runId,completed.runId);assert.equal(held.currentAssignmentId,completed.currentAssignmentId||'initial');assert.equal(held.assignments.at(-1).status,'queued');assert.equal((await f.calls()).filter(c=>c.method==='turn/start').length,1);
 f.setAdmissionHeld(false);const next=await f.active();await f.finish(next,{message:'Admitted follow-up complete.'});const final=await f.completed();assert.equal(final.threadId,completed.threadId);assert.equal(final.worktree,completed.worktree);assert.equal(await readFile(path.join(final.worktree,'.fixture/setup-count'),'utf8'),'1');
});

test('missing retained worktree leaves actionable failure and never fabricates a replacement conversation or setup',async t=>{
 const f=await fixture(t),initial=await f.create();await f.finish(initial,{message:'Initial inspection complete.'});const completed=await f.completed();await rm(completed.worktree,{recursive:true});await f.followup('missing-worktree-followup','Inspect again only in the retained worktree.',completed);
 const failed=await wait(f.read,x=>x.failure||x.followupWait,'missing worktree failure');assert.match(failed.failure||failed.followupWait,/missing|worktree/i);assert.equal(failed.worktree,completed.worktree);assert.equal(failed.threadId,completed.threadId);assert.equal((await f.calls()).filter(c=>c.method==='turn/start').length,1);assert.equal(failed.assignments[0].status,'completed');assert.ok(failed.assignments[0].result.message);await assert.rejects(readFile(path.join(failed.worktree,'README.md')),{code:'ENOENT'});
});

test('unknown dirty changes hold queued follow-up until an exact fresh review is explicitly adopted',async t=>{
 const f=await fixture(t),initial=await f.create();await f.finish(initial,{message:'Research completion before external edit.'});const completed=await f.completed();await writeFile(path.join(completed.worktree,'external-note.txt'),'Unreviewed retained work.\n');
 const queued=await f.followup('dirty-review-followup','Inspect and preserve the externally changed note only after review.',completed);const held=await wait(f.read,x=>Boolean(x.followupWait),'unknown dirty follow-up held');assert.match(held.followupWait,/review|changed|changes|fingerprint/i);assert.equal(held.runId,completed.runId);assert.equal(held.assignments.at(-1).status,'queued');assert.equal((await f.calls()).filter(c=>c.method==='turn/start').length,1);
 const assignmentId=queued.task.assignments.at(-1).id,firstReview=await captureWorktreeEvidence(completed.worktree);assert.equal(firstReview.dirty,true);await writeFile(path.join(completed.worktree,'external-note.txt'),'Changed again after the first review.\n');
 const adoption={taskId:f.taskId,assignmentId,requestId:'obsolete-dirty-review',expectedRunId:completed.runId,fingerprint:firstReview.fingerprint,userDecision:'The human explicitly adopts the exact reviewed external note for this queued assignment.'};await store.requestWorkerFollowupAdoption(f.state,adoption);await f.tick();assert.equal((await f.read()).runId,completed.runId,'a stale reviewed fingerprint cannot authorize later changes');assert.equal((await f.calls()).filter(c=>c.method==='turn/start').length,1);
 const freshReview=await captureWorktreeEvidence(completed.worktree);assert.notEqual(freshReview.fingerprint,firstReview.fingerprint);const fresh={...adoption,requestId:'fresh-dirty-review',fingerprint:freshReview.fingerprint,userDecision:'The human reviewed the later edit and authorizes preserving this exact current note.'};await store.requestWorkerFollowupAdoption(f.state,fresh);const next=await f.active();assert.equal(next.threadId,completed.threadId);assert.equal(next.worktree,completed.worktree);assert.equal(next.currentAssignmentId,assignmentId);assert.equal(next.assignments.at(-1).adoptions.length,2);assert.equal(await readFile(path.join(next.worktree,'external-note.txt'),'utf8'),'Changed again after the first review.\n');
 await store.requestWorkerFollowupAdoption(f.state,fresh);assert.equal((await f.read()).assignments.at(-1).adoptions.length,2,'retry after activation remains idempotent');await f.finish(next,{message:'Reviewed dirty follow-up complete.'});const final=await f.completed();assert.equal(final.assignments[0].result.message,'Research completion before external edit.');assert.equal(final.assignments.at(-1).status,'completed');assert.equal(await readFile(path.join(final.worktree,'.fixture/setup-count'),'utf8'),'1');
});

test('edits followed by a question resume within the same assignment, while external edits after pause require adoption',async t=>{
 const f=await fixture(t),initial=await f.create();await f.finish(initial,{message:'Research complete.'});const research=await f.completed();await f.followup('interactive-implementation','Implement this fixture and ask the manager if a scoped decision is needed.',research);const implementation=await f.active();
 await f.finish(implementation,{write:'Known worker edit before question.\n',kind:'question',message:'Keep the existing first line when refining?'});const question=await wait(f.read,x=>x.status==='awaiting_answer'&&x.execution?.live===false,'question after retained edit');assert.equal(question.currentAssignmentId,implementation.currentAssignmentId);
 await store.answerQuestion(f.state,{taskId:f.taskId,questionId:'fixture-result',answer:'Yes. Preserve the existing line and continue this same authorized implementation.'});const answered=await f.active();assert.notEqual(answered.runId,question.runId);assert.equal(answered.currentAssignmentId,implementation.currentAssignmentId);assert.equal(answered.threadId,implementation.threadId);assert.equal(answered.worktree,implementation.worktree);assert.equal(await readFile(path.join(answered.worktree,'implementation.txt'),'utf8'),'Known worker edit before question.\n');
 await f.action('pause');const paused=await wait(f.read,x=>x.status==='paused'&&x.execution?.live===false,'confirmed pause');await writeFile(path.join(paused.worktree,'external-after-pause.txt'),'New external work after terminal evidence.\n');await f.action('resume');const held=await wait(f.read,x=>x.status==='failed'||x.lifecycleRequests.at(-1)?.status==='failed','external edit resume refusal');assert.match(held.failure||held.lifecycleRequests.at(-1).error,/review|changed|changes|fingerprint/i);assert.equal((await f.calls()).filter(c=>c.method==='turn/start').length,3);
 const reviewed=await captureWorktreeEvidence(paused.worktree);await store.requestWorkerFollowupAdoption(f.state,{taskId:f.taskId,assignmentId:implementation.currentAssignmentId,requestId:'paused-scope-adoption',expectedRunId:held.runId,fingerprint:reviewed.fingerprint,userDecision:'The user reviewed the external note after pause and authorizes preserving it within this same implementation assignment.'});await f.action('resume');const resumed=await f.active();assert.notEqual(resumed.runId,answered.runId);assert.equal(resumed.currentAssignmentId,implementation.currentAssignmentId);assert.equal(resumed.threadId,research.threadId);assert.equal(resumed.worktree,research.worktree);await f.finish(resumed,{message:'Interactive implementation complete.'});const final=await f.completed();assert.equal(final.assignments.length,2);assert.equal(final.assignments.at(-1).status,'completed');assert.equal(await readFile(path.join(final.worktree,'.fixture/setup-count'),'utf8'),'1');
});

test('external removal of known dirty work also requires adoption even though the retained worktree becomes clean',async t=>{
 const f=await fixture(t),initial=await f.create();await f.finish(initial,{message:'Research complete.'});const research=await f.completed();await f.followup('removal-test-implementation','Implement the agreed fixture file only.',research);const implementation=await f.active();await f.finish(implementation,{write:'Known worker implementation.\n',message:'Worker result retains an implementation file.'});const completed=await f.completed();await rm(path.join(completed.worktree,'implementation.txt'));const cleanReview=await captureWorktreeEvidence(completed.worktree);assert.equal(cleanReview.dirty,false);
 const queued=await f.followup('clean-removal-followup','Inspect the retained state after explicit review of removed work.',completed);const held=await wait(f.read,x=>Boolean(x.followupWait),'external removal held');assert.equal(held.runId,completed.runId);assert.equal((await f.calls()).filter(c=>c.method==='turn/start').length,2);await store.requestWorkerFollowupAdoption(f.state,{taskId:f.taskId,assignmentId:queued.task.assignments.at(-1).id,requestId:'clean-removal-adoption',expectedRunId:completed.runId,fingerprint:cleanReview.fingerprint,userDecision:'The user reviewed and explicitly accepts removal of the former worker file; continue with the exact current clean worktree.'});const next=await f.active();assert.equal(next.threadId,completed.threadId);assert.equal(next.worktree,completed.worktree);await f.finish(next,{message:'Reviewed clean-state follow-up complete.'});const final=await f.completed();assert.equal(final.assignments.length,3);assert.equal(final.assignments[1].result.message,'Worker result retains an implementation file.');await assert.rejects(readFile(path.join(final.worktree,'implementation.txt')),{code:'ENOENT'});
});


test('combined archive stops queued scope and history restore cannot launch it or retry setup',async t=>{
 const f=await fixture(t),initial=await f.create();await f.finish(initial,{message:'Result retained through archive.'});const completed=await f.completed();
 await f.stopController();await f.followup('archive-queued-followup','Retained new scope must not launch after history restore.',completed);await f.restart();
 await f.action('archive');const archived=await wait(f.read,x=>x.status==='disposed','confirmed archive');
 assert.equal(archived.assignments.at(-1).status,'stopped');assert.equal(archived.assignments[0].result.message,'Result retained through archive.');
 await store.manageArchivedTask(f.state,{taskId:f.taskId,action:'restore',operationId:'combined-archive-restore',expectedRevision:archived.revision},f.project);
 const restored=await f.read();assert.equal(restored.archiveRestoration.requiresRecovery,true);assert.equal(restored.status,'blocked');assert.deepEqual(restored.assignments,archived.assignments);
 await assert.rejects(f.followup('restored-new-followup','No reconstruction is authorized.',restored),/history only|archived/);
 for(const action of ['start','resume','retry_setup']){await f.action(action);const refused=await wait(f.read,x=>x.lifecycleRequests.at(-1).status==='failed','history-only '+action+' refused');assert.match(refused.lifecycleRequests.at(-1).error,/history only/);}
 // Older retained records may still carry queued intent. Even a stale terminal
 // label must not bypass the history-only guard in automatic follow-up admission.
 await store.updateTask(f.state,f.taskId,n=>{n.status='completed';n.assignments.at(-1).status='queued';delete n.assignments.at(-1).endedAt;});
 await f.tick();await f.restart();await f.tick();const held=await f.read();assert.equal(held.currentAssignmentId,archived.currentAssignmentId);assert.equal(held.assignments.at(-1).status,'queued');assert.equal(held.runId,initial.runId);
 assert.equal((await f.calls()).filter(c=>c.method==='turn/start').length,1);await assert.rejects(readFile(path.join(held.worktree,'README.md')),{code:'ENOENT'});
});

test('combined retained follow-up adopts corrected lifecycle commands only at explicit start after reopen',async t=>{
 const f=await fixture(t),initial=await f.create();await f.finish(initial,{message:'Original command plan complete.'});const completed=await f.completed();
 await f.stopController();const plan=f.project.worker.environment.executionPlan;
 plan.ready={command:JSON.stringify(process.execPath)+' -e '+JSON.stringify("require('node:fs').writeFileSync('.fixture/corrected-ready','applied')"),source:plan.setup.source,timeoutMs:10000};
 await f.followup('configured-lifecycle-followup','Inspect after explicitly starting with corrected Ready command.',completed);await f.restart();await f.tick();
 await assert.rejects(readFile(path.join(completed.worktree,'.fixture/corrected-ready')),{code:'ENOENT'});assert.equal((await f.calls()).filter(c=>c.method==='turn/start').length,1,'configuration and reopen execute no command or turn');
 await f.action('start');const next=await f.active();assert.equal(next.worktree,completed.worktree);assert.equal(next.threadId,completed.threadId);assert.equal(next.environment.id,completed.environment.id);
 assert.equal(await readFile(path.join(next.worktree,'.fixture/corrected-ready'),'utf8'),'applied');assert.equal(await readFile(path.join(next.worktree,'.fixture/setup-count'),'utf8'),'1');
 assert.equal(next.environment.originalPlan.ready,null);assert.ok(next.environment.planHistory.length);assert.ok(next.environment.hooks.some(h=>h.phase==='ready'&&h.status==='succeeded'&&h.configurationSource==='crew-settings'));
 await f.finish(next,{message:'Corrected lifecycle follow-up complete.'});const final=await f.completed();assert.equal(final.assignments.length,2);assert.equal(final.assignments[0].result.message,'Original command plan complete.');
});
