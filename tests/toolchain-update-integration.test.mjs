import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,realpath,rm,readdir} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {resolveProjectToolchain,applyProjectToolchain} from '../project-toolchain.mjs';
import {runEnvironmentHooks,environmentFile} from '../worker-environment.mjs';

const exec=promisify(execFile),root=path.resolve('.');
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
 const action=`import fs from 'node:fs';import{execFileSync}from'node:child_process';const phase=process.argv[2],file='.evidence/phases.json';fs.mkdirSync('.evidence',{recursive:true});const rows=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):[];rows.push({phase,node:execFileSync('node',['--version'],{encoding:'utf8'}).trim(),npm:execFileSync('npm',['--version'],{encoding:'utf8'}).trim(),PATH:process.env.PATH,ZDOTDIR:process.env.ZDOTDIR||null,BASH_ENV:process.env.BASH_ENV||null});fs.writeFileSync(file,JSON.stringify(rows));if(phase==='setup'&&${failSetup})process.exit(7);if(phase==='stop')fs.writeFileSync('.evidence/stop','yes');if(phase==='start'||phase==='resume'){fs.rmSync('.evidence/stop',{force:true});for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{fs.appendFileSync('.evidence/forced',signal+'\\n');process.exit(0);});setInterval(()=>{if(fs.existsSync('.evidence/stop'))process.exit(0);},50);}`;
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

test('managed tools propagate through cooperative stop and retained resume without force or reseeding',async t=>{
 const f=await fixture(t),selected=await cacheEntry(f.cache);
 await f.run(`let current;try{const first=await prepareProjectEnvironment(args);current=first;const stopped=await stopProjectEnvironment({...args,cooperative:true});await fs.writeFile(${JSON.stringify(path.join(f.temporary,'stopped.json'))},JSON.stringify(stopped));current=await prepareProjectEnvironment({...args,resume:true});if(current.id!==first.id)throw new Error('Environment identity changed');await stopProjectEnvironment({...args,cooperative:true});}finally{if(current)await stopProjectEnvironment({...args,cooperative:true});}`);
 const rows=await f.rows();assert.deepEqual(rows.map(r=>r.phase),['setup','start','ready','stop','resume','ready','stop']);
 for(const row of rows){assert.equal(row.node,'v22.14.0');assert.equal(row.npm,'11.11.0');assert.ok(row.PATH.startsWith(`${selected}/bin:`));}
 const stopped=JSON.parse(await readFile(path.join(f.temporary,'stopped.json'),'utf8')),hook=stopped.hooks.find(h=>h.phase==='stop');
 assert.equal(JSON.parse(await readFile(path.join(hook.runDir,'config.json'),'utf8')).cooperative,true);assert.equal(JSON.parse(await readFile(path.join(stopped.runtime.runDir,'exit.json'),'utf8')).stopConfirmed,true);
 await assert.rejects(readFile(path.join(f.args.worktree,'.evidence/forced')),{code:'ENOENT'});
});

test('managed preparation honors an update boundary after setup before starting a runtime',async t=>{
 const f=await fixture(t);await cacheEntry(f.cache);
 await f.run(`let interrupted=false;try{await prepareProjectEnvironment({...args,pauseBoundary:async()=>{let rows=[];try{rows=JSON.parse(await fs.readFile(args.worktree+'/.evidence/phases.json','utf8'));}catch{}if(rows.some(row=>row.phase==='setup')){interrupted=true;throw Object.assign(new Error('Update boundary'),{cooperative:true});}}});throw new Error('Expected update boundary');}catch(error){if(!interrupted||!error.cooperative)throw error;}`);
 assert.deepEqual((await f.rows()).map(r=>r.phase),['setup']);const environment=JSON.parse(await readFile(environmentFile(f.args.stateDir,f.args.taskId),'utf8'));assert.equal(environment.prepared,true);assert.equal(environment.runtime,undefined);assert.equal(environment.toolchain.nodeVersion,'22.14.0');
});
