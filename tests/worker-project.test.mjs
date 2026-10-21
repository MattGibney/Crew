import {workerAppServerFixture} from './helpers/worker-app-server-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, chmod, realpath, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createTask, readTask, updateTask, answerQuestion, requestWorkerAction } from '../orchestration-store.mjs';
import { createController } from '../controller.mjs';
import { promptSnapshot } from '../prompt-settings.mjs';
const exec = promisify(execFile);
const sourceDir = fileURLToPath(new URL('../', import.meta.url));
async function repository(base) {
  const repo = path.join(base, 'source'); await mkdir(repo);
  await exec('git', ['init', '-b', 'main', repo]);
  await writeFile(path.join(repo, 'example.txt'), 'original\n');
  await exec('git', ['-C', repo, 'add', '.']);
  await exec('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@localhost.invalid', 'commit', '-m', 'Fixture']);
  return repo;
}
function profile(repo) { return { id: 'example', name: 'Example', mode: 'repository', context: 'Example context', repositories: [{ id: 'app', path: repo, baseRef: 'main' }], linear: { teamKey: 'EX' }, worker: { sandbox: 'read-only', timeoutMs: 10000 }, readiness: { ready: true, issues: [] } }; }
async function mockedCodex(base, fixture = false, edit = false, {finalMessage=true,durableResult=true} = {}) {
  const file = path.join(base, 'codex-mock.mjs');
  await writeFile(file, workerAppServerFixture(`#!/usr/bin/env node
import {execFileSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {reportTask} from ${JSON.stringify(new URL('../orchestration-store.mjs', import.meta.url).href)};
const args=process.argv.slice(2); const config=args.find(a=>a.startsWith('mcp_servers.local_orchestration.args='));
const [,state,,task,run]=JSON.parse(config.split('=').slice(1).join('='));
const worktree=process.cwd(); if (${edit}) writeFileSync('example.txt','edited\\n'); const output=execFileSync('git',['-C',worktree,'status','--porcelain'],{encoding:'utf8'});
console.log(JSON.stringify({type:'thread.started',thread_id:'mock-thread'}));
console.log(JSON.stringify({type:'item.completed',item:{type:'command_execution',command:'git status --porcelain',exit_code:0,aggregated_output:output}}));
if (${fixture}) console.log(JSON.stringify({type:'item.completed',item:{type:'command_execution',command:'node --input-type=module import totals.mjs',exit_code:0,aggregated_output:execFileSync(process.execPath,['--input-type=module','-e','import {sum} from \"./src/totals.mjs\";console.log(JSON.stringify({emptyActual:sum([]),sumActual:sum([1,2,3])}));'],{encoding:'utf8'})}}));
if(${durableResult})await reportTask(state,task,run,{reportId:'result',kind:'result',message:'Audit complete',evidence:${fixture ? JSON.stringify([JSON.stringify({emptyActual:1,sumActual:7,emptyExpected:0,sumExpected:6,finding:'initial_value_one'})]) : JSON.stringify(['Actual git status command succeeded; no semantic tests performed.'])}});
if(${finalMessage})console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Audit complete'}}));
console.log(JSON.stringify({type:'turn.completed'}));
`)); await chmod(file, 0o700); return file;
}
// tick schedules launches independently so unrelated workers are never held behind one startup.
// Wait for the observed durable outcome, preserving the original failure/safety assertions.
async function waitFor(controller, observe, predicate, description='controller outcome', timeoutMs=20000) {
  // Parallel suite execution can take >5s to launch, stop owned descendants and
  // verify a successful mock harness. Keep polling bounded without weakening
  // the worker's own 10s runtime limit or any terminal/safety assertions.
  const deadline=Date.now()+timeoutMs; let lastObserved;
  while(Date.now()<deadline){
    await controller.tick();const value=await observe(); lastObserved=value;
    if(predicate(value))return value;
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  throw new Error(`Timeout waiting for ${description}; last observed status: ${lastObserved?.status || 'unavailable'}${lastObserved?.failure ? ` (${lastObserved.failure})` : ''}`);
}
async function terminal(controller, state, id) {
  const current=await readTask(state,id);
  if(current.status==='queued'){
    await requestWorkerAction(state,{taskId:id,actionId:`explicit-start-${id}`,action:'start',expectedRunId:current.runId||null});
  }
  return waitFor(controller,()=>readTask(state,id),task=>['failed','completed'].includes(task.status),`terminal task ${id}`);
}
test('repository worker executes in a durable isolated worktree and verification states its limits', async () => {
  const base=await mkdtemp(path.join(os.tmpdir(),'ai006-workers-')); const repo=await repository(base); const state=path.join(base,'state');
  await createTask(state,{requestId:'repository-test-1',ticket:'EX-12',brief:'Inspect only',projectId:'example',repositoryId:'app'});
  const controller=await createController({stateDir:state,sourceDir,executable:await mockedCodex(base),project:profile(repo),workerPrompt:'Be precise.'});
  try {
    const task=await terminal(controller,state,'repository-test-1');
    assert.equal(task.status,'completed',task.failure); assert.equal(task.projectId,'example');
    assert.match(task.worktreeName,/^crew-[a-f0-9]{32}$/);
    assert.equal(task.worktreeName.length,37);
    assert.equal(task.worktree,await realpath(path.join(state,'worktrees',task.worktreeName)));
    assert.notEqual(await realpath(task.worktree),await realpath(repo));
    assert.equal(task.result.verification.semanticCorrectnessVerified,false); assert.equal(task.result.verification.clean,true);
    const run=JSON.parse(await readFile(path.join(task.runDir,'config.json'),'utf8'));
    assert.equal(run.workerPrompt,'Be precise.');assert.equal(run.agentOwnedEnvironment,true);assert.equal(run.timeoutMs,undefined);assert.equal(run.sandbox,undefined);
    assert.equal((await exec('git',['-C',repo,'status','--porcelain'])).stdout,'');
  } finally {await controller.stop();}
});
test('incomplete configuration fails before creating a worktree',async()=>{
  const base=await mkdtemp(path.join(os.tmpdir(),'ai006-notready-')); const state=path.join(base,'state');
  await createTask(state,{requestId:'incomplete-test',ticket:'EX-1',brief:'Inspect',projectId:'example',repositoryId:'app'});
  const project=profile(null);project.readiness={ready:false,issues:['Set repository path']};
  const controller=await createController({stateDir:state,sourceDir,executable:'/unused',project});
  try {const task=await terminal(controller,state,'incomplete-test');assert.equal(task.status,'failed');assert.match(task.failure,/repository path and baseRef/);assert.equal(task.worktree,undefined);} finally {await controller.stop();}
});
test('task project and repository identity are immutable and dedupe includes scope',async()=>{
  const state=await mkdtemp(path.join(os.tmpdir(),'ai006-store-'));
  const request={requestId:'immutable-test',ticket:'EX-1',brief:'Inspect',projectId:'example',repositoryId:'app'};
  await createTask(state,request);assert.equal((await createTask(state,request)).revision,1);
  await assert.rejects(createTask(state,{...request,projectId:'other'}),/Request ID/);
  await assert.rejects(updateTask(state,request.requestId,t=>{t.repositoryId='other';}),/immutable/);
  const controller=await createController({stateDir:state,sourceDir,executable:'/unused',project:{...profile(null),id:'other'}});
  try {const view=await waitFor(controller,()=>controller.view(),v=>typeof v.error==='string'&&/another project/.test(v.error),'project mismatch error');assert.match(view.error,/another project/);assert.equal((await readTask(state,request.requestId)).status,'queued');} finally {await controller.stop();}
});
async function mcp(state, runtime, name, args) {
  const { spawn } = await import('node:child_process');
  const child=spawn(process.execPath,[path.join(sourceDir,'orchestration-mcp.mjs'),state,'manager',runtime]);
  let output='';child.stdout.on('data',chunk=>output+=chunk);let stderr='';child.stderr.on('data',chunk=>stderr+=chunk);
  child.stdin.end(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})+'\n');
  const code=await new Promise(resolve=>child.on('close',resolve));assert.equal(code,0,stderr);
  return JSON.parse(output.trim()).result;
}
test('manager MCP preserves repository identity without readiness or ticket workflow gates',async()=>{
  const base=await mkdtemp(path.join(os.tmpdir(),'crew-mcp-identity-')),state=path.join(base,'state'),runtime=path.join(base,'runtime.json');
  const project=profile('/unused');project.readiness={ready:false,issues:['Environment has not been prepared']};await writeFile(runtime,JSON.stringify({project}));
  const request={requestId:'mcp-request-1',ticket:'CUSTOM-12',brief:'Inspect',repositoryId:'app'};
  assert.equal((await mcp(state,runtime,'submit_task',{...request,repositoryId:'unknown'})).isError,true);
  assert.equal((await mcp(state,runtime,'submit_task',{...request,repositoryId:undefined})).isError,true);
  assert.equal((await mcp(state,runtime,'submit_task',request)).isError,undefined);
  const task=await readTask(state,request.requestId);assert.equal(task.projectId,'example');assert.equal(task.repositoryId,'app');assert.equal(task.ticket,'CUSTOM-12');assert.equal(task.status,'queued');
});
test('legacy fixture baseline still independently checks actual totals',async()=>{
  const base=await mkdtemp(path.join(os.tmpdir(),'ai006-fixture-'));const state=path.join(base,'state');
  await createTask(state,{requestId:'legacy-fixture-1',ticket:'AI-004',brief:'Audit totals'});
  const controller=await createController({stateDir:state,sourceDir,executable:await mockedCodex(base,true)});
  try {const task=await terminal(controller,state,'legacy-fixture-1');assert.equal(task.status,'completed',task.failure);assert.equal(task.result.verification.findingMatched,true);assert.deepEqual(task.result.verification.expected,{empty:0,oneTwoThree:6});}finally{await controller.stop();}
});
test('workspace-write records local changes while preserving original repository',async()=>{
  const base=await mkdtemp(path.join(os.tmpdir(),'ai006-edits-'));const repo=await repository(base);const state=path.join(base,'state');
  const project=profile(repo);project.worker.sandbox='workspace-write';
  await createTask(state,{requestId:'local-edit-test',ticket:'EX-2',brief:'Edit example.txt locally',projectId:project.id,repositoryId:'app'});
  const controller=await createController({stateDir:state,sourceDir,executable:await mockedCodex(base,false,true),project});
  try{const task=await terminal(controller,state,'local-edit-test');assert.equal(task.status,'completed',task.failure);assert.equal(task.result.verification.clean,false);assert.match(task.result.verification.changedFiles.join('\n'),/example.txt/);assert.equal(await readFile(path.join(repo,'example.txt'),'utf8'),'original\n');}finally{await controller.stop();}
});

