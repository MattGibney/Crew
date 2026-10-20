import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {discoverWorkerEnvironment,assertWorkerEnvironmentSelection} from '../desktop/environment-options.mjs';
const exec=promisify(execFile);
test('execution selection reads committed project commands and rejects stale provenance',async t=>{
 const repo=await mkdtemp(join(tmpdir(),'crew environment '));t.after(()=>rm(repo,{recursive:true,force:true}));const git=(...args)=>exec('git',['-C',repo,...args]);await git('init','-b','main');await mkdir(join(repo,'.codex/environments'),{recursive:true});
 const file=join(repo,'.codex/environments/environment.toml');await writeFile(file,'version = 1\n[setup]\nscript = "./existing-setup"\n[[actions]]\nname = "Start"\ncommand = "./existing-start"\n');await git('add','.');await git('-c','user.name=Fixture','-c','user.email=test@example.invalid','commit','-m','existing setup');
 const option=await discoverWorkerEnvironment({path:repo,baseRef:'main'});assert.equal(option.status,'available');assert.equal(option.plan.setup.command,'./existing-setup');assert.equal(option.plan.start.command,'./existing-start');assert.equal(option.plan.teardown,null);assert.equal(option.plan.ready,null);
 await writeFile(file,'[setup]\nscript = "./uncommitted-script"\n');assert.equal((await discoverWorkerEnvironment({path:repo,baseRef:'main'})).plan.setup.command,'./existing-setup');
 const config={project:{worker:{environment:{executionPlan:structuredClone(option.plan)}},repositories:[{id:'product',path:repo,baseRef:'main'}]}};const options=[{...option,repositoryId:'product',path:repo,baseRef:'main'}];assert.doesNotThrow(()=>assertWorkerEnvironmentSelection(config,options));config.project.worker.environment.executionPlan.setup.command='./changed-command';assert.throws(()=>assertWorkerEnvironmentSelection(config,options),/Reload/);
});

test('action changes preserve local runtime choices while refreshing project permissions',async()=>{
 const {selectExecutionPlan}=await import('../desktop/execution-selection.mjs'),source={path:'environment.toml',sha256:'a'.repeat(64)},action=command=>({command,source,timeoutMs:600000});
 const discovered={schemaVersion:1,sources:[source],setup:action('setup'),start:action('start'),resume:action('start'),ready:null,stop:null,teardown:null,networkAccess:false,permissionsSource:{path:'/repo/.codex/config.toml',sha256:'b'.repeat(64)}};
 const saved={...structuredClone(discovered),networkAccess:true,permissionsSource:{...discovered.permissionsSource,sha256:'c'.repeat(64)},env:{PATH:'/installed/tools'},ready:action('health'),stop:action('stop'),teardown:action('down')};saved.start.timeoutMs=45000;
 const result=selectExecutionPlan({discovered,saved,action:{command:'alternate',source}});assert.equal(result.start.command,'alternate');assert.equal(result.resume.command,'alternate');assert.equal(result.start.timeoutMs,45000);assert.deepEqual(result.env,saved.env);assert.deepEqual(result.ready,saved.ready);assert.deepEqual(result.teardown,saved.teardown);assert.equal(result.networkAccess,false);assert.equal(result.permissionsSource.sha256,'b'.repeat(64));
 const unknown=structuredClone(discovered);delete unknown.networkAccess;delete unknown.permissionsSource;const refreshed=selectExecutionPlan({discovered:unknown,saved});assert.equal('networkAccess' in refreshed,false);assert.equal('permissionsSource' in refreshed,false);
});

test('a project with only another named action remains selectable without inventing setup',async t=>{
 const repo=await mkdtemp(join(tmpdir(),'crew-action-only-'));t.after(()=>rm(repo,{recursive:true,force:true}));const git=(...args)=>exec('git',['-C',repo,...args]);await git('init','-b','main');await mkdir(join(repo,'.codex/environments'),{recursive:true});await writeFile(join(repo,'.codex/environments/environment.toml'),'[[actions]]\nname="Dev server"\ncommand="./existing-dev"\n');await git('add','.');await git('-c','user.name=Fixture','-c','user.email=test@example.invalid','commit','-m','action');
 const option=await discoverWorkerEnvironment({path:repo,baseRef:'main'});assert.equal(option.status,'available');assert.equal(option.plan.setup,null);assert.equal(option.plan.start,null);assert.equal(option.actions[0].command,'./existing-dev');
});
