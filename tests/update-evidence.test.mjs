import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { inspectUpdateEvidence } from '../runtime/update-evidence.mjs';
import { snapshotProcesses } from '../runtime/process-ownership.mjs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const processIdentity = (pid = 98112) => ({ pid, ppid:1, start:'Wed Oct 21 12:00:00 2026', commandHash:'a'.repeat(64) });
const row = value => ({ ...value, state:'S' });
async function fixture(t) {
 const stateDir = await mkdtemp(path.join(tmpdir(), 'crew-update-evidence-'));
 t.after(() => rm(stateDir, { recursive:true, force:true }));
 const id='update-test-task', runId=randomUUID(), hookId=randomUUID(), runtimeId=randomUUID(), environmentId=`crew-${'b'.repeat(32)}`;
 const worktree=path.join(stateDir,'retained-worktree');await mkdir(worktree);await writeFile(path.join(worktree,'partial.txt'),'retained partial work');
 const runDir=path.join(stateDir,'runs',id,runId), hookDir=path.join(stateDir,'runs',id,'environment',hookId), runtimeDir=path.join(stateDir,'runs',id,'project-runtime',runtimeId);
 const environment={id:environmentId,kind:'project-execution',taskId:id,worktree,status:'failed',hooks:[{id:hookId,phase:'setup',status:'failed',runDir:hookDir}],runtime:{id:runtimeId,status:'stopped',runDir:runtimeDir}};
 const task={id,runId,runDir,status:'failed',harnessStarted:true,worktree,environment};
 const save=async(file,value)=>{await mkdir(path.dirname(file),{recursive:true});await writeFile(file,JSON.stringify(value));};
 const envFile=path.join(stateDir,'runs',id,'environment.json');await save(envFile,environment);
 return {stateDir,id,runId,hookId,runtimeId,environmentId,task,environment,save,envFile,runDir,hookDir,runtimeDir};
}
async function confirmed(f) {
 await f.save(path.join(f.runDir,'exit.json'),{runId:f.runId,stopConfirmed:true,ownership:{tracked:[],remaining:[]},exitCode:1});
 await f.save(path.join(f.hookDir,'exit.json'),{id:f.hookId,confirmed:true,status:'failed',exitCode:1,remaining:[]});
 await f.save(path.join(f.runtimeDir,'exit.json'),{id:f.runtimeId,environmentId:f.environmentId,stopConfirmed:true,exitCode:1,remaining:[]});
}
const inspect=(f,processes=new Map())=>inspectUpdateEvidence({stateDir:f.stateDir,view:{tasks:[f.task]},processes});
async function treeHash(root) {
 const hashes=[];
 async function walk(dir){for(const entry of await readdir(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isDirectory())await walk(file);else if(entry.isFile())hashes.push([file,createHash('sha256').update(await readFile(file)).digest('hex')]);}}
 await walk(root);return hashes.sort((a,b)=>a[0].localeCompare(b[0]));
}

test('confirmed failed setup/runtime and retained worktree are stopped evidence without mutating any file or view',async t=>{
 const f=await fixture(t);await confirmed(f);const original=structuredClone(f.task),before=await treeHash(f.stateDir);
 const unrelated=row(processIdentity(77991));const result=await inspect(f,new Map([[unrelated.pid,unrelated]]));
 assert.deepEqual(result.tasks[0].updateEvidence,{worker:'stopped',hooks:[{id:f.hookId,phase:'setup',state:'stopped'}],runtime:'stopped'});
 assert.deepEqual(f.task,original);assert.deepEqual(await treeHash(f.stateDir),before);
 assert.equal(await readFile(path.join(f.task.worktree,'partial.txt'),'utf8'),'retained partial work');
});

test('a freshly observed owned hook process overrides its confirmed terminal file',async t=>{
 const f=await fixture(t);await confirmed(f);const owned=processIdentity();await f.save(path.join(f.hookDir,'ownership.json'),{id:f.hookId,records:[owned]});
 const result=await inspect(f,new Map([[owned.pid,row(owned)]]));assert.equal(result.tasks[0].updateEvidence.hooks[0].state,'live');
});

