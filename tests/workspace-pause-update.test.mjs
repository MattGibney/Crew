import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {createWorkspacePauseUpdate} from '../desktop/workspace-pause-update.mjs';
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
async function fixture(t,{childPhase='ready'}={}){
 const directory=await mkdtemp(join(tmpdir(),'crew-group-update-')),path=join(directory,'group.json');t.after(()=>rm(directory,{recursive:true,force:true}));
 const calls=[],children=new Map(),activity=new Map(),changes=[];let paused=false,values=[];
 for(const id of ['alpha','beta']){
  const configPath=join(directory,id+'.json');await writeFile(configPath,'{}');children.set(id,null);activity.set(id,{safe:true,reasons:[]});
  const host={api:async route=>{calls.push(`${id}:${route}`);return route==='update-plan-status'?{plan:structuredClone(children.get(id))}:activity.get(id);},updateToken:async(route,input)=>{
   calls.push(`${id}:${route}`);assert.equal(paused,true,'global hold precedes child mutation');let child=children.get(id);
   if(route==='update-plan-begin'){const journal=JSON.parse(await readFile(path,'utf8'));assert.equal(journal.captureComplete,true);assert.equal(journal.projects.length,values.length);child={id:randomUUID(),kind:'pause-update',consent:true,targetVersion:input.targetVersion,phase:childPhase,targets:[{taskId:id+'-worker',progress:'paused'}],manager:{interrupted:id==='beta'}};children.set(id,child);return {plan:structuredClone(child)};}
   assert.equal(input.planId,child.id);assert.equal(input.targetVersion,child.targetVersion);
   if(route==='update-plan-installing'){if(child.phase!=='ready')return {marked:false,plan:structuredClone(child)};child.phase='installing';return {marked:true,plan:structuredClone(child)};}
   if(route==='update-plan-blocked'){if(!['complete','canceled'].includes(child.phase))child.phase='blocked';return {plan:structuredClone(child)};}
   if(route==='update-plan-cancel'){if(child.phase==='installing')throw Error('Already installing');child.phase='canceled';return {plan:structuredClone(child)};}
   if(route==='update-plan-resume'){assert.ok(['canceled','blocked'].includes(child.phase));child.phase='resuming';return {plan:structuredClone(child)};}
   if(route==='update-plan-review'){assert.ok(['canceled','blocked'].includes(child.phase));child.phase='complete';return {plan:structuredClone(child)};}
   throw Error('Unexpected child route');
  }};values.push({id,name:id==='alpha'?'Selected':'Hidden',configPath,host});
 }
 const options={path,currentVersion:'1.0.0',projects:async()=>values,setAdmissionPaused:async value=>{calls.push(`global:${value}`);paused=value;},onChange:value=>changes.push(value)};
 const engine=createWorkspacePauseUpdate(options);await engine.ready;
 return {engine,path,calls,children,activity,changes,options,get paused(){return paused;},get values(){return values;},set values(value){values=value;},make:async version=>{const next=createWorkspacePauseUpdate({...options,currentVersion:version});await next.ready;return next;}};
}