test('resume preserves context when Crew sandbox metadata changes; native policy remains authoritative',async()=>{
  const base=await mkdtemp(path.join(os.tmpdir(),'crew-native-policy-')),repo=await repository(base),state=path.join(base,'state'),project=profile(repo);
  await createTask(state,{requestId:'sandbox-resume-test',ticket:'EX-3',brief:'Inspect',projectId:project.id,repositoryId:'app'});
  const controller=await createController({stateDir:state,sourceDir,executable:await mockedCodex(base),project});
  try{const prior=await terminal(controller,state,'sandbox-resume-test');assert.equal(prior.status,'completed',prior.failure);
    project.worker.sandbox='workspace-write';await updateTask(state,prior.id,n=>{n.status='resume_queued';n.answer={text:'Continue'};});
    const task=await terminal(controller,state,prior.id);assert.equal(task.status,'completed',task.failure);assert.notEqual(task.runId,prior.runId);assert.equal(task.threadId,prior.threadId);assert.equal(task.worktree,prior.worktree);
    const config=JSON.parse(await readFile(path.join(task.runDir,'config.json'),'utf8'));assert.equal(config.sandbox,undefined);assert.equal(config.threadId,prior.threadId);
  }finally{await controller.stop();}
});

test('native completion retains durable report or final reply without setting workflow state',async()=>{
 for(const resultOnly of [true,false]){
  const base=await mkdtemp(path.join(os.tmpdir(),'crew-terminal-contract-')),repo=await repository(base),state=path.join(base,'state'),id=resultOnly?'worker-result-only':'worker-no-result';await createTask(state,{requestId:id,ticket:'EX-12',brief:'Verify terminal evidence without invented final text',projectId:'example',repositoryId:'app'});
  const controller=await createController({stateDir:state,sourceDir,executable:await mockedCodex(base,false,false,{finalMessage:!resultOnly,durableResult:resultOnly}),project:profile(repo)});
  try{const task=await terminal(controller,state,id),exit=JSON.parse(await readFile(path.join(task.runDir,'exit.json'),'utf8'));assert.equal(exit.exitCode,0);assert.equal(exit.completedTurn,true);assert.equal(exit.stopConfirmed,true);if(resultOnly){assert.equal(task.status,'completed',task.failure);assert.equal(task.result.message,'Audit complete');assert.equal(task.result.finalMessage,'');assert.equal(exit.finalMessage,'');assert.equal(task.result.verification.semanticCorrectnessVerified,false);assert.equal(task.result.verification.clean,true);}else{assert.equal(task.status,'completed',task.failure);assert.ok(task.result.message);assert.equal(task.workflowState,undefined);assert.equal(task.reports.length,0);}}
  finally{await controller.stop();}
 }
});

