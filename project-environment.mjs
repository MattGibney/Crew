// AI-012: execute a project's declared scripts. No project-specific protocol or inferred endpoints.
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,writeFile,rename,mkdir,realpath,lstat} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {runEnvironmentHooks,environmentFile,reconcileEnvironment} from './worker-environment.mjs';
import {resolveProjectToolchain, applyProjectToolchain} from './project-toolchain.mjs';
import {snapshotProcesses} from './process-ownership.mjs';
const exec=promisify(execFile),sleep=ms=>new Promise(r=>setTimeout(r,ms)),now=()=>new Date().toISOString();
const digest=value=>createHash('sha256').update(value).digest('hex');
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
export const executionPlanHash=plan=>digest(JSON.stringify(canonical(plan)));
async function json(file){try{return JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
async function save(file,value){const temp=`${file}.${randomUUID()}.tmp`;await writeFile(temp,JSON.stringify(value,null,2)+'\n',{mode:0o600});await rename(temp,file);}
export async function verifyProjectWorktree({worktree,repositoryPath,baseCommit}){
 const actual=await realpath(worktree),repo=await realpath(repositoryPath);if(actual===repo)throw new Error('Project execution requires a separate registered Git worktree.');
 const git=async args=>(await exec('git',['-C',actual,...args],{timeout:10000,maxBuffer:1024*1024,env:{...process.env,GIT_OPTIONAL_LOCKS:'0'}})).stdout.trim();
 if(await realpath(await git(['rev-parse','--show-toplevel']))!==actual||await git(['rev-parse','HEAD'])!==baseCommit)throw new Error('Worker baseline or Git root does not match its task.');
 const {stdout}=await exec('git',['-C',repo,'worktree','list','--porcelain','-z'],{timeout:10000,maxBuffer:1024*1024});if(!stdout.split('\0').some(field=>field===`worktree ${actual}`))throw new Error('Worker worktree is not registered to this repository.');return actual;
}
function assertPlan(plan){
 if(plan?.schemaVersion!==1||!Array.isArray(plan.sources)||!plan.sources.length)throw new Error('A source-backed project execution plan is required.');
 for(const phase of ['setup','start','resume','ready','stop','teardown']){const action=plan[phase];if(action===null||action===undefined)continue;if(typeof action.command!=='string'||!action.command.trim()||action.command.includes('\0')||!Number.isInteger(action.timeoutMs)||action.timeoutMs<1000||action.timeoutMs>600000)throw new Error(`Invalid project ${phase} action.`);}
}
async function verifySources(worktree,baseCommit,plan,phases){
 assertPlan(plan);
 for(const source of (phases||['setup','start','resume','ready','stop','teardown']).filter(p=>plan[p]).map(p=>plan[p].source)){
  if(!source||typeof source.path!=='string'||path.isAbsolute(source.path)||source.path.split(/[\\/]/).includes('..')||!source.path||source.path.includes('\0')||!/^[a-f0-9]{64}$/.test(source.sha256||''))throw new Error('Invalid project script source evidence.');
  const target=await realpath(path.join(worktree,source.path)),inside=path.relative(worktree,target);if(!inside||inside.startsWith(`..${path.sep}`)||path.isAbsolute(inside))throw new Error('Project script source escapes its worktree.');
  const {stdout}=await exec('git',['-C',worktree,'show',`${baseCommit}:${source.path}`],{encoding:'buffer',timeout:10000,maxBuffer:1024*1024});
  if(digest(stdout)!==source.sha256||digest(await readFile(target))!==source.sha256)throw new Error('Project script sources changed. Refresh the execution plan before starting this worker.');
 }
}
async function verifyPermissionsSource(repositoryPath,plan){
 if(!plan.permissionsSource)return;
 const source=plan.permissionsSource,repo=await realpath(repositoryPath),expected=path.join(repo,'.codex','config.toml');
 if(typeof source.path!=='string'||!path.isAbsolute(source.path)||source.path!==expected||!/^[a-f0-9]{64}$/.test(source.sha256||''))throw new Error('Project permission source must be its own local .codex/config.toml.');
 const metadata=await lstat(expected);if(!metadata.isFile()||metadata.isSymbolicLink()||metadata.size>262144)throw new Error('Project permission source must be a bounded regular local file.');
 const actual=await realpath(expected),inside=path.relative(repo,actual);if(actual!==expected||inside.startsWith(`..${path.sep}`)||path.isAbsolute(inside)||digest(await readFile(actual))!==source.sha256)throw new Error('Project Codex permissions changed. Refresh project settings before launching a worker.');
}
function assertOwned(args,environment){if(environment?.kind!=='project-execution'||environment.taskId!==args.taskId||!/^crew-[a-f0-9]{32}$/.test(environment.id))throw new Error('Project runtime identity does not match this task.');if(environment.runtime&&(typeof environment.runtime.id!=='string'||environment.runtime.runDir!==path.join(args.stateDir,'runs',args.taskId,'project-runtime',environment.runtime.id)))throw new Error('Runtime directory does not belong to this task.');}
async function persist(args,environment){await save(environmentFile(args.stateDir,args.taskId),environment);await args.onEvidence?.(environment);return environment;}
function scriptArgs(plan,action){return ['-lc',action.command];}
async function bounded(args,environment,phase,action,signal=args.signal){if(!action)return;await runEnvironmentHooks({stateDir:args.stateDir,taskId:args.taskId,worktree:environment.worktree,hooks:{[phase]:{command:'/bin/zsh',args:scriptArgs(environment.plan,action),timeoutMs:action.timeoutMs}},phases:[phase],existing:environment,env:applyProjectToolchain(environment.toolchain),signal,pauseBoundary:args.pauseBoundary,cooperative:args.cooperative===true,onEvidence:async value=>{Object.assign(environment,value);await args.onEvidence?.(value);}});}
async function runtimeState(environment,processes=null){
 const runtime=environment.runtime;if(!runtime)return{kind:'absent'};const exit=await json(path.join(runtime.runDir,'exit.json'));if(exit?.id===runtime.id&&exit.environmentId===environment.id)return{kind:exit.stopConfirmed===true?'stopped':'unknown',exit};
 const started=await json(path.join(runtime.runDir,'started.json'));if(started?.id!==runtime.id||started.environmentId!==environment.id)return{kind:'unknown'};const actual=(processes||await snapshotProcesses()).get(started.pid),expected=started.identity;
 if(actual&&expected&&actual.start===expected.start&&actual.commandHash===expected.commandHash&&!actual.state?.includes('Z')){const commandStarted=await json(path.join(runtime.runDir,'command-started.json'));return{kind:commandStarted?.id===runtime.id&&commandStarted.environmentId===environment.id?'live':'starting',started};}const terminal=await json(path.join(runtime.runDir,'exit.json'));if(terminal?.id===runtime.id&&terminal.environmentId===environment.id)return{kind:terminal.stopConfirmed===true?'stopped':'unknown',exit:terminal};return{kind:'unknown'};
}
async function startRuntime(args,environment){
 const state=await runtimeState(environment);if(state.kind==='live')return;if(state.kind==='unknown')throw new Error('Previous project runtime shutdown/ownership is unresolved. Preserve it for recovery.');if(args.signal?.aborted)throw new Error('Project startup canceled.');
 const restarting=Boolean(environment.runtime),action=restarting?(environment.plan.resume||environment.plan.start):environment.plan.start;
 const id=randomUUID(),dir=path.join(args.stateDir,'runs',args.taskId,'project-runtime',id);await mkdir(dir,{recursive:true,mode:0o700});environment.runtime={id,runDir:dir,status:'starting',createdAt:now()};environment.servicesStarted=true;await persist(args,environment);
 await save(path.join(dir,'config.json'),{id,environmentId:environment.id,worktree:environment.worktree,command:'/bin/zsh',args:scriptArgs(environment.plan,action)});
 let error=null;const child=spawn(process.execPath,[fileURLToPath(new URL('./project-runtime-runner.mjs',import.meta.url)),path.join(dir,'config.json')],{detached:true,stdio:'ignore',env:applyProjectToolchain(environment.toolchain)});child.once('error',e=>{error=e.code||'spawn failed';});child.unref();
 for(let i=0;i<100;i++){const current=await runtimeState(environment);if(current.kind==='live'){await sleep(300);if((await runtimeState(environment)).kind!=='live')throw new Error('Project Start action must remain in the foreground; it exited during startup.');environment.runtime.status='running';await persist(args,environment);return;}if(current.kind==='stopped'||error)throw new Error('Project Start action exited before runtime ownership was established.');await sleep(100);}throw new Error('Project runtime ownership was not established. Preserve this environment.');
}
export async function inspectProjectEnvironment(args){const environment=await json(environmentFile(args.stateDir,args.taskId));if(environment?.kind!=='project-execution')return environment;assertOwned(args,environment);if(!environment.runtime)return environment;const current=await runtimeState(environment,args.processes),status=current.kind==='live'?'running':current.kind==='stopped'?'stopped':Date.now()-Date.parse(environment.runtime.createdAt)<15000?'starting':'unknown';if(environment.runtime.status!==status){environment.runtime.status=status;if(['ready','running'].includes(environment.status)&&status!=='running'){environment.status='failed';environment.detail='Owned foreground project action stopped or lost ownership confirmation. Worktree and data were retained.';}await persist(args,environment);}return environment;}
export async function prepareProjectEnvironment(args){
 const worktree=await verifyProjectWorktree(args);assertPlan(args.plan);await verifyPermissionsSource(args.repositoryPath,args.plan);
 const prior=await reconcileEnvironment({stateDir:args.stateDir,taskId:args.taskId});if(prior?.pending)throw new Error('A previous project command has not confirmed it stopped.');
 const environment=prior||{id:`crew-${randomUUID().replace(/-/g,'')}`,kind:'project-execution',taskId:args.taskId,worktree,repositoryPath:await realpath(args.repositoryPath),baseCommit:args.baseCommit,plan:structuredClone(args.plan),planHash:executionPlanHash(args.plan),hooks:[],status:'preparing',createdAt:now()};
 assertOwned(args,environment);if(environment.worktree!==worktree||environment.repositoryPath!==await realpath(args.repositoryPath)||environment.baseCommit!==args.baseCommit||executionPlanHash(environment.plan)!==executionPlanHash(args.plan))throw new Error('Project runtime plan or worktree ownership changed; existing data was retained.');
 await verifySources(worktree,args.baseCommit,args.plan,[...(!environment.prepared?['setup']:[]),environment.runtime&&args.plan.resume?'resume':'start','ready']);
 // Upgrade legacy order-sensitive hashes only after the retained sources are verified.
 environment.planHash=executionPlanHash(args.plan);await persist(args,environment);
 await args.pauseBoundary?.();
 if(!environment.prepared&&environment.setupAttempted&&!environment.hooks.some(h=>h.phase==='setup'&&h.status==='succeeded'))throw new Error('Earlier setup did not complete. Its retained data will not be reseeded; review it before starting a fresh worker.');
 // Resolve before provisioning; resume checks the exact retained version, never upgrades it.
 try{environment.toolchain=await resolveProjectToolchain({worktree,baseCommit:args.baseCommit,plan:args.plan,retained:environment.toolchain,cacheRoot:args.toolchainCacheRoot,env:args.env});}
 catch(error){environment.status='failed';environment.detail=`Toolchain preparation failed: ${error.message}`;await persist(args,environment);throw error;}
 await persist(args,environment);
 await args.pauseBoundary?.();
 if(!environment.prepared){const completed=environment.hooks.some(h=>h.phase==='setup'&&h.status==='succeeded');if(environment.setupAttempted&&!completed)throw new Error('Earlier setup did not complete. Its retained data will not be reseeded; review it before starting a fresh worker.');if(!completed&&environment.plan.setup){environment.setupAttempted=true;await persist(args,environment);await bounded(args,environment,'setup',environment.plan.setup);}environment.prepared=true;await persist(args,environment);}
 await args.pauseBoundary?.();
 if(environment.plan.start)await startRuntime(args,environment);if(args.signal?.aborted){await stopProjectEnvironment(args);throw new Error('Project startup canceled.');}
 await args.pauseBoundary?.();
 if(environment.plan.ready){await bounded(args,environment,'ready',environment.plan.ready);if(environment.plan.start&&(await runtimeState(environment)).kind!=='live')throw new Error('Project Start action stopped before its declared readiness check completed.');environment.readinessKind='app-verified';environment.status='ready';}else{environment.readinessKind='setup-complete';environment.status=environment.plan.start?'running':'ready';}
 environment.readyAt=now();return persist(args,environment);
}
export async function stopProjectEnvironment(args){
 const environment=await json(environmentFile(args.stateDir,args.taskId));if(environment?.kind!=='project-execution')return environment;assertOwned(args,environment);
 const cooperative=args.cooperative===true;
 const pending=await reconcileEnvironment({stateDir:args.stateDir,taskId:args.taskId,stop:!cooperative});if(pending?.pending)throw new Error('Project setup/check command is still finishing; no stop completion was claimed.');
 Object.assign(environment,pending||{});const state=await runtimeState(environment);if(state.kind==='unknown')throw new Error('Project runtime ownership is unresolved; no stop completion was claimed.');
 if(cooperative){
  if(['live','starting'].includes(state.kind)&&!environment.plan.stop)throw new Error('This project has no declared graceful stop action. No force signal was sent; resolve its runtime before updating.');
  if(environment.runtime)await save(path.join(environment.runtime.runDir,'control.json'),{id:environment.runtime.id,environmentId:environment.id,action:'stop',cooperative:true,at:now()});
  if(environment.status!=='stopped'&&environment.plan.stop){await verifySources(environment.worktree,environment.baseCommit,environment.plan,['stop']);await bounded({...args,pauseBoundary:null,cooperative:true},environment,'stop',environment.plan.stop,undefined);}
  if(environment.runtime){const until=Date.now()+15000;for(;;){if((await runtimeState(environment)).kind==='stopped')break;if(Date.now()>until)throw new Error('Graceful project shutdown remains unconfirmed. No force signal was sent.');await sleep(100);}}
 }else{
  if(['live','starting'].includes(state.kind)){await save(path.join(environment.runtime.runDir,'control.json'),{id:environment.runtime.id,environmentId:environment.id,action:'stop',at:now()});const until=Date.now()+15000;for(;;){if((await runtimeState(environment)).kind==='stopped')break;if(Date.now()>until)throw new Error('Project foreground shutdown has not been confirmed.');await sleep(100);}}
  if(environment.status!=='stopped'&&environment.plan.stop){await verifySources(environment.worktree,environment.baseCommit,environment.plan,['stop']);await bounded(args,environment,'stop',environment.plan.stop,undefined);}
 }
 environment.status='stopped';if(environment.runtime)environment.runtime.status='stopped';return persist(args,environment);
}
export async function disposeProjectEnvironment(args){
 const environment=await json(environmentFile(args.stateDir,args.taskId));if(environment?.kind!=='project-execution')return environment;assertOwned(args,environment);
 const pending=await reconcileEnvironment({stateDir:args.stateDir,taskId:args.taskId});if(pending?.pending)throw new Error('A project command has no stop confirmation.');
 if(!['absent','stopped'].includes((await runtimeState(environment)).kind))throw new Error('Stop the owned foreground project action before teardown.');
 if((environment.servicesStarted||environment.setupAttempted)&&!environment.plan.teardown)throw new Error('This project has no declared teardown action. Ask the manager how to preserve or remove its resources; nothing was removed.');
 await verifyProjectWorktree({...args,...environment});if(environment.plan.teardown)await verifySources(environment.worktree,environment.baseCommit,environment.plan,['teardown']);if(environment.plan.teardown)await bounded(args,environment,'teardown',environment.plan.teardown,undefined);environment.status='disposed';return persist(args,environment);
}
