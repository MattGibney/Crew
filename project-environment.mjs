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
import {selectWorktreeRoot} from './worktree-paths.mjs';
const exec=promisify(execFile),sleep=ms=>new Promise(r=>setTimeout(r,ms)),now=()=>new Date().toISOString();
const digest=value=>createHash('sha256').update(value).digest('hex');
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
export const executionPlanHash=plan=>digest(JSON.stringify(canonical(plan)));
async function json(file){try{return JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
async function save(file,value){const temp=`${file}.${randomUUID()}.tmp`;await writeFile(temp,JSON.stringify(value,null,2)+'\n',{mode:0o600});await rename(temp,file);}
export async function verifyProjectWorktree({worktree,repositoryPath,baseCommit}){
 let actual;try{actual=await realpath(worktree);}catch(error){if(error.code==='ENOENT')throw new Error('Retained worktree is missing. Ask the manager to review missing-worktree recovery; cleanup is not verified.');throw error;}const repo=await realpath(repositoryPath);if(actual===repo)throw new Error('Project execution requires a separate registered Git worktree.');
 const git=async args=>(await exec('git',['-C',actual,...args],{timeout:10000,maxBuffer:1024*1024,env:{...process.env,GIT_OPTIONAL_LOCKS:'0'}})).stdout.trim();
 if(await realpath(await git(['rev-parse','--show-toplevel']))!==actual)throw new Error('Worker Git root does not match its retained worktree.');
 if(await git(['rev-parse','HEAD'])!==baseCommit)throw new Error('Worker baseline commit does not match its retained task.');
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
// Settings edits are applied only when the controller enters a lifecycle action.
// The original plan and each replaced revision remain durable audit evidence.
async function applyLifecyclePlan(args,environment,phases){
 const configured=args.plan;
 const current=configured?{...configured,...(Object.hasOwn(environment.plan,'env')?{env:structuredClone(environment.plan.env)}:{})}:null;
 if(current&& !Object.hasOwn(environment.plan,'env'))delete current.env;
 if(current){
  // Retained workers execute against their own verified baseline dependencies.
  // A newer project's source hash does not rewrite that worktree or its history.
  const pinned=new Map((environment.plan.sources||[]).map(source=>[source.path,source]));
  current.sources=(current.sources||[]).map(source=>structuredClone(pinned.get(source.path)||source));
  for(const phase of ['setup','start','resume','ready','stop','teardown'])if(current[phase]?.source&&pinned.has(current[phase].source.path))current[phase]={...current[phase],source:structuredClone(pinned.get(current[phase].source.path))};
 }
 if(!current)return;
 assertPlan(current);
 const previous=environment.plan;
 const mutable=new Set(['setup','start','resume','ready','stop','teardown','sources']);
 const changed=Object.keys({...previous,...current}).filter(key=>executionPlanHash(previous?.[key]??null)!==executionPlanHash(current[key]??null));
 if(changed.some(key=>!mutable.has(key)))throw new Error('Retained environment or permission configuration changed. Restore its original settings before retrying lifecycle actions.');
 await verifySources(environment.worktree,environment.baseCommit,current,phases);
 await verifyPermissionsSource(environment.repositoryPath,current);
 const configuredPlanHash=executionPlanHash(configured),previousConfiguredPlanHash=environment.configuredPlanHash||executionPlanHash(previous);
 environment.configuredPlanHash=configuredPlanHash;
 if(!changed.length&&configuredPlanHash===previousConfiguredPlanHash)return;
 const sourceBindings=phases.filter(phase=>current[phase]).map(phase=>({phase,configured:structuredClone(configured[phase]?.source||null),effective:structuredClone(current[phase].source||null)}));
 environment.originalPlan ||= structuredClone(previous);
 environment.planHistory=[...(environment.planHistory||[]),{at:now(),plan:structuredClone(previous),planHash:executionPlanHash(previous),nextPlanHash:executionPlanHash(current),configuredPlanHash,previousConfiguredPlanHash,sourceBindings,phases:[...phases],reason:'configured-lifecycle-action'}];
 environment.plan=structuredClone(current);environment.planHash=executionPlanHash(current);
 await persist(args,environment);
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
async function bounded(args,environment,phase,action,signal=args.signal){if(!action)return;await runEnvironmentHooks({stateDir:args.stateDir,taskId:args.taskId,worktree:environment.worktree,hooks:{[phase]:{command:'/bin/zsh',args:scriptArgs(environment.plan,action),timeoutMs:action.timeoutMs,planHash:environment.planHash,source:action.source||null,configurationSource:environment.originalPlan&&executionPlanHash(environment.originalPlan[phase]??null)!==executionPlanHash(action)?'crew-settings':'crew-config'}},phases:[phase],existing:environment,env:applyProjectToolchain(environment.toolchain),signal,pauseBoundary:args.pauseBoundary,cooperative:args.cooperative===true,onEvidence:async value=>{Object.assign(environment,value);await args.onEvidence?.(value);}});}
async function runtimeState(environment,processes=null){
 const runtime=environment.runtime;if(!runtime)return{kind:'absent'};const exit=await json(path.join(runtime.runDir,'exit.json'));if(exit?.id===runtime.id&&exit.environmentId===environment.id)return{kind:exit.stopConfirmed===true?'stopped':'unknown',exit};
 const started=await json(path.join(runtime.runDir,'started.json'));if(started?.id!==runtime.id||started.environmentId!==environment.id)return{kind:'unknown'};const actual=(processes||await snapshotProcesses()).get(started.pid),expected=started.identity;
 if(actual&&expected&&actual.start===expected.start&&actual.commandHash===expected.commandHash&&!actual.state?.includes('Z')){const commandStarted=await json(path.join(runtime.runDir,'command-started.json'));return{kind:commandStarted?.id===runtime.id&&commandStarted.environmentId===environment.id?'live':'starting',started};}const terminal=await json(path.join(runtime.runDir,'exit.json'));if(terminal?.id===runtime.id&&terminal.environmentId===environment.id)return{kind:terminal.stopConfirmed===true?'stopped':'unknown',exit:terminal};return{kind:'unknown'};
}
async function startRuntime(args,environment){
 const state=await runtimeState(environment);if(state.kind==='live')return;if(state.kind==='unknown')throw new Error('Previous project runtime shutdown/ownership is unresolved. Preserve it for recovery.');if(args.signal?.aborted)throw new Error('Project startup canceled.');
 const restarting=Boolean(environment.runtime),action=restarting?(environment.plan.resume||environment.plan.start):environment.plan.start;
 if(environment.runtime)environment.runtimeHistory=[...(environment.runtimeHistory||[]),structuredClone(environment.runtime)];
 const id=randomUUID(),dir=path.join(args.stateDir,'runs',args.taskId,'project-runtime',id);await mkdir(dir,{recursive:true,mode:0o700});environment.runtime={id,runDir:dir,status:'starting',createdAt:now(),planHash:environment.planHash,action:structuredClone(action),configurationSource:environment.originalPlan&&executionPlanHash(environment.originalPlan[restarting&&environment.plan.resume?'resume':'start']??null)!==executionPlanHash(action)?'crew-settings':'crew-config'};environment.servicesStarted=true;await persist(args,environment);
 await save(path.join(dir,'config.json'),{id,environmentId:environment.id,worktree:environment.worktree,command:'/bin/zsh',args:scriptArgs(environment.plan,action),planHash:environment.planHash,source:action.source||null,configurationSource:environment.runtime.configurationSource});
 let error=null;const child=spawn(process.execPath,[fileURLToPath(new URL('./project-runtime-runner.mjs',import.meta.url)),path.join(dir,'config.json')],{detached:true,stdio:'ignore',env:applyProjectToolchain(environment.toolchain)});child.once('error',e=>{error=e.code||'spawn failed';});child.unref();
 for(let i=0;i<100;i++){const current=await runtimeState(environment);if(current.kind==='live'){await sleep(300);if((await runtimeState(environment)).kind!=='live')throw new Error('Project Start action must remain in the foreground; it exited during startup.');environment.runtime.status='running';await persist(args,environment);return;}if(current.kind==='stopped'||error)throw new Error('Project Start action exited before runtime ownership was established.');await sleep(100);}throw new Error('Project runtime ownership was not established. Preserve this environment.');
}
export async function inspectProjectEnvironment(args){const environment=await json(environmentFile(args.stateDir,args.taskId));if(environment?.kind!=='project-execution')return environment;assertOwned(args,environment);if(!environment.runtime)return environment;const current=await runtimeState(environment,args.processes),status=current.kind==='live'?'running':current.kind==='stopped'?'stopped':Date.now()-Date.parse(environment.runtime.createdAt)<15000?'starting':'unknown';if(environment.runtime.status!==status){environment.runtime.status=status;if(['ready','running'].includes(environment.status)&&status!=='running'){environment.status='failed';environment.detail='Owned foreground project action stopped or lost ownership confirmation. Worktree and data were retained.';}await persist(args,environment);}return environment;}
export async function prepareProjectEnvironment(args){
 args={...args,plan:structuredClone(args.plan)};
 const worktree=await verifyProjectWorktree(args);assertPlan(args.plan);await verifyPermissionsSource(args.repositoryPath,args.plan);
 const prior=await reconcileEnvironment({stateDir:args.stateDir,taskId:args.taskId});if(prior?.pending)throw new Error('A previous project command has not confirmed it stopped.');
 const environment=prior||{id:`crew-${randomUUID().replace(/-/g,'')}`,kind:'project-execution',taskId:args.taskId,worktree,repositoryPath:await realpath(args.repositoryPath),baseCommit:args.baseCommit,plan:structuredClone(args.plan),planHash:executionPlanHash(args.plan),hooks:[],status:'preparing',createdAt:now()};
 assertOwned(args,environment);
 if(environment.worktree!==worktree)throw new Error('Retained worktree identity changed; existing data was retained.');
 if(environment.repositoryPath!==await realpath(args.repositoryPath))throw new Error('Retained repository identity changed; existing data was retained.');
 if(environment.baseCommit!==args.baseCommit)throw new Error('Retained baseline commit changed; existing data was retained.');
 await applyLifecyclePlan(args,environment,[...(!environment.prepared?['setup']:[]),environment.runtime&&args.plan.resume?'resume':'start','ready']);
 // Preserve effective pinned environment while adopting configured lifecycle commands.
 args.plan=structuredClone(environment.plan);
 environment.planHash=executionPlanHash(environment.plan);await persist(args,environment);
 await args.pauseBoundary?.();
 const setupRetry=Boolean(args.setupRetry?.requestId)&&!environment.setupRetryHistory?.some(entry=>entry.requestId===args.setupRetry.requestId);
 if(setupRetry&&!environment.plan.setup)throw new Error('Retry failed setup requires a configured Setup command; retained partial data was preserved.');
 if(!environment.prepared&&environment.setupAttempted&&!environment.hooks.some(h=>h.phase==='setup'&&h.status==='succeeded')&&!setupRetry)throw new Error('Earlier setup did not complete. Its retained data will not be reseeded; review it before starting a fresh worker.');
 // Resolve before provisioning; resume checks the exact retained version, never upgrades it.
 try{environment.toolchain=await resolveProjectToolchain({worktree,baseCommit:args.baseCommit,plan:environment.plan,retained:environment.toolchain,cacheRoot:args.toolchainCacheRoot,env:args.env});}
 catch(error){environment.status='failed';environment.detail=`Toolchain preparation failed: ${error.message}`;await persist(args,environment);throw error;}
 await persist(args,environment);
 await args.pauseBoundary?.();
 if(!environment.prepared){const completed=environment.hooks.some(h=>h.phase==='setup'&&h.status==='succeeded');if(environment.setupAttempted&&!completed&&!setupRetry)throw new Error('Earlier setup did not complete. Its retained data will not be reseeded; review it before starting a fresh worker.');if(!completed&&environment.plan.setup){if(setupRetry)environment.setupRetryHistory=[...(environment.setupRetryHistory||[]),{...args.setupRetry,at:now(),planHash:environment.planHash}];environment.setupAttempted=true;await persist(args,environment);await bounded(args,environment,'setup',environment.plan.setup);}environment.prepared=true;await persist(args,environment);}
 await args.pauseBoundary?.();
 if(environment.plan.start)await startRuntime(args,environment);if(args.signal?.aborted){await stopProjectEnvironment(args);throw new Error('Project startup canceled.');}
 await args.pauseBoundary?.();
 if(environment.plan.ready){await bounded(args,environment,'ready',environment.plan.ready);if(environment.plan.start&&(await runtimeState(environment)).kind!=='live')throw new Error('Project Start action stopped before its declared readiness check completed.');environment.readinessKind='app-verified';environment.status='ready';}else{environment.readinessKind='setup-complete';environment.status=environment.plan.start?'running':'ready';}
 environment.readyAt=now();return persist(args,environment);
}
export async function stopProjectEnvironment(args){
 args={...args,plan:args.plan?structuredClone(args.plan):null};
 const environment=await json(environmentFile(args.stateDir,args.taskId));if(environment?.kind!=='project-execution')return environment;assertOwned(args,environment);
 const cooperative=args.cooperative===true;
 const pending=await reconcileEnvironment({stateDir:args.stateDir,taskId:args.taskId,stop:!cooperative});if(pending?.pending)throw new Error('Project setup/check command is still finishing; no stop completion was claimed.');
 Object.assign(environment,pending||{});await applyLifecyclePlan(args,environment,['stop']);const state=await runtimeState(environment);if(state.kind==='unknown')throw new Error('Project runtime ownership is unresolved; no stop completion was claimed.');
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
 args={...args,plan:args.plan?structuredClone(args.plan):null};
 const environment=await json(environmentFile(args.stateDir,args.taskId));if(environment?.kind!=='project-execution')return environment;assertOwned(args,environment);
 const pending=await reconcileEnvironment({stateDir:args.stateDir,taskId:args.taskId});if(pending?.pending)throw new Error('A project command has no stop confirmation.');
 if(!['absent','stopped'].includes((await runtimeState(environment)).kind))throw new Error('Stop the owned foreground project action before teardown.');
 await applyLifecyclePlan(args,environment,['teardown']);
 if((environment.servicesStarted||environment.setupAttempted)&&!environment.plan.teardown)throw new Error('This project has no declared teardown action. Ask the manager how to preserve or remove its resources; nothing was removed.');
 await verifyProjectWorktree({...args,...environment});if(environment.plan.teardown)await verifySources(environment.worktree,environment.baseCommit,environment.plan,['teardown']);if(environment.plan.teardown)await bounded(args,environment,'teardown',environment.plan.teardown,undefined);environment.status='disposed';return persist(args,environment);
}

// GH-24: recovery only changes reviewed metadata. It never executes a command.
const recoveryPhases = ['resume', 'ready', 'stop', 'teardown'];
const equalValue = (a,b) => JSON.stringify(canonical(a ?? null)) === JSON.stringify(canonical(b ?? null));
async function recoveryChecks(args) {
 const {task, project, mode} = args;
 const environment = await json(environmentFile(args.stateDir,task.id));
 if (!['reconcile_plan','retire_missing'].includes(mode)) throw new Error('Unknown recovery action.');
 if (!['paused','stopped','failed','blocked','completed'].includes(task.status)) throw new Error('Pause or stop this worker and wait for confirmed exit before recovery.');
 if (project?.mode !== 'repository' || project.id !== task.projectId) throw new Error('Recovery requires the task’s configured repository project.');
 const repository = project.repositories?.find(entry=>entry.id===task.repositoryId);
 if (!repository || await realpath(repository.path) !== task.repositoryPath) throw new Error('Configured repository identity changed. Restore the original repository before recovery.');
 if(task.workerSandbox && task.workerSandbox!==project.worker?.sandbox)throw new Error('Worker permission configuration changed. Restore its original settings before lifecycle recovery.');
 const expectedWorktree=path.join(await selectWorktreeRoot(args.stateDir,task),task.worktreeName||task.id);
 if (!task.worktree || path.resolve(task.worktree)!==task.worktree || expectedWorktree !== task.worktree) throw new Error('Retained worktree path does not match its owned workspace location.');
 if (environment) {
  assertOwned({taskId:task.id,stateDir:args.stateDir},environment);
  if (environment.worktree!==task.worktree || environment.repositoryPath!==task.repositoryPath || environment.baseCommit!==task.baseCommit) throw new Error('Retained environment repository, worktree or baseline identity changed.');
 }
 if(task.runDir && task.runDir!==path.join(args.stateDir,'runs',task.id,task.runId))throw new Error('Worker run evidence directory identity changed.');
 const exit = task.runDir ? await json(path.join(task.runDir,'exit.json')) : null;
 let nativeEvidence=false;
 if(task.runDir)for(const file of ['owner.json','started.json','runtime.json','runner.claim'])if(await lstat(path.join(task.runDir,file)).catch(error=>{if(error.code==='ENOENT')return null;throw error;}))nativeEvidence=true;
 if ((task.harnessStarted || task.spawnIntentAt || task.runnerPid || nativeEvidence) && !(exit?.runId===task.runId && exit.stopConfirmed===true)) throw new Error('Worker process exit is unconfirmed for this run. Preserve its evidence before recovery.');
 if (task.runnerPid) {
  const owner = await json(path.join(task.runDir,'owner.json')), actual=(await snapshotProcesses()).get(task.runnerPid);
  if(!actual){try{process.kill(task.runnerPid,0);throw new Error('Worker supervisor liveness is unavailable. Preserve it before recovery.');}catch(error){if(error.code!=='ESRCH')throw error;}}
  if (actual && (!owner?.supervisorIdentity || actual.start===owner.supervisorIdentity.start && actual.commandHash===owner.supervisorIdentity.commandHash) && !actual.state?.includes('Z')) throw new Error('Worker supervisor still exists or its ownership is unknown. Wait for exit before recovery.');
 }
 for (const hook of environment?.hooks || []) {
  if (hook.status!=='running') continue;
  if (hook.runDir!==path.join(args.stateDir,'runs',task.id,'environment',hook.id)) throw new Error('Lifecycle command evidence ownership changed.');
  const terminal=await json(path.join(hook.runDir,'exit.json'));
  if (terminal?.id!==hook.id || terminal.confirmed!==true) throw new Error(`Lifecycle ${hook.phase} command exit is unconfirmed. Recovery cannot stop or replay it.`);
 }
 if (environment && !['absent','stopped'].includes((await runtimeState(environment)).kind)) throw new Error('Foreground project runtime is active or its exit/ownership is unknown. Stop it through its declared lifecycle before recovery.');
 return environment;
}
export async function reviewProjectRecovery(args) {
 const {task,project,mode}=args;
 const environment=await json(environmentFile(args.stateDir,task.id));
 const retained=environment?.plan || null, current=project?.worker?.environment?.executionPlan || null;
 const differences=Object.keys({...retained,...current}).filter(key=>!equalValue(retained?.[key],current?.[key])).map(key=>({field:key,retained:retained?.[key]??null,current:current?.[key]??null}));
 const identity={taskId:task.id,runId:task.runId||null,mode,environmentId:environment?.id||null,worktree:task.worktree,repositoryPath:task.repositoryPath,baseCommit:task.baseCommit,retainedPlanHash:retained?executionPlanHash(retained):null,currentPlanHash:current?executionPlanHash(current):null};
 const reviewHash=executionPlanHash(identity), blockers=[];
 try {
  await recoveryChecks(args);
  if (mode==='retire_missing') {
   const metadata=await lstat(task.worktree).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
   if (metadata) throw new Error('Worktree path still exists (including symlinks). Use normal safe disposal; no record was retired.');
   if (await realpath(path.dirname(task.worktree))!==path.dirname(task.worktree)) throw new Error('Worktree parent identity is not canonical.');
   const {stdout}=await exec('git',['-C',task.repositoryPath,'worktree','list','--porcelain','-z'],{timeout:10000,maxBuffer:1024*1024});
   if (stdout.split('\0').includes(`worktree ${task.worktree}`)) throw new Error('Worktree is still registered with Git. Review and reconcile it with project tooling before retiring this record.');
  } else {
   if (!environment?.plan || !current) throw new Error('A retained and a current source-backed execution plan are required.');
   const metadata=await lstat(task.worktree);
   if(!metadata.isDirectory() || metadata.isSymbolicLink() || await realpath(task.worktree)!==task.worktree)throw new Error('Retained worktree identity is not a canonical directory. No configuration was adopted.');
   await verifyProjectWorktree({worktree:task.worktree,repositoryPath:task.repositoryPath,baseCommit:task.baseCommit});
   assertPlan(current);
   const allowed=new Set([...recoveryPhases,'sources']);
   const incompatible=differences.filter(entry=>!allowed.has(entry.field));
   if (incompatible.length) throw new Error(`Incompatible plan changes: ${incompatible.map(entry=>entry.field).join(', ')}. Setup, Start, environment and permissions remain pinned.`);
   if (!Array.isArray(current.sources) || retained.sources.some(source=>!current.sources.some(entry=>equalValue(entry,source)))) throw new Error('Existing source provenance changed or was removed. Restore its pinned evidence before recovery.');
   // New provenance must be pinned and present. Existing non-executable guidance
   // may contain retained worker edits, just as it may during ordinary resume.
   for (const source of current.sources.filter(source=>!retained.sources.some(entry=>equalValue(entry,source)))) await verifySources(task.worktree,task.baseCommit,{...current,ready:{command:'source validation only',timeoutMs:1000,source}},['ready']);
   await verifySources(task.worktree,task.baseCommit,current);
   await verifyPermissionsSource(task.repositoryPath,current);
   if (environment.setupAttempted && !environment.prepared && !environment.hooks?.some(h=>h.phase==='setup'&&h.status==='succeeded')) {
    // Teardown can recover failed provisioning; a plan change never authorizes reseeding.
    if (differences.some(entry=>!['teardown','sources'].includes(entry.field))) throw new Error('Incomplete setup permits only reviewed teardown recovery; setup will not be replayed.');
   }
  }
 } catch(error) { blockers.push(error.message); }
 return {...identity,reviewHash,differences,allowed:blockers.length===0,blockers,cleanupVerified:false};
}
export async function applyProjectRecovery(args) {
 const {task,request}=args;
 const prior=await json(environmentFile(args.stateDir,task.id));
 const applied=prior?.recoveryHistory?.find(entry=>entry.actionId===request.id);
 if (applied) {
  if (applied.reviewHash!==request.reviewHash || applied.runId!==(task.runId||null) || applied.currentPlanHash!==executionPlanHash(args.project.worker.environment.executionPlan)) throw new Error('Recovery retry no longer matches its saved decision. Review current state again.');
  const recheck=await reviewProjectRecovery(args);if(!recheck.allowed)throw new Error(recheck.blockers.join(' '));
  return prior;
 }
 const review=await reviewProjectRecovery(args);
 if (review.reviewHash!==request.reviewHash) throw new Error('Recovery review is stale. Review retained and current evidence again; nothing was changed.');
 if (!review.allowed) throw new Error(review.blockers.join(' '));
 if (args.mode==='retire_missing') return {review};
 if ((prior.recoveryHistory?.length||0)>=100) throw new Error('Retained recovery history limit reached; preserve its history for review.');
 const entry={actionId:request.id,runId:task.runId||null,reviewHash:request.reviewHash,decision:request.decision,at:now(),previousPlan:structuredClone(prior.plan),previousPlanHash:executionPlanHash(prior.plan),currentPlanHash:review.currentPlanHash,differences:review.differences};
 prior.recoveryHistory=[...(prior.recoveryHistory||[]),entry];
 prior.plan=structuredClone(args.project.worker.environment.executionPlan);prior.planHash=review.currentPlanHash;
 await persist({stateDir:args.stateDir,taskId:task.id},prior);
 return prior;
}