test('unknown startup is holding; explicit begin durably holds every project before child side effects and strips paths publicly',async t=>{
 const f=await fixture(t);const startup=createWorkspacePauseUpdate(f.options);assert.equal(startup.isHolding(),true);await startup.ready;assert.equal(startup.isHolding(),false);
 const plan=await f.engine.begin({targetVersion:'1.1.0'});assert.equal(plan.phase,'ready');assert.equal(f.paused,true);assert.equal(f.engine.isHolding(),true);assert.equal(plan.projects.length,2);assert.equal(plan.manager.interrupted,true);
 assert.deepEqual(plan.targets.map(target=>[target.taskId,target.projectId,target.projectName]),[['alpha-worker','alpha','Selected'],['beta-worker','beta','Hidden']]);
 assert.equal(JSON.stringify(plan).includes(f.values[0].configPath),false);assert.equal((await stat(f.path)).mode&0o777,0o600);
 assert.ok(f.calls.indexOf('global:true')<f.calls.indexOf('alpha:update-plan-begin'));assert.ok(f.calls.includes('beta:update-activity'));
});
test('hidden draining, unsafe and unreachable projects never make group ready',async t=>{
 const f=await fixture(t,{childPhase:'draining'});await f.engine.begin({targetVersion:'1.1.0'});assert.equal(f.engine.status().phase,'draining');
 for(const child of f.children.values())child.phase='ready';f.activity.set('beta',{safe:false,reasons:['Hidden worker active']});await f.engine.tick();assert.equal(f.engine.status().phase,'draining');assert.match(f.engine.status().reasons.join(),/Hidden.*Hidden worker active/);
 f.values[1].host.api=async()=>{throw Error('Offline');};await f.engine.tick();assert.equal(f.engine.status().phase,'blocked');assert.equal(f.paused,true);
});
test('all child installation markers precede group install commit; matching new version recovers all children before release',async t=>{
 const f=await fixture(t);const plan=await f.engine.begin({targetVersion:'1.1.0'});const ids=[...f.children.values()].map(child=>child.id);
 const result=await f.engine.markInstalling({planId:plan.id,targetVersion:'1.1.0'});assert.equal(result.marked,true);assert.equal(JSON.parse(await readFile(f.path,'utf8')).phase,'installing');assert.ok([...f.children.values()].every(child=>child.phase==='installing'));
 for(const child of f.children.values())child.phase='resuming';const next=await f.make('1.1.0');await next.recover();assert.equal(next.status().phase,'resuming');assert.equal(f.paused,true);
 f.children.get('alpha').phase='complete';await next.tick();assert.equal(f.paused,true);f.children.get('beta').phase='complete';await next.tick();assert.equal(next.status().phase,'complete');assert.equal(next.isHolding(),false);assert.equal(f.paused,false);
 assert.deepEqual([...f.children.values()].map(child=>child.id),ids);assert.equal(f.calls.filter(call=>call.endsWith('update-plan-resume')).length,0);
});
test('partial child install refusal blocks every child and never releases global hold',async t=>{
 const f=await fixture(t);const plan=await f.engine.begin({targetVersion:'1.1.0'}),normal=f.values[1].host.updateToken;
 f.values[1].host.updateToken=async(route,input)=>route==='update-plan-installing'?{marked:false}:normal(route,input);
 const result=await f.engine.markInstalling({planId:plan.id,targetVersion:'1.1.0'});assert.equal(result.marked,false);assert.equal(result.plan.phase,'blocked');assert.ok([...f.children.values()].every(child=>child.phase==='blocked'));assert.equal(f.paused,true);assert.equal(f.calls.includes('global:false'),false);
});
test('cancel retains hold and explicit return confirms every child before releasing',async t=>{
 const f=await fixture(t);await f.engine.begin({targetVersion:'1.1.0'});await f.engine.cancel();assert.equal(f.engine.status().phase,'canceled');assert.equal(f.engine.isHolding(),true);assert.equal(f.paused,true);
 await f.engine.releaseForReview();assert.equal(f.engine.status().phase,'complete');assert.equal(f.calls.filter(call=>call.endsWith('update-plan-review')).length,2);assert.equal(f.calls.some(call=>call.endsWith('update-plan-resume')),false);assert.equal(f.calls.at(-1),'global:false');
});
test('explicit resume keeps global hold until all child recovery completes',async t=>{
 const f=await fixture(t);await f.engine.begin({targetVersion:'1.1.0'});await f.engine.cancel();await f.engine.resumeAfterCancel();assert.equal(f.engine.status().phase,'resuming');assert.equal(f.paused,true);assert.equal(f.calls.filter(call=>call.endsWith('update-plan-resume')).length,2);
 for(const child of f.children.values())child.phase='complete';await f.engine.tick();assert.equal(f.paused,false);
});
test('registry additions, canonical configuration changes and child identity replacement fail closed',async t=>{
 for(const change of ['add','config','child']){
  const f=await fixture(t);const plan=await f.engine.begin({targetVersion:'1.1.0'});
  if(change==='add'){const configPath=f.values[0].configPath+'.new';await writeFile(configPath,'{}');f.values=[...f.values,{...f.values[0],id:'gamma',configPath}];}
  if(change==='config'){const configPath=f.values[0].configPath+'.new';await writeFile(configPath,'{}');f.values[0].configPath=configPath;}
  if(change==='child')f.children.get('beta').id=randomUUID();
  assert.equal((await f.engine.markInstalling({planId:plan.id,targetVersion:'1.1.0'})).marked,false);assert.equal(f.engine.status().phase,'blocked');assert.equal(f.paused,true);
 }
});
test('lost child begin response can be reconciled for explicit cancellation without touching unrelated old plan',async t=>{
 const f=await fixture(t),normal=f.values[1].host.updateToken;f.values[1].host.updateToken=async(route,input)=>{const result=await normal(route,input);if(route==='update-plan-begin')throw Error('Response lost');return result;};
 await f.engine.begin({targetVersion:'1.1.0'});assert.equal(f.engine.status().phase,'blocked');await f.engine.cancel();assert.equal(f.engine.status().phase,'canceled');assert.ok([...f.children.values()].every(child=>child.phase==='canceled'));assert.equal(f.paused,true);
});
test('wrong-version or interrupted partial-mark startup keeps every project held and blocked',async t=>{
 for(const phase of ['installing','marking']){
  const f=await fixture(t);const plan=await f.engine.begin({targetVersion:'1.1.0'});await f.engine.markInstalling({planId:plan.id,targetVersion:'1.1.0'});const journal=JSON.parse(await readFile(f.path,'utf8'));journal.phase=phase;await writeFile(f.path,JSON.stringify(journal));
  const next=await f.make(phase==='marking'?'1.1.0':'1.0.0');await next.recover();assert.equal(next.status().phase,'blocked');assert.equal(next.isHolding(),true);assert.equal(f.paused,true);assert.equal(f.calls.includes('global:false'),false);
 }
});
test('cancel and install operations serialize: cancellation first prevents every install marker',async t=>{
 const f=await fixture(t);const plan=await f.engine.begin({targetVersion:'1.1.0'});const canceled=f.engine.cancel(),install=f.engine.markInstalling({planId:plan.id,targetVersion:'1.1.0'});await canceled;assert.equal((await install).marked,false);assert.equal(f.calls.some(call=>call.endsWith('update-plan-installing')),false);
});
test('pending child begin is synchronously holding and forced registry mutation blocks final readiness',async t=>{
 const f=await fixture(t),pending=deferred(),entered=deferred(),normal=f.values[0].host.updateToken;f.values[0].host.updateToken=async(route,input)=>{if(route==='update-plan-begin'){entered.resolve();await pending.promise;}return normal(route,input);};
 const begun=f.engine.begin({targetVersion:'1.1.0'});assert.equal(f.engine.isHolding(),true);await entered.promise;f.values=f.values.slice(0,1);pending.resolve();await begun;assert.equal(f.engine.status().phase,'blocked');assert.equal(f.paused,true);
});
test('unreadable persisted journal is never replaced and startup retains global hold',async t=>{
 const f=await fixture(t);await writeFile(f.path,'{broken');const next=createWorkspacePauseUpdate(f.options);assert.equal(next.isHolding(),true);await assert.rejects(next.ready,/cannot be verified/);assert.equal(next.isHolding(),true);assert.equal(f.paused,true);assert.equal(await readFile(f.path,'utf8'),'{broken');
});
test('unconfirmed partial cancellation never releases global admission',async t=>{
 const f=await fixture(t);await f.engine.begin({targetVersion:'1.1.0'});const normal=f.values[1].host.updateToken;f.values[1].host.updateToken=async(route,input)=>route==='update-plan-cancel'?{plan:null}:normal(route,input);await f.engine.cancel();assert.equal(f.engine.status().phase,'blocked');assert.equal(f.paused,true);assert.equal(f.calls.includes('global:false'),false);
});