test('worker directions use current saved instructions and retain original run snapshots', async () => {
  const base=await mkdtemp(path.join(os.tmpdir(),'crew-prompt-workers-')),repo=await repository(base),state=path.join(base,'state');
  const executable=path.join(base,'prompt-codex.mjs');
  await writeFile(executable,workerAppServerFixture(`#!/usr/bin/env node
import {execFileSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import path from 'node:path';
import {reportTask} from ${JSON.stringify(new URL('../orchestration-store.mjs', import.meta.url).href)};
const args=process.argv.slice(2),raw=args.find(a=>a.startsWith('mcp_servers.local_orchestration.args='));
const [,state,,task,run]=JSON.parse(raw.slice(raw.indexOf('=')+1));
writeFileSync(path.join(state,run+'-prompt.txt'),args.at(-1));
console.log(JSON.stringify({type:'thread.started',thread_id:'snapshot-thread'}));
console.log(JSON.stringify({type:'item.completed',item:{type:'command_execution',command:'git status --porcelain',exit_code:0,aggregated_output:execFileSync('git',['status','--porcelain'],{encoding:'utf8'})}}));
await reportTask(state,task,run,{reportId:'report',kind:args.includes('resume')?'result':'question',message:args.includes('resume')?'Complete':'Which option?',evidence:[]});
console.log(JSON.stringify({type:'turn.completed'}));
`));await chmod(executable,0o700);
  let current='ORIGINAL_CUSTOM_WORKER',reads=0;
  const controller=await createController({stateDir:state,sourceDir,executable,project:profile(repo),getWorkerPrompt:async()=>{reads++;return promptSnapshot(current);}});
  try {
    await createTask(state,{requestId:'prompt-snapshot-task',ticket:'EX-81',brief:'Inspect only',projectId:'example',repositoryId:'app'});
    const waiting=await waitFor(controller,()=>readTask(state,'prompt-snapshot-task'),task=>task.status==='awaiting_answer');
    const launchedPrompt=await readFile(path.join(state,waiting.runId+'-prompt.txt'),'utf8');
    assert.ok(launchedPrompt.startsWith('ORIGINAL_CUSTOM_WORKER\n'));
    assert.doesNotMatch(launchedPrompt,/You are the ONE|Inspect actual files|Give one useful progress/);
    assert.equal(waiting.workerPromptSnapshot.text,current);
    const originalConfig=JSON.parse(await readFile(path.join(waiting.runDir,'config.json'),'utf8'));assert.equal(originalConfig.workerPrompt,'ORIGINAL_CUSTOM_WORKER');
    current='NEW_CUSTOM_WORKER';
    await answerQuestion(state,{taskId:waiting.id,questionId:waiting.question.id,answer:'Proceed'});
    const completed=await terminal(controller,state,waiting.id);
    assert.equal(completed.status,'completed',completed.failure);
    const resumed=JSON.parse(await readFile(path.join(completed.runDir,'config.json'),'utf8'));
    assert.equal(resumed.workerPrompt,'NEW_CUSTOM_WORKER');
    assert.equal(resumed.workerPromptVersion,promptSnapshot('NEW_CUSTOM_WORKER').version);
    assert.equal(reads,2);
    await createTask(state,{requestId:'prompt-snapshot-next',ticket:'EX-82',brief:'Inspect next',projectId:'example',repositoryId:'app'});
    const next=await waitFor(controller,()=>readTask(state,'prompt-snapshot-next'),task=>task.status==='awaiting_answer');
    assert.equal(next.workerPromptSnapshot.text,'NEW_CUSTOM_WORKER'); assert.equal(reads,3);
    assert.ok((await readFile(path.join(state,next.runId+'-prompt.txt'),'utf8')).startsWith('NEW_CUSTOM_WORKER\n'));
  } finally {await controller.stop();}
});