test('worker and runtime fresh owned processes override terminal reports too',async t=>{
 const f=await fixture(t);await confirmed(f);const worker=processIdentity(),runtime=processIdentity(98113);
 await f.save(path.join(f.runDir,'owner.json'),{runId:f.runId,supervisorPid:worker.pid,supervisorIdentity:worker});
 await f.save(path.join(f.runtimeDir,'started.json'),{id:f.runtimeId,environmentId:f.environmentId,pid:runtime.pid,identity:runtime});
 const evidence=(await inspect(f,new Map([[worker.pid,row(worker)],[runtime.pid,row(runtime)]]))).tasks[0].updateEvidence;
 assert.equal(evidence.worker,'live');assert.equal(evidence.runtime,'live');
});

test('failed status and missing PIDs never replace missing confirmed exit evidence',async t=>{
 const f=await fixture(t);const result=await inspect(f);assert.equal(result.tasks[0].updateEvidence.worker,'unknown');assert.equal(result.tasks[0].updateEvidence.runtime,'unknown');assert.equal(result.tasks[0].updateEvidence.hooks[0].state,'unknown');
});

test('confirmed old process exit permits unrelated PID reuse; same-start command changes stay unknown',async t=>{
 const f=await fixture(t);await confirmed(f);const owned=processIdentity();await f.save(path.join(f.hookDir,'ownership.json'),{id:f.hookId,records:[owned]});
 assert.equal((await inspect(f,new Map([[owned.pid,{...row(owned),commandHash:'c'.repeat(64)}]]))).tasks[0].updateEvidence.hooks[0].state,'unknown');
 assert.equal((await inspect(f,new Map([[owned.pid,{...row(owned),start:'different-start'}]]))).tasks[0].updateEvidence.hooks[0].state,'stopped');
 await rm(path.join(f.hookDir,'exit.json'));
 assert.equal((await inspect(f,new Map([[owned.pid,{...row(owned),start:'different-start'}]]))).tasks[0].updateEvidence.hooks[0].state,'unknown');
});

test('run/environment ownership mismatch and arbitrary saved paths stay unknown',async t=>{
 const f=await fixture(t);await confirmed(f);await f.save(path.join(f.runDir,'exit.json'),{runId:randomUUID(),stopConfirmed:true});
 await f.save(path.join(f.runtimeDir,'exit.json'),{id:f.runtimeId,environmentId:'foreign-environment',stopConfirmed:true});
 const evidence=(await inspect(f)).tasks[0].updateEvidence;assert.equal(evidence.worker,'unknown');assert.equal(evidence.runtime,'unknown');
 f.task.runDir=path.join(f.stateDir,'untrusted-external');assert.equal((await inspect(f)).tasks[0].updateEvidence.worker,'unknown');
 f.environment.worktree='foreign-worktree';await f.save(f.envFile,f.environment);assert.equal((await inspect(f)).tasks[0].updateEvidence.runtime,'unknown');
});

test('unstarted workers are absent, but spawn intent and failed snapshots remain uncertain',async t=>{
 const f=await fixture(t);f.task.harnessStarted=false;f.task.environment=null;await rm(f.envFile);
 assert.deepEqual((await inspect(f)).tasks[0].updateEvidence,{worker:'absent',hooks:[],runtime:'absent'});
 f.task.spawnIntentAt=new Date().toISOString();assert.equal((await inspect(f)).tasks[0].updateEvidence.worker,'unknown');
 const result=await inspectUpdateEvidence({stateDir:f.stateDir,view:{tasks:[f.task]},processes:async()=>{throw new Error('snapshot unavailable');}});assert.equal(result.tasks[0].updateEvidence.worker,'unknown');
});

test('missing malformed or linked environment records fail closed without following links',async t=>{
 const f=await fixture(t);await confirmed(f);await rm(f.envFile);assert.equal((await inspect(f)).tasks[0].updateEvidence.runtime,'unknown');
 await writeFile(f.envFile,'{broken');assert.equal((await inspect(f)).tasks[0].updateEvidence.runtime,'unknown');
 await rm(f.envFile);const external=path.join(f.stateDir,'private.json');await writeFile(external,JSON.stringify(f.environment));await symlink(external,f.envFile);assert.equal((await inspect(f)).tasks[0].updateEvidence.runtime,'unknown');
});

