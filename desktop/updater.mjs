// AI-015: native-only update coordination. No credentials or renderer Node bridge.
import {mkdir,readFile,writeFile,rename,rm,realpath} from 'node:fs/promises';
import {join,resolve,isAbsolute} from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {snapshotProcesses} from '../process-ownership.mjs';
const exec=promisify(execFile);
export const RELEASE_URL='https://github.com/MattGibney/crew/releases/latest';
export const UPDATE_ACTIONS=new Set(['status','check','download','restart']);
export const PAUSE_UPDATE_ACTIONS=new Set(['pause-update','cancel-pause-update']);
export function newerVersion(candidate,current){
 const parse=value=>typeof value==='string'?value.match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-z.-]+))?(?:\+[\da-z.-]+)?$/i):null;
 const a=parse(candidate),b=parse(current);if(!a||!b||a[4])return false;
 for(let i=1;i<=3;i++){if(Number(a[i])!==Number(b[i]))return Number(a[i])>Number(b[i]);}
 return Boolean(b[4]);
}
export async function signedUpdateSupport({packaged,executable=process.execPath,run=exec}={}){
 if(!packaged)return {supported:false,error:'Automatic updates require an installed, signed Crew release.'};
 try{
  const bundle=resolve(executable,'../../..');
  await run('/usr/bin/codesign',['--verify','--deep','--strict',bundle],{timeout:15000,maxBuffer:65536});
  const {stderr='',stdout=''}=await run('/usr/bin/codesign',['--display','--verbose=4',bundle],{timeout:5000,maxBuffer:65536});
  if(!/^Authority=Developer ID Application:/m.test(stderr+stdout)||!/^TeamIdentifier=[A-Z0-9]+$/m.test(stderr+stdout))throw new Error('Unsigned');
  return {supported:true,error:null};
 }catch{return {supported:false,error:'This Crew build is unsigned or its Developer ID signature could not be verified. Install a signed release to enable automatic updates.'};}
}
export async function otherNativeInstances({executable=process.execPath,pid=process.pid,backendPid,backendPids=backendPid?[backendPid]:[],run=exec}={}){
 const {stdout}=await run('/bin/ps',['-axo','pid=,ppid=,command='],{timeout:5000,maxBuffer:8*1024*1024});
 const rows=stdout.split('\n').flatMap(line=>{const m=line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);return m?[{pid:Number(m[1]),ppid:Number(m[2]),command:m[3]}]:[];});
 if(!rows.some(row=>row.pid===pid))throw new Error('Native process ownership snapshot is unavailable.');
 const allowed=new Set([pid]);
 // Only this instance's currently owned backend tree may be stopped during an
 // idle restart. Detached supervisors from closed instances remain blockers.
 for(const backend of backendPids)if(Number.isSafeInteger(backend)&&rows.some(row=>row.pid===backend&&row.ppid===pid))allowed.add(backend);
 let changed=true;
 while(changed){changed=false;for(const row of rows)if(allowed.has(row.ppid)&&row.ppid!==pid&&!allowed.has(row.pid)){allowed.add(row.pid);changed=true;}}
 return rows.filter(row=>!allowed.has(row.pid)&&(row.command===executable||row.command.startsWith(executable+' '))).map(row=>row.pid);
}
// Atomic nonempty directory publication avoids the empty-lock crash window.
// Deterministic tombstones prevent two dead-owner recoverers stealing a new lock.
export function createInstallLease({directory,snapshot=snapshotProcesses,pid=process.pid}={}){
 const target=join(directory,'installation.lock');
 const ownerAt=async path=>JSON.parse(await readFile(join(path,'owner.json'),'utf8'));
 const active=async owner=>{
  if(!owner||!Number.isSafeInteger(owner.pid)||typeof owner.start!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(owner.token||''))return true;
  const current=(await snapshot()).get(owner.pid);return Boolean(current&&current.start===owner.start&&!current.state?.includes('Z'));
 };
 return {async acquire(){
  await mkdir(directory,{recursive:true,mode:0o700});
  const own=(await snapshot()).get(pid);if(!own)throw new Error('Cannot verify the update lock process identity.');
  const token=randomUUID(),candidate=join(directory,`candidate-${token}`),owner={pid,start:own.start,token};
  await mkdir(candidate,{mode:0o700});await writeFile(join(candidate,'owner.json'),JSON.stringify(owner),{mode:0o600});
  let acquired=false;
  try{
   for(let attempt=0;attempt<4;attempt++){
    try{await rename(candidate,target);acquired=true;break;}catch(error){if(!['EEXIST','ENOTEMPTY'].includes(error.code))throw error;}
    let previous;try{previous=await ownerAt(target);}catch{throw new Error('Another update has an unverified installation lock.');}
    if(await active(previous))throw new Error('Another Crew instance is preparing an update.');
    try{await rename(target,join(directory,`stale-${previous.token}`));}catch(error){if(!['ENOENT','EEXIST','ENOTEMPTY'].includes(error.code))throw error;}
   }
   if(!acquired)throw new Error('Could not reserve the Crew installation. Retry after other instances quit.');
  }finally{if(!acquired)await rm(candidate,{recursive:true,force:true});}
  return async()=>{const current=await ownerAt(target);if(current.token!==token)throw new Error('Update lock ownership changed.');const released=join(directory,`released-${token}`);await rename(target,released);await rm(released,{recursive:true});};
 }};
}
// Squirrel.Mac relaunch has no configurable argv. Preserve the configured
// instance with one bounded, version-bound local handoff, never auth contents.
export function createRestartHandoff({directory,snapshot=snapshotProcesses,pid=process.pid,now=Date.now,executable=process.execPath}={}){
 const target=join(directory,'restart.json');
 return {
  async write({configPath,version}){
   if(!isAbsolute(configPath)||!/^\d+\.\d+\.\d+$/.test(version))throw new Error('Invalid update restart identity.');
   const owner=(await snapshot()).get(pid);if(!owner)throw new Error('Cannot verify restart process identity.');
   await mkdir(directory,{recursive:true,mode:0o700});
   const token=randomUUID(),temporary=join(directory,`restart-${token}.tmp`);
   await writeFile(temporary,JSON.stringify({configPath,version,executable:await realpath(resolve(executable)),pid,start:owner.start,at:now(),token}),{mode:0o600});await rename(temporary,target);
   return async()=>{try{const record=JSON.parse(await readFile(target,'utf8'));if(record.token===token)await rm(target);}catch(error){if(error.code!=='ENOENT')throw error;}};
  },
  async consume(version,explicitConfig){
   let record;try{record=JSON.parse(await readFile(target,'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw new Error('The update restart handoff is unreadable.');}
   if(!record||record.version!==version||typeof record.configPath!=='string'||!isAbsolute(record.configPath)||!Number.isSafeInteger(record.pid)||typeof record.start!=='string'||typeof record.token!=='string'||!/^[a-f0-9-]{36}$/.test(record.token)||!Number.isFinite(record.at)||now()-record.at<0||now()-record.at>10*60*1000)return null;
   // Legacy unbound records never activate a project. Replacing the app at
   // the same installation path preserves identity; another app copy does not.
   if(typeof record.executable!=='string'||record.executable!==await realpath(resolve(executable)))return null;
   if(explicitConfig&&resolve(explicitConfig)!==resolve(record.configPath))return null;
   const previous=(await snapshot()).get(record.pid);if(previous&&previous.start===record.start&&!previous.state?.includes('Z'))return null;
   const claimed=join(directory,`restart-claimed-${record.token}`);
   try{await rename(target,claimed);}catch(error){if(error.code==='ENOENT')return null;throw error;}
   try{const actual=JSON.parse(await readFile(claimed,'utf8'));if(actual.token!==record.token)throw new Error('The update restart handoff changed.');return record.configPath;}finally{await rm(claimed);}
  }
 };
}
// Native setup admission must freeze synchronously before the backend reserve
// await; a previous idle snapshot alone cannot prevent a concurrent setup save.
export function createNativeUpdateGate({busy=()=>false}={}){
 let reserved=false;
 return {
  isReserved:()=>reserved,
  assertSetupAllowed(){if(reserved)throw new Error('Crew is preparing an update. Finish the restart before changing setup.');},
  async reserve(prepare){
   if(reserved||busy())throw new Error('Crew setup or shutdown is in progress.');
   reserved=true;
   try{const result=await prepare();if(result?.reserved!==true)reserved=false;return result;}catch(error){reserved=false;throw error;}
  },
  cancel(){reserved=false;}
 };
}
export function createUpdateCoordinator({updater,currentVersion,support={supported:false,error:'Updates are unavailable.'},activity,prepare,cancel,stopBackend,install,lease,otherInstances=async()=>[],onState=()=>{}}){
 updater.autoDownload=false;updater.autoInstallOnAppQuit=false;updater.allowDowngrade=false;updater.allowPrerelease=false;updater.logger=null;
 let state={phase:'idle',currentVersion,availableVersion:null,downloadPercent:null,error:support.error||null,installBlocked:true,reasons:[],notices:[],supported:support.supported===true,releaseUrl:RELEASE_URL},busy=false;
 const publish=patch=>{state={...state,...patch};onState({...state,reasons:[...state.reasons],notices:[...state.notices]});return {...state,reasons:[...state.reasons],notices:[...state.notices]};};
 const on=(name,fn)=>updater.on(name,fn);
 on('update-available',info=>{if(newerVersion(info?.version,currentVersion))publish({phase:'available',availableVersion:info.version,error:null});else publish({phase:'idle',availableVersion:null,error:null});});
 on('update-not-available',()=>publish({phase:'current',availableVersion:null,error:null}));
 on('download-progress',progress=>publish({downloadPercent:Number.isFinite(progress?.percent)?Math.max(0,Math.min(100,progress.percent)):null}));
 on('update-downloaded',info=>{if(newerVersion(info?.version,currentVersion))publish({phase:'downloaded',availableVersion:info.version,downloadPercent:100,error:null});});
 on('error',()=>{if(state.phase!=='installing')publish({phase:'error',error:'The update could not be verified or retrieved. Check your connection and the published signed release, then retry.'});});
 async function refresh(){
  let reasons=[],notices=[];
  if(!state.supported)reasons.push(support.error||'Automatic updates are unavailable.');
  try{const value=await activity();if(Array.isArray(value?.notices))notices=value.notices.filter(item=>typeof item==='string').slice(0,12).map(item=>item.slice(0,600));if(value?.safe!==true)reasons.push(...(Array.isArray(value?.reasons)&&value.reasons.length?value.reasons:['Controller activity is unavailable.']));}catch{reasons.push('Controller activity is unavailable.');}
  try{if((await otherInstances()).length)reasons.push('Quit other Crew instances before restarting to update.');}catch{reasons.push('Other Crew instances could not be checked.');}
  return publish({installBlocked:reasons.length>0,reasons,notices});
 }
 async function request(action,{beforeInstall}={}){
  if(!UPDATE_ACTIONS.has(action))throw new Error('Unknown update action.');
  if(action==='status')return refresh();
  if(busy)throw new Error('An update operation is already in progress.');
  if(state.phase==='installing')throw new Error('Crew is restarting to install its update.');
  if(!state.supported)throw new Error(support.error||'Automatic updates are unavailable.');
  const previousPhase=state.phase;
  busy=true;let release,reserved=false;
  try{
   if(action==='check'&&state.phase==='downloaded')return {...state};
   if(action==='check'){publish({phase:'checking',error:null});await updater.checkForUpdates();}
   if(action==='download'){
    if(state.phase!=='available'||!newerVersion(state.availableVersion,currentVersion))throw new Error('Check for a newer release before downloading.');
    publish({phase:'downloading',downloadPercent:0,error:null});await updater.downloadUpdate();
   }
   if(action==='restart'){
    if(state.phase!=='downloaded'||!newerVersion(state.availableVersion,currentVersion))throw new Error('Download a newer signed release before restarting.');
    release=await lease.acquire();
    if((await refresh()).installBlocked)throw new Error(state.reasons.join(' '));
    const reservation=await prepare();if(reservation?.reserved!==true)throw new Error(Array.isArray(reservation?.reasons)?reservation.reasons.join(' '):'Controller could not reserve a safe restart.');
    reserved=true;
    // Recheck under the global lease; a new native process must acquire this
    // same lease before starting its backend. Never terminate another instance.
    if((await otherInstances()).length)throw new Error('Another Crew instance opened. Quit it before updating.');
    if(beforeInstall)await beforeInstall();
    publish({phase:'installing',installBlocked:true,error:null});await stopBackend();await install();
    // Successful install owns the lease until this process exits. A replacement
    // launch recovers the dead PID/start owner; ordinary Quit never installs.
    release=null;
   }
   return {...state};
  }catch(error){
   if(reserved)await cancel().catch(()=>{});
   const detail=action==='restart'?String(error.message||'Safe restart was refused.').slice(0,600):'The update could not be verified or retrieved. Check your connection and the published signed release, then retry.';
   publish({phase:action==='restart'?previousPhase:'error',error:detail});throw new Error(detail);
  }finally{if(release)await release();busy=false;}
 }
 return {request,refresh,getStatus:()=>({...state,reasons:[...state.reasons],notices:[...state.notices]})};
}

// Durable pause plans come only from the owned backend. Polling observes consent;
// it never invents a plan, drains work itself, or bypasses normal install gates.
export function createPauseUpdateCoordinator({native,begin,status,cancel,markInstalling,markBlocked}){
 let plan=null,advancing=false,commandPending=false;
 const attempted=new Set();
 const valid=value=>value&&typeof value.id==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(value.id)&&value.kind==='pause-update'&&value.consent===true&&typeof value.targetVersion==='string';
 const read=async()=>{const value=await status();plan=value?.plan??null;return plan;};
 const approvedReady=value=>valid(value)&&value.phase==='ready';
 const targetMatches=value=>{const state=native.getStatus();return state.supported&&state.phase==='downloaded'&&value.targetVersion===state.availableVersion&&newerVersion(value.targetVersion,state.currentVersion);};
 const key=value=>`${value.id}:${value.targetVersion}`;
 async function installPlan(value){
  if(!approvedReady(value)||!targetMatches(value))throw new Error('The approved pause plan does not match the downloaded update.');
  if(attempted.has(key(value)))throw new Error('This pause plan already attempted installation. Review it before starting a new update plan.');
  attempted.add(key(value));if(attempted.size>100)attempted.delete(attempted.values().next().value);
  try{
   return await native.request('restart',{beforeInstall:async()=>{
    const marked=await markInstalling({planId:value.id,targetVersion:value.targetVersion});
    if(marked?.marked!==true)throw new Error('The update plan changed or was canceled before installation.');
    plan=marked.plan??{...value,phase:'installing'};
   }});
  }catch(error){
   try{const blocked=await markBlocked({planId:value.id,targetVersion:value.targetVersion,reason:'The native update restart did not finish. Choose Resume paused work or Return to work before another update.'});plan=blocked?.plan??plan;}catch{/* A durable installing plan remains fail closed; never retry it by polling. */}
   throw error;
  }
 }
 return {
  getPlan:()=>plan?structuredClone(plan):null,
  isCommandPending:()=>commandPending,
  refreshPlan:read,
  async request(action){
   if(!PAUSE_UPDATE_ACTIONS.has(action))throw new Error('Unknown pause update action.');
   if(commandPending)throw new Error('A pause update action is already pending.');
   commandPending=true;
   try{
    if(action==='pause-update'){
     const state=native.getStatus();if(!state.supported||state.phase!=='downloaded'||!newerVersion(state.availableVersion,state.currentVersion))throw new Error('Download a newer signed update before pausing work.');
     const value=await begin({targetVersion:state.availableVersion});plan=value?.plan??null;
     if(!valid(plan)||plan.targetVersion!==state.availableVersion)throw new Error('The backend did not confirm an approved update plan.');
    }else{const current=await read();if(!valid(current))throw new Error('There is no approved pause update plan to cancel.');const value=await cancel({planId:current.id});plan=value?.plan??null;}
    return native.getStatus();
   }finally{commandPending=false;}
  },
  async restart(){
   if(advancing)throw new Error('The pause update restart is already pending.');
   advancing=true;
   try{
    const current=await read();
    if(current){
     if(approvedReady(current))return await installPlan(current);
     if(current.phase!=='complete')throw new Error('Choose Resume paused work or Return to work before another update.');
    }
    return await native.request('restart');
   }finally{advancing=false;}
  },
  async advancePlan(){
   if(advancing||commandPending)return native.getStatus();
   advancing=true;
   try{const current=await read();if(approvedReady(current)&&targetMatches(current)&&!attempted.has(key(current)))return await installPlan(current);return native.getStatus();}
   finally{advancing=false;}
  }
 };
}