test('partial recovery Return creates no new resume, preserves existing queue consent and confirms every review before release',async t=>{
 const f=await fixture(t);await f.engine.begin({targetVersion:'1.1.0'});await f.engine.cancel();const normal=f.values[1].host.updateToken;
 f.values[1].host.updateToken=async(route,input)=>{if(route==='update-plan-resume')throw Error('Recovery temporarily unavailable');return normal(route,input);};
 await f.engine.resumeAfterCancel();assert.equal(f.engine.status().phase,'blocked');assert.equal(f.children.get('alpha').phase,'resuming');assert.equal(f.paused,true);
 const resumed=f.calls.filter(call=>call.endsWith('update-plan-resume')).length;
 await f.engine.releaseForReview();assert.equal(f.engine.status().phase,'complete');assert.equal(f.paused,false);assert.equal(f.calls.filter(call=>call.endsWith('update-plan-resume')).length,resumed);assert.ok([...f.children.values()].every(child=>child.phase==='complete'));
});
test('partial begin can explicitly return without mutating unbegun project plans',async t=>{
 const f=await fixture(t);const normal=f.values[0].host.updateToken;f.values[0].host.updateToken=async(route,input)=>{const result=await normal(route,input);if(route==='update-plan-begin')throw Error('Response lost');return result;};
 await f.engine.begin({targetVersion:'1.1.0'});assert.equal(f.engine.status().phase,'blocked');assert.equal(f.children.get('beta'),null);
 await f.engine.releaseForReview();assert.equal(f.engine.status().phase,'complete');assert.equal(f.children.get('beta'),null);assert.equal(f.paused,false);assert.equal(f.calls.some(call=>call==='beta:update-plan-review'),false);
});
test('retrying explicit recovery skips children already recovering or complete instead of creating duplicate resumes',async t=>{
 const f=await fixture(t);await f.engine.begin({targetVersion:'1.1.0'});await f.engine.cancel();const normal=f.values[1].host.updateToken;let reject=true;
 f.values[1].host.updateToken=async(route,input)=>{if(route==='update-plan-resume'&&reject)throw Error('Unavailable');return normal(route,input);};
 await f.engine.resumeAfterCancel();f.children.get('alpha').phase='complete';reject=false;await f.engine.resumeAfterCancel();assert.equal(f.calls.filter(call=>call==='alpha:update-plan-resume').length,1);assert.equal(f.calls.filter(call=>call==='beta:update-plan-resume').length,1);assert.equal(f.engine.status().phase,'resuming');
 f.children.get('beta').phase='complete';await f.engine.tick();assert.equal(f.paused,false);
});

