import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createTask, updateTask } from '../runtime/orchestration-store.mjs';
import { configureGlobalCapacity, createGlobalCapacity, globalAdmissionPaused } from '../runtime/global-capacity.mjs';
async function fixture(t) { const dir=await mkdtemp(path.join(os.tmpdir(),'crew-capacity-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));return {dir,stateA:path.join(dir,'project-a'),stateB:path.join(dir,'project-b'),capacity:path.join(dir,'capacity')}; }
test('independent OS processes cannot over-admit and changing the limit never preempts claims',async t=>{
 const f=await fixture(t);await configureGlobalCapacity({dir:f.capacity,limit:2,stateDirs:[f.stateA,f.stateB]});
 const module=pathToFileURL(path.resolve('runtime/global-capacity.mjs')).href;
 const jobs=Array.from({length:8},(_,i)=>new Promise((resolve,reject)=>{
  const args={dir:f.capacity,stateDir:i%2?f.stateA:f.stateB};
  const script=`import{createGlobalCapacity}from ${JSON.stringify(module)};const c=await createGlobalCapacity(${JSON.stringify(args)});console.log(JSON.stringify(await c.acquire({taskId:'worker-${i}',runId:'run-${i}'})));`;
  const child=spawn(process.execPath,['--input-type=module','-e',script],{stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>err+=d);child.on('error',reject);child.on('exit',code=>code?reject(new Error(err)):resolve(JSON.parse(out)));
 }));
 const results=await Promise.all(jobs);assert.equal(results.filter(r=>r.admitted).length,2);
 await configureGlobalCapacity({dir:f.capacity,limit:1});const c=await createGlobalCapacity({dir:f.capacity,stateDir:f.stateA});assert.deepEqual(await c.view(),{limit:1,occupied:2,admissionPaused:false});assert.equal((await c.acquire({taskId:'later-worker',runId:'later-run'})).admitted,false);
});
test('offline registered project with uncertain execution reserves capacity until exact confirmed exit',async t=>{
 const f=await fixture(t);await configureGlobalCapacity({dir:f.capacity,limit:1,stateDirs:[f.stateA,f.stateB]});
 await createTask(f.stateA,{requestId:'offline-worker',ticket:'CREW-2',brief:'disposable capacity proof'});
 const runDir=path.join(f.stateA,'runs','offline-worker','run-one');await mkdir(runDir,{recursive:true});
 await updateTask(f.stateA,'offline-worker',n=>{n.runId='run-one';n.runDir=runDir;n.harnessStarted='pending';n.status='failed';});
 const other=await createGlobalCapacity({dir:f.capacity,stateDir:f.stateB});assert.equal((await other.acquire({taskId:'waiting-worker',runId:'run-two'})).admitted,false);
 await writeFile(path.join(runDir,'exit.json'),JSON.stringify({runId:'wrong-run',stopConfirmed:true}));assert.equal((await other.view()).occupied,1);
 await writeFile(path.join(runDir,'exit.json'),JSON.stringify({runId:'run-one',stopConfirmed:false}));assert.equal((await other.view()).occupied,1);
 await writeFile(path.join(runDir,'exit.json'),JSON.stringify({runId:'run-one',stopConfirmed:true}));assert.equal((await other.view()).occupied,0);assert.equal((await other.acquire({taskId:'waiting-worker',runId:'run-two'})).admitted,true);
});
test('corrupt global state fails closed instead of replacing admission evidence',async t=>{
 const f=await fixture(t);await configureGlobalCapacity({dir:f.capacity,limit:1});const file=path.join(f.capacity,'capacity.json');await writeFile(file,'{broken');await assert.rejects(createGlobalCapacity({dir:f.capacity,stateDir:f.stateA}));assert.equal(await readFile(file,'utf8'),'{broken');
});
test('global limit accepts machine-wide capacity through 64 and rejects invalid settings without replacing state',async t=>{
 const f=await fixture(t);await configureGlobalCapacity({dir:f.capacity,limit:64});const c=await createGlobalCapacity({dir:f.capacity,stateDir:f.stateA});assert.equal((await c.view()).limit,64);for(const limit of [0,65,1.5,'4'])await assert.rejects(configureGlobalCapacity({dir:f.capacity,limit}));assert.equal((await c.view()).limit,64);
});

test('durable update admission pause survives new controller clients and preserves admitted runs',async t=>{
 const f=await fixture(t);await configureGlobalCapacity({dir:f.capacity,limit:4});const a=await createGlobalCapacity({dir:f.capacity,stateDir:f.stateA});assert.equal((await a.acquire({taskId:'worker-active',runId:'run-active'})).admitted,true);
 await configureGlobalCapacity({dir:f.capacity,admissionPaused:true});const restarted=await createGlobalCapacity({dir:f.capacity,stateDir:f.stateB});assert.equal((await restarted.acquire({taskId:'worker-waiting',runId:'run-waiting'})).admissionPaused,true);assert.equal((await restarted.view()).occupied,1);assert.equal((await restarted.view()).admissionPaused,true);
 await configureGlobalCapacity({dir:f.capacity,limit:5});assert.equal((await restarted.view()).admissionPaused,true,'ordinary capacity settings do not clear updater reservation');
 await configureGlobalCapacity({dir:f.capacity,admissionPaused:false});assert.equal((await restarted.acquire({taskId:'worker-waiting',runId:'run-waiting'})).admitted,true);
});

test('read-only global admission guard blocks unknown/configured state and observes holds without changing files',async t=>{
 const f=await fixture(t);assert.equal(await globalAdmissionPaused(),false);assert.equal(await globalAdmissionPaused(f.capacity),true);assert.equal(await globalAdmissionPaused('relative'),true);
 await configureGlobalCapacity({dir:f.capacity,limit:2});const file=path.join(f.capacity,'capacity.json');const original=await readFile(file,'utf8');
 assert.equal(await globalAdmissionPaused(f.capacity),false);assert.equal(await readFile(file,'utf8'),original);
 await configureGlobalCapacity({dir:f.capacity,admissionPaused:true});assert.equal(await globalAdmissionPaused(f.capacity),true);
 const valid=JSON.parse(await readFile(file,'utf8'));for(const data of [{...valid,admissionPaused:undefined},{...valid,admissionPaused:'false'},{...valid,version:9}]){const bytes=JSON.stringify(data);await writeFile(file,bytes);assert.equal(await globalAdmissionPaused(f.capacity),true);assert.equal(await readFile(file,'utf8'),bytes);}
 await writeFile(file,'{broken');assert.equal(await globalAdmissionPaused(f.capacity),true);assert.equal(await readFile(file,'utf8'),'{broken');
});