test('invalid task IDs and UUID traversal cannot select arbitrary runner paths',async t=>{
 const f=await fixture(t);await confirmed(f);f.task.id='../outside';assert.equal((await inspect(f)).tasks[0].updateEvidence.worker,'unknown');
 f.task.id=f.id;f.task.runId='../../outside';assert.equal((await inspect(f)).tasks[0].updateEvidence.worker,'unknown');
});


test('default fresh process snapshot finds a real owned hook and never signals it',async t=>{
 const f=await fixture(t);await confirmed(f);
 const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
 await once(child,'spawn');
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){const closed=once(child,'exit');child.kill('SIGTERM');await closed;}});
 const actual=(await snapshotProcesses()).get(child.pid);assert.ok(actual);
 await f.save(path.join(f.hookDir,'ownership.json'),{id:f.hookId,records:[actual]});
 const result=await inspectUpdateEvidence({stateDir:f.stateDir,view:{tasks:[f.task]}});
 assert.equal(result.tasks[0].updateEvidence.hooks[0].state,'live');
 assert.doesNotThrow(()=>process.kill(child.pid,0));
});


test('interrupted harness publication cannot hide existing durable ownership or live execution',async t=>{
 const f=await fixture(t);f.task.harnessStarted=false;const owned=processIdentity();
 await f.save(path.join(f.runDir,'owner.json'),{runId:f.runId,supervisorPid:owned.pid,supervisorIdentity:owned});
 assert.equal((await inspect(f,new Map([[owned.pid,row(owned)]]))).tasks[0].updateEvidence.worker,'live');
 await rm(path.join(f.runDir,'owner.json'));f.task.execution={live:true};
 assert.equal((await inspect(f)).tasks[0].updateEvidence.worker,'unknown');
});


test('compact toolchain hook environments retain strict ownership and terminal evidence checks',async t=>{
 const f=await fixture(t);await confirmed(f);delete f.environment.kind;delete f.environment.runtime;f.environment.toolchain={nodeVersion:'22.14.0'};await f.save(f.envFile,f.environment);
 let evidence=(await inspect(f)).tasks[0].updateEvidence;assert.equal(evidence.runtime,'absent');assert.equal(evidence.hooks[0].state,'stopped');
 await rm(path.join(f.hookDir,'exit.json'));evidence=(await inspect(f)).tasks[0].updateEvidence;assert.equal(evidence.hooks[0].state,'unknown');
 await confirmed(f);const owned=processIdentity();await f.save(path.join(f.hookDir,'ownership.json'),{id:f.hookId,records:[owned]});assert.equal((await inspect(f,new Map([[owned.pid,row(owned)]]))).tasks[0].updateEvidence.hooks[0].state,'live');
 for(const invalid of ['crew-'+ 'b'.repeat(31),'crew-'+ 'B'.repeat(32),'crew-foreign-task-deadbeef']){f.environment.id=invalid;await f.save(f.envFile,f.environment);assert.equal((await inspect(f)).tasks[0].updateEvidence.runtime,'unknown');}
 f.environment.id=f.environmentId;f.environment.taskId='foreign-task';await f.save(f.envFile,f.environment);assert.equal((await inspect(f)).tasks[0].updateEvidence.runtime,'unknown');
});

test('legacy hook IDs still require the exact owning task ID',async t=>{
 const f=await fixture(t);await confirmed(f);delete f.environment.kind;delete f.environment.runtime;f.environment.id=`crew-${f.id}-deadbeef`;await f.save(f.envFile,f.environment);assert.equal((await inspect(f)).tasks[0].updateEvidence.runtime,'absent');assert.equal((await inspect(f)).tasks[0].updateEvidence.hooks[0].state,'stopped');
 f.environment.id='crew-another-task-deadbeef';await f.save(f.envFile,f.environment);assert.equal((await inspect(f)).tasks[0].updateEvidence.runtime,'unknown');
});