test('explicit old-version recovery consent survives process restart without duplicate resume or target-version requirement',async t=>{
 const f=await fixture(t);await f.engine.begin({targetVersion:'1.1.0'});await f.engine.cancel();await f.engine.resumeAfterCancel();
 const count=f.calls.filter(call=>call.endsWith('update-plan-resume')).length,next=await f.make('1.0.0');await next.recover();assert.equal(next.status().phase,'resuming');assert.equal(f.calls.filter(call=>call.endsWith('update-plan-resume')).length,count);assert.equal(f.paused,true);
 for(const child of f.children.values())child.phase='complete';await next.tick();assert.equal(next.status().phase,'complete');assert.equal(f.paused,false);
});
test('cancel after partial recovery skips complete children and retains hold for remaining projects',async t=>{
 const f=await fixture(t);await f.engine.begin({targetVersion:'1.1.0'});const normal=f.values[1].host.updateToken;
 f.values[1].host.updateToken=async(route,input)=>route==='update-plan-installing'?{marked:false}:normal(route,input);const plan=f.engine.status();await f.engine.markInstalling({planId:plan.id,targetVersion:plan.targetVersion});
 f.children.get('alpha').phase='complete';await f.engine.cancel();assert.equal(f.engine.status().phase,'canceled');assert.equal(f.children.get('alpha').phase,'complete');assert.equal(f.children.get('beta').phase,'canceled');assert.equal(f.paused,true);
});
