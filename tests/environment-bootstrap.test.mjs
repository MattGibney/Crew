import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {runEnvironmentHooks,environmentFile} from '../runtime/projects/worker-environment.mjs';
async function fixture(t){const stateDir=await mkdtemp(path.join(tmpdir(),'crew-bootstrap-'));t.after(()=>rm(stateDir,{recursive:true,force:true}));const worktree=path.join(stateDir,'worktree');await mkdir(worktree);await mkdir(path.join(stateDir,'runs','worker'),{recursive:true});return{stateDir,taskId:'worker',worktree};}
const hook=script=>({command:process.execPath,args:['-e',script],timeoutMs:5000});
const count="const fs=require('fs');const n=fs.existsSync('seeds')?Number(fs.readFileSync('seeds','utf8')):0;fs.writeFileSync('seeds',String(n+1));";
test('successful argv bootstrap remains setup-once after later Start failure and no-thread retry',async t=>{
 const args=await fixture(t);const hooks={bootstrap:hook(count),start:hook('process.exit(7)')};
 await assert.rejects(runEnvironmentHooks({...args,hooks,phases:['bootstrap','start','ready']}),/start environment hook failed/);
 hooks.start=hook('');const retried=await runEnvironmentHooks({...args,hooks,phases:['bootstrap','start','ready']});
 assert.equal(await readFile(path.join(args.worktree,'seeds'),'utf8'),'1');assert.equal(retried.hooks.filter(h=>h.phase==='bootstrap').length,1);assert.equal(retried.hooks.filter(h=>h.phase==='start').length,2);assert.equal(retried.hooks.find(h=>h.phase==='start').exitCode,7);
});
test('failed argv bootstrap requires a unique explicit retry and retains partial state across reload',async t=>{
 const args=await fixture(t);const hooks={bootstrap:hook(count+'process.exit(8)')};
 await assert.rejects(runEnvironmentHooks({...args,hooks,phases:['bootstrap','start']}),/bootstrap environment hook failed/);
 const failed=JSON.parse(await readFile(environmentFile(args.stateDir,args.taskId),'utf8'));hooks.bootstrap=hook('');
 await assert.rejects(runEnvironmentHooks({...args,hooks,phases:['bootstrap','start']}),/will not be reseeded/);
 const setupRetry={requestId:'explicit-bootstrap-retry',runId:'failed-run'};const retried=await runEnvironmentHooks({...args,hooks,phases:['bootstrap','start'],setupRetry});
 assert.equal(retried.id,failed.id);assert.equal(retried.hooks.length,2);assert.equal(retried.hooks[0].exitCode,8);assert.equal(retried.hooks[1].status,'succeeded');assert.equal(retried.setupRetryHistory[0].requestId,setupRetry.requestId);assert.equal(retried.setupRetryHistory[0].configurationHash,retried.hooks[1].configurationHash);assert.equal(await readFile(path.join(args.worktree,'seeds'),'utf8'),'1');
 const again=await runEnvironmentHooks({...args,hooks,phases:['bootstrap','start'],setupRetry});assert.equal(again.hooks.length,2);
});
test('a failed explicit bootstrap attempt cannot reuse its authorization to replay again',async t=>{
 const args=await fixture(t);const hooks={bootstrap:hook(count+'process.exit(9)')};await assert.rejects(runEnvironmentHooks({...args,hooks,phases:['bootstrap']}),/bootstrap environment hook failed/);
 const setupRetry={requestId:'one-retry',runId:'first-run'};await assert.rejects(runEnvironmentHooks({...args,hooks,phases:['bootstrap'],setupRetry}),/bootstrap environment hook failed/);await assert.rejects(runEnvironmentHooks({...args,hooks,phases:['bootstrap'],setupRetry}),/will not be reseeded/);assert.equal(await readFile(path.join(args.worktree,'seeds'),'utf8'),'2');
});