test('cooperative update pause verifies an already-finished durable result instead of preparing a duplicate run',async t=>{
 const base=await mkdtemp(path.join(os.tmpdir(),'crew-finished-pause-')),repo=await repository(base),state=path.join(base,'state'),id='worker-finished-before-pause',project=profile(repo),executable=await mockedCodex(base);
 await createTask(state,{requestId:id,ticket:'EX-12',brief:'Inspect only',projectId:project.id,repositoryId:'app'});let controller=await createController({stateDir:state,sourceDir,executable,project});
 t.after(async()=>{await controller.stop();});
 await requestWorkerAction(state,{taskId:id,actionId:'explicit-start-finished-pause',action:'start'});
 // Stop this controller once the detached harness owns its run. Await the
 // real durable terminal directly: this test needs the pre-verification window,
 // not an extra completion/reconciliation pass before recreating that window.
 const first=await waitFor(controller,()=>readTask(state,id),task=>task.harnessStarted===true,'owned harness before terminal');await controller.stop();
 const terminalExit=await waitFor(controller,async()=>{try{return JSON.parse(await readFile(path.join(first.runDir,'exit.json'),'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}},exit=>exit?.runId===first.runId&&exit.stopConfirmed===true,'actual matching terminal before cooperative pause',30000);
 // Recreate the deterministic window after durable result/terminal publication,
 // before the next controller verification tick. The actual command/exit data is retained.
 await updateTask(state,id,n=>{n.status='verifying';delete n.result;n.handledReports=[];});
 await requestWorkerAction(state,{taskId:id,actionId:'update-pause-finished',action:'pause',cooperative:true,expectedRunId:first.runId});
 controller=await createController({stateDir:state,sourceDir,executable,project,admissionHeld:async()=>true});
 try{const done=await readTask(state,id);assert.equal(done.status,'completed');assert.equal(done.result.message,'Audit complete');assert.equal(done.runId,first.runId);assert.equal(done.threadId,terminalExit.threadId);assert.equal(done.lifecycleRequests.at(-1).status,'completed');assert.equal(done.result.verification.clean,true);}
 finally{await controller.stop();}
});

test('capacity denial never annotates retained history after a queued task changes during admission',async t=>{
 const base=await mkdtemp(path.join(os.tmpdir(),'crew-capacity-stale-')),state=path.join(base,'state'),project={id:'stale-capacity',mode:'fixture',worker:{maxConcurrent:1},readiness:{ready:true}},id='becomes-retained';
 await createTask(state,{requestId:'unknown-owned-run',ticket:'AI-018',brief:'Retain uncertain ownership',projectId:project.id});
 await updateTask(state,'unknown-owned-run',n=>{n.status='failed';n.harnessStarted='pending';n.runId='retained-unconfirmed';n.runDir=path.join(state,'runs',n.id,n.runId);});
 let captured;const controller=await createController({stateDir:state,sourceDir,executable:process.execPath,project,admissionHeld:async({taskId})=>{if(taskId===id&&!captured)captured=await updateTask(state,id,n=>{n.status='failed';});return false;}});t.after(()=>controller.stop());
 await createTask(state,{requestId:id,ticket:'AI-018',brief:'Queued before the admission observation',projectId:project.id});
 await waitFor(controller,()=>readTask(state,id),n=>captured&&n.status==='failed','state changes before capacity denial');await controller.tick();assert.deepEqual(await readTask(state,id),captured);assert.equal(captured.capacityWait,undefined);
});
