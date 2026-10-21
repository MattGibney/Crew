import {workerAppServerFixture} from './helpers/worker-app-server-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,realpath,rm,readdir} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {resolveProjectToolchain,applyProjectToolchain} from '../runtime/project-toolchain.mjs';
import {runEnvironmentHooks,environmentFile} from '../runtime/worker-environment.mjs';

const exec=promisify(execFile),root=path.resolve('runtime');
const quote=value=>`'${String(value).replaceAll("'","'\\''")}'`;
// These are simulated cache entries, not evidence of a real downloaded Node release.
// Commands run through the selected entry, forwarding script execution to test Node.
async function cacheEntry(cache,nodeVersion='22.14.0',npmVersion='11.11.0'){
 const directory=path.join(cache,`node-${nodeVersion}-npm-${npmVersion}-${process.platform}-${process.arch}`),bin=path.join(directory,'bin');
 await mkdir(bin,{recursive:true});await mkdir(path.join(directory,'npm/bin'),{recursive:true});
 await writeFile(path.join(bin,'node'),`#!/bin/sh\nif [ "$1" = "--version" ]; then echo v${nodeVersion}; exit; fi\ncase "$1" in */npm/bin/npm-cli.js) echo ${npmVersion}; exit;; esac\nexec ${quote(process.execPath)} "$@"\n`,{mode:0o700});
 await writeFile(path.join(bin,'npm'),`#!/bin/sh\necho ${npmVersion}\n`,{mode:0o700});
 await writeFile(path.join(directory,'npm/bin/npm-cli.js'),'// simulated version probe\n');
 await writeFile(path.join(directory,'manifest.json'),JSON.stringify({nodeVersion,npmVersion,platform:process.platform,arch:process.arch}));return directory;
}
async function fixture(t,{failSetup=false,declareTools=true}={}){
 const temporary=await realpath(await mkdtemp(path.join(tmpdir(),'crew-toolchain-e2e-'))),repo=path.join(temporary,'repo'),worktree=path.join(temporary,'work tree'),stateDir=path.join(temporary,'state'),cache=path.join(temporary,'managed tools'),home=path.join(temporary,'home'),personal=path.join(home,'personal-bin');
 await Promise.all([mkdir(repo),mkdir(personal,{recursive:true}),mkdir(path.join(stateDir,'runs/toolchain-test'),{recursive:true})]);
 const action=`import fs from 'node:fs';import{execFileSync}from'node:child_process';const phase=process.argv[2],file='.evidence/phases.json';fs.mkdirSync('.evidence',{recursive:true});const rows=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):[];rows.push({phase,node:execFileSync('node',['--version'],{encoding:'utf8'}).trim(),npm:execFileSync('npm',['--version'],{encoding:'utf8'}).trim(),PATH:process.env.PATH,ZDOTDIR:process.env.ZDOTDIR||null,BASH_ENV:process.env.BASH_ENV||null});fs.writeFileSync(file,JSON.stringify(rows));if(phase==='setup'&&${failSetup})process.exit(7);if(phase==='start'||phase==='resume')setInterval(()=>{},1000);`;
 await writeFile(path.join(repo,'action.mjs'),action);await writeFile(path.join(repo,'.gitignore'),'.evidence/\n');await writeFile(path.join(repo,'package.json'),JSON.stringify(declareTools?{engines:{node:'22',npm:'11.11.0'}}:{}));await writeFile(path.join(repo,'AGENTS.md'),declareTools?'Use Node 22 and npm 11.11.0.\n':'Read project instructions before implementation.\n');
 const startup=path.join(home,'startup-ran');
 // Explicit profile choices remain active. This fixture keeps managed tools first.
 for(const name of ['.zshenv','.zprofile','.zshrc','.zlogin'])await writeFile(path.join(home,name),`echo startup >> ${quote(startup)}\nexport PATH=${quote(path.join(cache,`node-22.14.0-npm-11.11.0-${process.platform}-${process.arch}`,'bin'))}:$PATH:${quote(personal)}\n`);
 for(const name of ['node','npm'])await writeFile(path.join(personal,name),'#!/bin/sh\necho personal-tool-must-not-run\nexit 99\n',{mode:0o700});
 await exec('git',['init','-q','-b','main',repo]);await exec('git',['-C',repo,'add','.']);await exec('git',['-C',repo,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Disposable GH-1 project']);
 const baseCommit=(await exec('git',['-C',repo,'rev-parse','HEAD'])).stdout.trim();await exec('git',['-C',repo,'worktree','add','--detach',worktree,baseCommit]);
 const source={path:'action.mjs',sha256:createHash('sha256').update(action).digest('hex')},phase=name=>({command:`node action.mjs ${name}`,timeoutMs:10000,source});
 const plan={schemaVersion:1,sources:[source],setup:phase('setup'),start:phase('start'),resume:phase('resume'),ready:phase('ready'),stop:phase('stop'),teardown:phase('teardown')};
 const args={stateDir,taskId:'toolchain-test',repositoryPath:repo,worktree,baseCommit,plan,toolchainCacheRoot:cache};
 const env={HOME:home,PATH:'/usr/bin:/bin',ZDOTDIR:home,BASH_ENV:path.join(home,'.zshenv')};
 const driver=path.join(temporary,'driver.mjs');
 const run=async script=>{await writeFile(driver,`import{prepareProjectEnvironment,stopProjectEnvironment,disposeProjectEnvironment}from ${JSON.stringify(pathToFileURL(path.join(root,'project-environment.mjs')).href)};import fs from'node:fs/promises';import{execFile}from'node:child_process';import{promisify}from'node:util';const exec=promisify(execFile),args=${JSON.stringify(args)};${script}`);return exec(process.execPath,[driver],{env,timeout:60000,maxBuffer:1000000});};
 t.after(()=>rm(temporary,{recursive:true,force:true}));
 return{temporary,args,cache,home,startup,env,run,rows:async()=>JSON.parse(await readFile(path.join(worktree,'.evidence/phases.json'),'utf8'))};
}

test('minimal GUI environment uses the same managed Node/npm in setup, Start, readiness, resume, worker, stop and teardown',async t=>{
 const f=await fixture(t),selected=await cacheEntry(f.cache);
 const worker=path.join(f.temporary,'fake-codex');await writeFile(worker,workerAppServerFixture(`#!${process.execPath}\nimport{execFileSync}from'node:child_process';execFileSync('/bin/zsh',['-lc','node action.mjs worker'],{stdio:'inherit'});console.log(JSON.stringify({type:'thread.started',thread_id:'toolchain-fixture'}));console.log(JSON.stringify({type:'turn.completed'}));`),{mode:0o700});
 const runDir=path.join(f.temporary,'worker-run');await mkdir(runDir);
 await f.run(`let environment;try{environment=await prepareProjectEnvironment(args);await stopProjectEnvironment(args);await prepareProjectEnvironment({...args,resume:true});const config={taskId:args.taskId,runId:'toolchain-run',ticket:'GH-1',brief:'Disposable environment propagation check',stateDir:args.stateDir,worktree:args.worktree,executable:${JSON.stringify(worker)},mcpScript:${JSON.stringify(path.join(root,'orchestration-mcp.mjs'))},workerPrompt:'Read-only disposable fixture.',sandbox:'read-only',timeoutMs:10000,environment,project:{mode:'repository'}};const configPath=${JSON.stringify(path.join(runDir,'config.json'))};await fs.writeFile(configPath,JSON.stringify(config));await exec(process.execPath,[${JSON.stringify(path.join(root,'worker-runner.mjs'))},configPath],{timeout:15000});}finally{await stopProjectEnvironment(args);}await disposeProjectEnvironment(args);`);
 const rows=await f.rows();assert.deepEqual(rows.map(r=>r.phase),['setup','start','ready','stop','resume','ready','worker','stop','teardown']);
 for(const row of rows){assert.equal(row.node,'v22.14.0',row.phase);assert.equal(row.npm,'11.11.0',row.phase);assert.ok(row.PATH.startsWith(`${selected}/bin:`),row.phase);assert.ok(row.PATH.includes('personal-bin'),row.phase);assert.equal(row.ZDOTDIR,f.home,row.phase);assert.equal(row.BASH_ENV,path.join(f.home,'.zshenv'),row.phase);}
 assert.match(await readFile(f.startup,'utf8'),/startup/);
 const workerExit=JSON.parse(await readFile(path.join(runDir,'exit.json'),'utf8'));assert.equal(workerExit.exitCode,0);assert.equal(workerExit.completedTurn,true);assert.equal(workerExit.stopConfirmed,true);
});

test('retained resume pins exact tools when a newer compatible shared cache entry appears',async t=>{
 const f=await fixture(t),selected=await cacheEntry(f.cache);
 await f.run('try{await prepareProjectEnvironment(args);}finally{await stopProjectEnvironment(args);}');
 await cacheEntry(f.cache,'22.15.0');
 await f.run('try{await prepareProjectEnvironment({...args,resume:true});}finally{await stopProjectEnvironment(args);}');
 const rows=await f.rows();assert.equal(rows.filter(r=>r.phase==='setup').length,1);assert.equal(rows.filter(r=>r.phase==='resume').length,1);assert.ok(rows.every(r=>r.PATH.startsWith(`${selected}/bin:`)));
 await rm(selected,{recursive:true,force:true});
 const before=JSON.stringify(rows);await assert.rejects(f.run('await prepareProjectEnvironment({...args,resume:true});'),/missing or damaged/);assert.equal(JSON.stringify(await f.rows()),before);
});

test('failed setup retains partial project evidence and never silently replays or starts a worker',async t=>{
 const f=await fixture(t,{failSetup:true});await cacheEntry(f.cache);
 await assert.rejects(f.run('await prepareProjectEnvironment(args);'),/setup environment hook failed/);
 await assert.rejects(f.run('await prepareProjectEnvironment({...args,resume:true});'),/will not be reseeded/);
 assert.deepEqual((await f.rows()).map(r=>r.phase),['setup']);
 const environment=JSON.parse(await readFile(path.join(f.args.stateDir,'runs/toolchain-test/environment.json'),'utf8'));assert.equal(environment.setupAttempted,true);assert.equal(environment.prepared,undefined);assert.equal(environment.runtime,undefined);assert.equal(environment.toolchain.nodeVersion,'22.14.0');
});

test('missing cache in non-installing preflight fails before any project command or provisioning',async t=>{
 const f=await fixture(t);
 await assert.rejects(resolveProjectToolchain({worktree:f.args.worktree,baseCommit:f.args.baseCommit,plan:f.args.plan,cacheRoot:f.cache,env:f.env,install:false}),/missing or damaged/);
 await assert.rejects(f.rows(),{code:'ENOENT'});await assert.rejects(readdir(f.cache),{code:'ENOENT'});
});

test('legacy retained hook environments acquire and persist the resolved toolchain for setup and cleanup',async t=>{
 for(const failed of [false,true]){
  const f=await fixture(t),selected=await cacheEntry(f.cache);
  const toolchain=await resolveProjectToolchain({worktree:f.args.worktree,baseCommit:f.args.baseCommit,plan:f.args.plan,cacheRoot:f.cache,env:f.env,install:true});
  const prior={id:`legacy-${failed}`,taskId:f.args.taskId,worktree:f.args.worktree,status:failed?'failed':'not-configured',hooks:failed?[{id:'historical-failure',phase:'old-check',status:'failed',error:'Retained historical diagnostic'}]:[]};
  const file=environmentFile(f.args.stateDir,f.args.taskId);await writeFile(file,JSON.stringify(prior));
  const hooks=Object.fromEntries(['setup','cleanup'].map(phase=>[phase,{command:'/bin/zsh',args:['-lc',`node action.mjs ${phase}`],timeoutMs:10000}]));
  for(const phase of ['setup','cleanup']){
   const value=await runEnvironmentHooks({stateDir:f.args.stateDir,taskId:f.args.taskId,worktree:f.args.worktree,hooks,phases:[phase],existing:{...prior,toolchain},toolchain,env:applyProjectToolchain(toolchain,f.env)});
   assert.equal(value.id,prior.id);assert.deepEqual(value.toolchain,toolchain);assert.deepEqual(JSON.parse(await readFile(file,'utf8')).toolchain,toolchain);
  }
  const saved=JSON.parse(await readFile(file,'utf8'));assert.equal(saved.status,'disposed');assert.deepEqual(saved.hooks.map(h=>h.phase),failed?['old-check','setup','cleanup']:['setup','cleanup']);if(failed)assert.equal(saved.hooks[0].error,'Retained historical diagnostic');
  const rows=await f.rows();assert.deepEqual(rows.map(r=>r.phase),['setup','cleanup']);for(const row of rows){assert.equal(row.node,'v22.14.0');assert.equal(row.npm,'11.11.0');assert.ok(row.PATH.startsWith(`${selected}/bin:`));}
  assert.match(await readFile(f.startup,'utf8'),/startup/);
 }
});

test('bare Node/npm commands without declared Node requirements block before setup even with managed tools cached',async t=>{
 const f=await fixture(t,{declareTools:false});await cacheEntry(f.cache);
 await assert.rejects(f.run('await prepareProjectEnvironment(args);'),/no Node version is declared/);
 await assert.rejects(f.rows(),{code:'ENOENT'});
 const saved=JSON.parse(await readFile(environmentFile(f.args.stateDir,f.args.taskId),'utf8'));assert.equal(saved.setupAttempted,undefined);assert.equal(saved.runtime,undefined);assert.equal(saved.status,'failed');assert.match(saved.detail,/Toolchain preparation failed/);
});


test('launch defaults preserve configured environment and ignore legacy controlled-shell snapshots',()=>{
 const inherited={PATH:'/personal/bin:/usr/bin',ZDOTDIR:'/personal/shell',SHELL:'/bin/custom-shell',BASH_ENV:'/personal/bashrc',ENV:'/personal/env',NODE_OPTIONS:'--trace-warnings',NODE_PATH:'/personal/modules',NPM_CONFIG_PREFIX:'/personal/npm',npm_config_prefix:'/personal/npm-lower'};
 const result=applyProjectToolchain({PATH:'/managed/bin:/usr/bin',shellDirectory:'/legacy/crew-shell'},inherited);
 assert.deepEqual(result,{...inherited,PATH:'/managed/bin:/usr/bin:/personal/bin'});
 assert.deepEqual(inherited.PATH,'/personal/bin:/usr/bin');
 assert.deepEqual(applyProjectToolchain(null,inherited),inherited);
});
