import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, chmod, realpath, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createTask, readTask, updateTask } from '../orchestration-store.mjs';
import { createController } from '../controller.mjs';
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
async function mockedCodex(base, fixture = false, edit = false) {
  const file = path.join(base, 'codex-mock.mjs');
  await writeFile(file, `#!/usr/bin/env node
import {execFileSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {reportTask} from ${JSON.stringify(new URL('../orchestration-store.mjs', import.meta.url).href)};
const args=process.argv.slice(2); const config=args.find(a=>a.startsWith('mcp_servers.local_orchestration.args='));
const [,state,,task,run]=JSON.parse(config.split('=').slice(1).join('='));
const worktree=process.cwd(); if (${edit}) writeFileSync('example.txt','edited\\n'); const output=execFileSync('git',['-C',worktree,'status','--porcelain'],{encoding:'utf8'});
console.log(JSON.stringify({type:'thread.started',thread_id:'mock-thread'}));
console.log(JSON.stringify({type:'item.completed',item:{type:'command_execution',command:'git status --porcelain',exit_code:0,aggregated_output:output}}));
if (${fixture}) console.log(JSON.stringify({type:'item.completed',item:{type:'command_execution',command:'node --input-type=module import totals.mjs',exit_code:0,aggregated_output:execFileSync(process.execPath,['--input-type=module','-e','import {sum} from \"./src/totals.mjs\";console.log(JSON.stringify({emptyActual:sum([]),sumActual:sum([1,2,3])}));'],{encoding:'utf8'})}}));
await reportTask(state,task,run,{reportId:'result',kind:'result',message:'Audit complete',evidence:${fixture ? JSON.stringify([JSON.stringify({emptyActual:1,sumActual:7,emptyExpected:0,sumExpected:6,finding:'initial_value_one'})]) : JSON.stringify(['Actual git status command succeeded; no semantic tests performed.'])}});
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Audit complete'}}));
console.log(JSON.stringify({type:'turn.completed'}));
`); await chmod(file, 0o700); return file;
}
async function terminal(controller, state, id) {
  for (let count=0; count<100; count++) {
    await controller.tick(); const task=await readTask(state,id);
    if (['failed','completed'].includes(task.status)) return task;
    await new Promise(r=>setTimeout(r,50));
  }
  throw new Error('Timeout waiting for controller');
}
test('repository worker executes in a durable isolated worktree and verification states its limits', async () => {
  const base=await mkdtemp(path.join(os.tmpdir(),'ai006-workers-')); const repo=await repository(base); const state=path.join(base,'state');
  await createTask(state,{requestId:'repository-test-1',ticket:'EX-12',brief:'Inspect only',projectId:'example',repositoryId:'app'});
  const controller=await createController({stateDir:state,sourceDir,executable:await mockedCodex(base),project:profile(repo),workerPrompt:'Be precise.'});
  try {
    const task=await terminal(controller,state,'repository-test-1');
    assert.equal(task.status,'completed',task.failure); assert.equal(task.projectId,'example');
    assert.equal(task.worktree,path.join(state,'worktrees',task.id));
    assert.notEqual(await realpath(task.worktree),await realpath(repo));
    assert.equal(task.result.verification.semanticCorrectnessVerified,false); assert.equal(task.result.verification.clean,true);
    const run=JSON.parse(await readFile(path.join(task.runDir,'config.json'),'utf8'));
    assert.equal(run.workerPrompt,'Be precise.');assert.equal(run.timeoutMs,10000);assert.equal(run.sandbox,'read-only');
    assert.equal((await exec('git',['-C',repo,'status','--porcelain'])).stdout,'');
  } finally {await controller.stop();}
});
test('incomplete configuration fails before creating a worktree',async()=>{
  const base=await mkdtemp(path.join(os.tmpdir(),'ai006-notready-')); const state=path.join(base,'state');
  await createTask(state,{requestId:'incomplete-test',ticket:'EX-1',brief:'Inspect',projectId:'example',repositoryId:'app'});
  const project=profile(null);project.readiness={ready:false,issues:['Set repository path']};
  const controller=await createController({stateDir:state,sourceDir,executable:'/unused',project});
  try {const task=await readTask(state,'incomplete-test');assert.equal(task.status,'failed');assert.match(task.failure,/incomplete/);assert.equal(task.worktree,undefined);} finally {await controller.stop();}
});
test('task project and repository identity are immutable and dedupe includes scope',async()=>{
  const state=await mkdtemp(path.join(os.tmpdir(),'ai006-store-'));
  const request={requestId:'immutable-test',ticket:'EX-1',brief:'Inspect',projectId:'example',repositoryId:'app'};
  await createTask(state,request);assert.equal((await createTask(state,request)).revision,1);
  await assert.rejects(createTask(state,{...request,projectId:'other'}),/Request ID/);
  await assert.rejects(updateTask(state,request.requestId,t=>{t.repositoryId='other';}),/immutable/);
  const controller=await createController({stateDir:state,sourceDir,executable:'/unused',project:{...profile(null),id:'other'}});
  try {assert.match((await controller.view()).error,/another project/);assert.equal((await readTask(state,request.requestId)).status,'queued');} finally {await controller.stop();}
});
async function mcp(state, runtime, name, args) {
  const { spawn } = await import('node:child_process');
  const child=spawn(process.execPath,[path.join(sourceDir,'orchestration-mcp.mjs'),state,'manager',runtime]);
  let output='';child.stdout.on('data',chunk=>output+=chunk);let stderr='';child.stderr.on('data',chunk=>stderr+=chunk);
  child.stdin.end(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})+'\n');
  const code=await new Promise(resolve=>child.on('close',resolve));assert.equal(code,0,stderr);
  return JSON.parse(output.trim()).result;
}
test('manager MCP rejects incomplete profiles, wrong repository and wrong team ticket',async()=>{
  const base=await mkdtemp(path.join(os.tmpdir(),'ai006-mcp-'));const state=path.join(base,'state');const runtime=path.join(base,'runtime.json');
  const project=profile('/unused');await writeFile(runtime,JSON.stringify({project,workerPrompt:'Precise'}));
  const request={requestId:'mcp-request-1',ticket:'EX-12',brief:'Inspect',repositoryId:'app'};
  assert.equal((await mcp(state,runtime,'submit_task',{...request,repositoryId:'unknown'})).isError,true);
  assert.equal((await mcp(state,runtime,'submit_task',{...request,ticket:'OTHER-12'})).isError,true);
  assert.equal((await mcp(state,runtime,'submit_task',{...request,repositoryId:undefined})).isError,true);
  project.readiness={ready:false,issues:['Unset repository path']};await writeFile(runtime,JSON.stringify({project}));
  const rejected=await mcp(state,runtime,'submit_task',request);assert.match(rejected.content[0].text,/Unset repository path/);
  project.readiness={ready:true,issues:[]};await writeFile(runtime,JSON.stringify({project}));
  const result=await mcp(state,runtime,'submit_task',request);assert.equal(result.isError,undefined);
  const task=await readTask(state,request.requestId);assert.equal(task.projectId,'example');assert.equal(task.repositoryId,'app');assert.equal(task.status,'queued');
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

test('resume refuses changed sandbox without creating another run or supervisor',async()=>{
  const base=await mkdtemp(path.join(os.tmpdir(),'ai006-sandbox-'));const repo=await repository(base);const state=path.join(base,'state');const project=profile(repo);
  await createTask(state,{requestId:'sandbox-resume-test',ticket:'EX-3',brief:'Read-only inspection',projectId:project.id,repositoryId:'app'});
  const controller=await createController({stateDir:state,sourceDir,executable:await mockedCodex(base),project});
  try {
    const prior=await terminal(controller,state,'sandbox-resume-test');assert.equal(prior.status,'completed',prior.failure);
    await updateTask(state,prior.id,task=>{task.status='resume_queued';task.answer={text:'Continue the same scope'};});
    project.worker.sandbox='workspace-write';
    await controller.tick();const task=await readTask(state,prior.id);
    assert.equal(task.status,'failed');assert.match(task.failure,/sandbox configuration changed/);
    assert.equal(task.runId,prior.runId);assert.equal(task.runnerPid,prior.runnerPid);
    assert.deepEqual(await readdir(path.join(state,'runs',task.id)),[prior.runId]);
    assert.equal(task.workerSandbox,'read-only');
  }finally{await controller.stop();}
});
