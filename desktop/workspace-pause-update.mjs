// One durable native-owner plan coordinates all registered project controllers.
// Project execution remains in the existing per-project update-plan engines.
import {readFile,mkdir,open,rename,unlink,realpath} from 'node:fs/promises';
import {dirname,isAbsolute,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {workspaceUpdateActivity} from './workspace-update.mjs';
const PHASES=new Set(['draining','ready','marking','installing','resuming','canceled','blocked','complete']);
const ID=/^[a-zA-Z0-9_-]{1,100}$/,VERSION=/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/;
const clone=value=>value==null?value:structuredClone(value);
const terminal=plan=>plan?.phase==='complete';
const approved=(child,target)=>child&&ID.test(child.id||'')&&child.kind==='pause-update'&&child.consent===true&&child.targetVersion===target;
export function createWorkspacePauseUpdate({path,currentVersion,projects,setAdmissionPaused,onChange=()=>{}}={}){
 if(!isAbsolute(path||'')||!VERSION.test(currentVersion||'')||typeof projects!=='function'||typeof setAdmissionPaused!=='function')throw new Error('Workspace update configuration is invalid.');
 let journal=null,initialized=false,beginning=false,initialError=null,tail=Promise.resolve();
 const publicStatus=()=>{
  if(!journal)return initialError?{kind:'pause-update',consent:false,id:'unavailable',phase:'blocked',targetVersion:null,targets:[],reasons:['The grouped update journal is unreadable. Preserve the global admission hold for review.'],manager:{interrupted:false}}:null;
  return {kind:'pause-update',consent:true,id:journal.id,targetVersion:journal.targetVersion,fromVersion:journal.fromVersion,phase:journal.phase,createdAt:journal.createdAt,updatedAt:journal.updatedAt,
   targets:journal.projects.flatMap(project=>(project.targets||[]).map(target=>({taskId:target.taskId,projectId:project.id,projectName:project.name,progress:target.progress||'captured'}))),
   projects:journal.projects.map(project=>({id:project.id,name:project.name,phase:project.phase||'pending',ready:project.phase==='ready'})),
   reasons:[...journal.reasons],manager:{interrupted:journal.projects.some(project=>project.managerInterrupted===true)}};
 };
 async function save(){
  journal.updatedAt=new Date().toISOString();await mkdir(dirname(path),{recursive:true,mode:0o700});
  const temporary=`${path}.${randomUUID()}.tmp`;let file;
  try{file=await open(temporary,'wx',0o600);await file.writeFile(JSON.stringify(journal)+'\n');await file.sync();await file.close();file=null;await rename(temporary,path);const folder=await open(dirname(path),'r');try{await folder.sync();}finally{await folder.close();}}
  finally{await file?.close();await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
  try{onChange(publicStatus());}catch{/* Observers cannot undo a durable barrier. */}
 }
 const ready=(async()=>{
  try{
   let raw;try{raw=await readFile(path,'utf8');}catch(error){if(error.code==='ENOENT'){initialized=true;return;}throw error;}
   if(Buffer.byteLength(raw)>1048576)throw new Error('Journal exceeds bound.');const value=JSON.parse(raw);
   if(!value||value.schema!==1||!ID.test(value.id||'')||value.kind!=='pause-update'||value.consent!==true||!PHASES.has(value.phase)||!VERSION.test(value.targetVersion||'')||!VERSION.test(value.fromVersion||'')||!Array.isArray(value.projects)||value.projects.length>64||!Array.isArray(value.reasons)||!Number.isFinite(Date.parse(value.createdAt))||typeof value.captureComplete!=='boolean'||value.resumeMode!==undefined&&!['explicit','installed'].includes(value.resumeMode)||value.projects.some(project=>!project||!ID.test(project.id||'')||!isAbsolute(project.configPath||'')||typeof project.name!=='string'||(project.childPlanId!==null&&!ID.test(project.childPlanId||''))||!Array.isArray(project.targets)))throw new Error('Invalid journal.');
   if(new Set(value.projects.map(project=>project.id)).size!==value.projects.length||new Set(value.projects.map(project=>project.configPath)).size!==value.projects.length)throw new Error('Duplicate identity.');
   journal=value;if(!terminal(journal))await setAdmissionPaused(true);initialized=true;
  }catch(error){initialError=error;try{await setAdmissionPaused(true);}catch{}throw new Error('The grouped update journal cannot be verified. Global admission must remain paused.');}
 })();
 const enqueue=fn=>{const result=tail.then(()=>ready).then(fn);tail=result.catch(()=>{});return result;};
 async function current(){
  const values=await projects();if(!Array.isArray(values)||!values.length||values.length>64)throw new Error('Registered projects are unavailable.');
  const result=[];
  for(const project of values){if(!ID.test(project?.id||'')||!isAbsolute(project?.configPath||'')||typeof project.host?.api!=='function'||typeof project.host?.updateToken!=='function')throw new Error('A registered project controller or identity is unavailable.');result.push({...project,name:typeof project.name==='string'&&project.name.trim()?project.name.trim().slice(0,160):project.id,configPath:await realpath(resolve(project.configPath))});}
  if(new Set(result.map(project=>project.id)).size!==result.length||new Set(result.map(project=>project.configPath)).size!==result.length)throw new Error('Registered project identities overlap.');return result;
 }
 async function matchingProjects(){
  const values=await current();if(!journal.captureComplete||values.length!==journal.projects.length||values.some(project=>!journal.projects.some(saved=>saved.id===project.id&&saved.configPath===project.configPath)))throw new Error('The registered project set changed or its capture is incomplete. Review the grouped update before continuing.');return values;
 }
 const hostFor=(values,project)=>values.find(value=>value.id===project.id).host;
 function remember(project,child){project.phase=child.phase;project.targets=(child.targets||[]).slice(0,4096).filter(target=>typeof target.taskId==='string').map(target=>({taskId:target.taskId,progress:typeof target.progress==='string'?target.progress.slice(0,160):'captured'}));project.managerInterrupted=child.manager?.interrupted===true;}
 async function childStatus(values,project,{adopt=false}={}){
  const result=await hostFor(values,project).api('update-plan-status'),child=result?.plan??null;
  if(!project.childPlanId&&adopt&&project.beginRequested&&approved(child,journal.targetVersion)&&child.id!==project.previousPlanId){project.childPlanId=child.id;remember(project,child);await save();}
  if(!approved(child,journal.targetVersion)||child.id!==project.childPlanId)throw new Error(`Project ${project.name} has an unavailable or changed update plan.`);
  remember(project,child);return child;
 }
 async function block(reason){journal.phase='blocked';journal.reasons=[reason];await save();await setAdmissionPaused(true);return publicStatus();}
 async function blockChildren(values,reason){
  const failures=[];for(const project of journal.projects){if(!project.childPlanId)continue;try{await hostFor(values,project).updateToken('update-plan-blocked',{planId:project.childPlanId,targetVersion:journal.targetVersion,reason});}catch{failures.push(project.name);}}
  return block(reason+(failures.length?` Child recovery could not be confirmed for ${failures.join(', ')}.`:''));
 }
 async function untouched(values,project){
  const child=(await hostFor(values,project).api('update-plan-status'))?.plan??null;
  if((child?.id??null)!==project.previousPlanId||child&&child.phase!=='complete')throw new Error('An uncaptured child plan changed.');
  project.phase='complete';
 }
 async function refresh(values){for(const project of journal.projects){if(project.beginRequested)await childStatus(values,project,{adopt:true});else await untouched(values,project);}await save();}
 async function recoveryChild(values,project,{resume=false}={}){
  let child=await childStatus(values,project,{adopt:true});
  if(child.phase==='complete'||resume&&child.phase==='resuming')return child;
  if(!['canceled','blocked'].includes(child.phase)){
   const result=await hostFor(values,project).updateToken('update-plan-blocked',{planId:project.childPlanId,targetVersion:journal.targetVersion,reason:'The user explicitly chose grouped retained-work recovery.'});
   child=result?.plan;if(!approved(child,journal.targetVersion)||child.id!==project.childPlanId||!['blocked','canceled','complete'].includes(child.phase))throw new Error('Child recovery hold was not confirmed.');remember(project,child);
  }
  return child;
 }
 async function complete(){await matchingProjects();await setAdmissionPaused(false);journal.phase='complete';journal.reasons=[];await save();return publicStatus();}
 async function tickInternal(){
  if(!journal||terminal(journal)||['blocked','canceled','marking','installing'].includes(journal.phase))return publicStatus();
  try{
   const values=await matchingProjects();await refresh(values);
   const bad=journal.projects.find(project=>['blocked','canceled'].includes(project.phase));if(bad)return block(`Project ${bad.name} requires review before the grouped update can continue.`);
   if(journal.phase==='resuming'){
    if(journal.projects.every(project=>project.phase==='complete'))return complete();
    if(journal.projects.some(project=>!['resuming','complete'].includes(project.phase)))return block('A project did not recover the expected installed update plan. Paused work is retained.');
    journal.reasons=['Waiting for every project to confirm retained-work recovery.'];await save();return publicStatus();
   }
   if(journal.projects.some(project=>!['draining','ready'].includes(project.phase)))return block('A project update plan changed while pausing work.');
   const activity=await workspaceUpdateActivity(values);journal.reasons=[...activity.reasons];
   if(journal.projects.every(project=>project.phase==='ready')&&activity.safe){journal.phase='ready';journal.reasons=[];}
   else{journal.phase='draining';if(!journal.reasons.length)journal.reasons=['Waiting for every project to finish its controlled pause.'];}
   await save();return publicStatus();
  }catch{return block('Registered project activity or child plan identity is unavailable. Global admission remains paused.');}
 }
 return {
  ready,status:()=>clone(publicStatus()),isHolding:()=>!initialized||beginning||Boolean(journal&&!terminal(journal)),
  begin(input){beginning=true;return enqueue(async()=>{
   try{
    const targetVersion=input?.targetVersion;if(!VERSION.test(targetVersion||'')||targetVersion===currentVersion)throw new Error('A different valid target version is required.');
    if(journal&&!terminal(journal)){if(journal.targetVersion===targetVersion)return publicStatus();throw new Error('Resolve the current grouped update before starting another.');}
    journal={schema:1,kind:'pause-update',consent:true,id:randomUUID(),fromVersion:currentVersion,targetVersion,phase:'draining',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),captureComplete:false,projects:[],reasons:[]};
    await save();await setAdmissionPaused(true);
    try{
     const values=await current();journal.projects=values.map(project=>({id:project.id,name:project.name,configPath:project.configPath,childPlanId:null,previousPlanId:null,beginRequested:false,phase:null,targets:[]}));journal.captureComplete=true;await save();
     // Inspect all projects before creating a child plan in any of them.
     for(const project of journal.projects){const prior=(await hostFor(values,project).api('update-plan-status'))?.plan;if(prior&&prior.phase!=='complete')throw new Error('A project already holds an update plan.');project.previousPlanId=prior?.id??null;}await save();
     for(const project of journal.projects){project.beginRequested=true;await save();const result=await hostFor(values,project).updateToken('update-plan-begin',{targetVersion});if(!approved(result?.plan,targetVersion))throw new Error('Child plan was not confirmed.');project.childPlanId=result.plan.id;remember(project,result.plan);await save();}
     return tickInternal();
    }catch{return block('Pausing could not be confirmed for every registered project. Global admission remains paused; review or cancel the retained group.');}
   }finally{beginning=false;}
  });},
  tick:()=>enqueue(tickInternal),
  cancel:()=>enqueue(async()=>{
   if(!journal||terminal(journal))return publicStatus();if(['installing','marking'].includes(journal.phase))throw new Error('Installation has begun. Preserve paused work for recovery.');
   try{const values=await matchingProjects();for(const project of journal.projects){if(!project.beginRequested)continue;const child=await childStatus(values,project,{adopt:true});if(child.phase==='complete')continue;const result=await hostFor(values,project).updateToken('update-plan-cancel',{planId:project.childPlanId,targetVersion:journal.targetVersion});if(!approved(result?.plan,journal.targetVersion)||result.plan.id!==project.childPlanId||result.plan.phase!=='canceled')throw new Error('Child cancellation was not confirmed.');remember(project,result.plan);}journal.phase='canceled';journal.reasons=['Update canceled. Choose Resume paused work or Return to work for all projects.'];await save();return publicStatus();}
   catch{return block('Cancellation could not be confirmed for every project. Global admission remains paused.');}
  }),
  resumeAfterCancel:()=>enqueue(async()=>{
   if(!journal||!['canceled','blocked'].includes(journal.phase))throw new Error('No canceled or blocked grouped update is available.');
   try{const values=await matchingProjects();for(const project of journal.projects){if(!project.beginRequested){await untouched(values,project);continue;}const child=await recoveryChild(values,project,{resume:true});if(['complete','resuming'].includes(child.phase))continue;const result=await hostFor(values,project).updateToken('update-plan-resume',{planId:project.childPlanId,targetVersion:journal.targetVersion});if(!approved(result?.plan,journal.targetVersion)||result.plan.id!==project.childPlanId||!['resuming','complete'].includes(result.plan.phase))throw new Error('Child resume was not confirmed.');remember(project,result.plan);}journal.phase='resuming';journal.resumeMode='explicit';journal.reasons=[];await save();return tickInternal();}
   catch{return block('Retained-work resume could not be confirmed for every project. Global admission remains paused.');}
  }),
  releaseForReview:()=>enqueue(async()=>{
   if(!journal||!['canceled','blocked'].includes(journal.phase))throw new Error('No canceled or blocked grouped update is available.');
   try{const values=await matchingProjects();for(const project of journal.projects){if(!project.beginRequested){await untouched(values,project);continue;}const child=await recoveryChild(values,project);if(child.phase==='complete')continue;const result=await hostFor(values,project).updateToken('update-plan-review',{planId:project.childPlanId,targetVersion:journal.targetVersion});if(!approved(result?.plan,journal.targetVersion)||result.plan.id!==project.childPlanId||result.plan.phase!=='complete')throw new Error('Child return was not confirmed.');remember(project,result.plan);}return complete();}
   catch{return block('Return to work could not be confirmed for every project. Global admission remains paused.');}
  }),
  markInstalling:input=>enqueue(async()=>{
   if(!journal||journal.phase!=='ready'||input?.planId!==journal.id||input.targetVersion!==journal.targetVersion)return {marked:false,plan:publicStatus()};
   let values;try{values=await matchingProjects();await refresh(values);if(!journal.projects.every(project=>project.phase==='ready')||!(await workspaceUpdateActivity(values)).safe)throw new Error('Fresh readiness changed.');journal.phase='marking';await save();for(const project of journal.projects){const result=await hostFor(values,project).updateToken('update-plan-installing',{planId:project.childPlanId,targetVersion:journal.targetVersion});if(result?.marked!==true)throw new Error('Child install was not confirmed.');project.phase='installing';await save();}await matchingProjects();journal.phase='installing';journal.reasons=[];await save();return {marked:true,plan:publicStatus()};}
   catch{if(values)await blockChildren(values,'Installation could not be committed for every project. No controller may be stopped; global admission remains paused.');else await block('The registered project set changed before installation. Global admission remains paused.');return {marked:false,plan:publicStatus()};}
  }),
  markBlocked:(reason,input={})=>enqueue(async()=>{
   if(!journal||terminal(journal)||journal.phase==='canceled'||input.planId!==journal.id||input.targetVersion!==journal.targetVersion)return publicStatus();
   const message=typeof reason==='string'?reason.slice(0,600):'Native installation did not finish. Retained work requires review.';
   try{return await blockChildren(await matchingProjects(),message);}catch{return block('Installation failed and registered project recovery is unavailable. Global admission remains paused.');}
  }),
  recover:()=>enqueue(async()=>{
   if(!journal||terminal(journal))return publicStatus();await setAdmissionPaused(true);
   try{
    const values=await matchingProjects();
    if(journal.phase==='marking')return blockChildren(values,'Installation was interrupted before every project committed. Review retained work before continuing.');
    if(journal.phase==='installing'){
     if(currentVersion!==journal.targetVersion)return blockChildren(values,'The approved target version was not installed. Paused work is retained.');
     await refresh(values);if(journal.projects.some(project=>!['resuming','complete'].includes(project.phase)))return blockChildren(values,'A project did not recover the approved target version. Paused work is retained.');
     journal.phase='resuming';journal.resumeMode='installed';await save();return tickInternal();
    }
    if(journal.phase==='resuming'&&journal.resumeMode!=='explicit'&&currentVersion!==journal.targetVersion)return blockChildren(values,'The target version is unavailable during grouped recovery.');
    return tickInternal();
   }catch{return block('The grouped update cannot verify its registered projects. Global admission remains paused.');}
  })
 };
}
