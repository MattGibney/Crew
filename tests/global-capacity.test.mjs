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

test('native connection closure releases capacity while retained service ownership remains factual',async t=>{
 const f=await fixture(t);await configureGlobalCapacity({dir:f.capacity,limit:1,stateDirs:[f.stateA,f.stateB]});
 await createTask(f.stateA,{requestId:'resource-worker',ticket:'CREW-50',brief:'A native worker may start a retained service'});
 const runDir=path.join(f.stateA,'runs','resource-worker','closed-native-run');await mkdir(runDir,{recursive:true});
 const own=await createGlobalCapacity({dir:f.capacity,stateDir:f.stateA});await own.acquire({taskId:'resource-worker',runId:'closed-native-run'});
 await updateTask(f.stateA,'resource-worker',task=>{task.runId='closed-native-run';task.runDir=runDir;task.status='completed';task.harnessStarted=true;});
 const exit={runId:'closed-native-run',connectionClosed:true,stopConfirmed:false,ownership:{tracked:[{pid:999999,start:'old-start',commandHash:'a'.repeat(64)}],remaining:[{pid:999999,start:'old-start',commandHash:'a'.repeat(64)}]}};
 await writeFile(path.join(runDir,'exit.json'),JSON.stringify(exit));
 const other=await createGlobalCapacity({dir:f.capacity,stateDir:f.stateB});assert.equal((await other.view()).occupied,0);assert.equal((await other.acquire({taskId:'another-worker',runId:'another-native-run'})).admitted,true);
 assert.deepEqual(JSON.parse(await readFile(path.join(runDir,'exit.json'),'utf8')),exit);
});

test('a closed older native run releases its exact stale claim after worker advancement',async t=>{
 const f=await fixture(t),own=await createGlobalCapacity({dir:f.capacity,stateDir:f.stateA,limit:1});
 await createTask(f.stateA,{requestId:'advanced-worker',ticket:'CREW-50',brief:'Retain context across native connections'});
 assert.equal((await own.acquire({taskId:'advanced-worker',runId:'native-run-one'})).admitted,true);
 const old=path.join(f.stateA,'runs','advanced-worker','native-run-one');await mkdir(old,{recursive:true});await writeFile(path.join(old,'exit.json'),JSON.stringify({runId:'native-run-one',connectionClosed:true,stopConfirmed:false,ownership:{remaining:[{pid:999999}]}}));
 await updateTask(f.stateA,'advanced-worker',task=>{task.runId='native-run-two';task.runDir=path.join(f.stateA,'runs','advanced-worker','native-run-two');task.retainedResourceRuns=[{runId:'native-run-one'}];task.harnessStarted=false;task.status='resume_queued';});
 assert.equal((await own.view()).occupied,0);assert.equal((await own.acquire({taskId:'advanced-worker',runId:'native-run-two'})).admitted,true);
 // Old-format contradictory terminal records do not gain the new release rule.
 const ledger=JSON.parse(await readFile(path.join(f.capacity,'capacity.json'),'utf8'));ledger.claims[0].runId='native-run-one';await writeFile(path.join(f.capacity,'capacity.json'),JSON.stringify(ledger));
 await writeFile(path.join(old,'exit.json'),JSON.stringify({runId:'native-run-one',stopConfirmed:true}));assert.equal((await own.view()).occupied,1);
});

test('retained connection replaces only its own slot without legacy flag rewrites and honors an update pause',async t=>{
 const f=await fixture(t),own=await createGlobalCapacity({dir:f.capacity,stateDir:f.stateA,limit:1});
 await createTask(f.stateA,{requestId:'retained-slot-worker',ticket:'GH-50',brief:'Keep one native connection slot through continuation'});
 const oldDir=path.join(f.stateA,'runs','retained-slot-worker','legacy-native-run');await mkdir(oldDir,{recursive:true});
 const legacy={runId:'legacy-native-run',stopConfirmed:false,ownership:{remaining:[{pid:999999,start:'retained-service',commandHash:'a'.repeat(64)}]}};
 await writeFile(path.join(oldDir,'exit.json'),JSON.stringify(legacy));
 await updateTask(f.stateA,'retained-slot-worker',task=>{task.runId='legacy-native-run';task.runDir=oldDir;task.harnessStarted=true;task.status='running';});
 assert.equal((await own.acquire({taskId:'retained-slot-worker',runId:'legacy-native-run'})).admitted,true);
 assert.equal((await own.acquire({taskId:'retained-slot-worker',runId:'next-native-run'})).admitted,false,'Ordinary acquisition never steals an existing connection claim');
 await configureGlobalCapacity({dir:f.capacity,admissionPaused:true});
 assert.equal((await own.acquire({taskId:'retained-slot-worker',runId:'next-native-run',replaceConnection:true})).admitted,false);
 assert.deepEqual(JSON.parse(await readFile(path.join(f.capacity,'capacity.json'),'utf8')).claims.map(claim=>claim.runId),['legacy-native-run']);
 await configureGlobalCapacity({dir:f.capacity,admissionPaused:false});
 assert.equal((await own.acquire({taskId:'retained-slot-worker',runId:'next-native-run',replaceConnection:true})).admitted,true);
 assert.equal((await own.view()).occupied,1,'Reconciliation before task publication must not resurrect the replaced old connection');
 assert.deepEqual(JSON.parse(await readFile(path.join(oldDir,'exit.json'),'utf8')),legacy,'Connection replacement does not fabricate legacy descendant-stop evidence');
 await updateTask(f.stateA,'retained-slot-worker',task=>{task.runId='next-native-run';task.runDir=path.join(f.stateA,'runs','retained-slot-worker','next-native-run');task.harnessStarted='pending';task.status='launching';});
 assert.equal((await own.view()).occupied,1);
 const other=await createGlobalCapacity({dir:f.capacity,stateDir:f.stateB});assert.equal((await other.acquire({taskId:'other-slot-worker',runId:'other-native-run'})).admitted,false);
});

test('connection replacement preserves unrelated earlier claims for the same retained worker',async t=>{
 const f=await fixture(t),own=await createGlobalCapacity({dir:f.capacity,stateDir:f.stateA,limit:2});
 await createTask(f.stateA,{requestId:'exact-replace-worker',ticket:'GH-50',brief:'Replace one observed native connection identity'});
 await updateTask(f.stateA,'exact-replace-worker',task=>{task.runId='current-old-native';task.harnessStarted=true;task.status='running';});
 await own.acquire({taskId:'exact-replace-worker',runId:'current-old-native'});
 const file=path.join(f.capacity,'capacity.json'),ledger=JSON.parse(await readFile(file,'utf8'));
 ledger.claims.unshift({stateDir:f.stateA,taskId:'exact-replace-worker',runId:'unrelated-earlier-native',at:new Date().toISOString()});await writeFile(file,JSON.stringify(ledger));
 assert.equal((await own.acquire({taskId:'exact-replace-worker',runId:'replacement-native',replaceConnection:true,previousRunId:'current-old-native'})).admitted,true);
 const claims=JSON.parse(await readFile(file,'utf8')).claims;
 assert.deepEqual(claims.map(claim=>claim.runId),['unrelated-earlier-native','replacement-native']);assert.equal(claims[1].replacesRunId,'current-old-native');
 assert.equal((await own.view()).occupied,2,'Only the replaced publication is suppressed; unrelated uncertainty remains visible');
});
