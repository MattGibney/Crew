import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPreparationCoordinator} from '../runtime/preparation/coordinator.mjs';
import {readPreparation,claimPreparationDelivery,recordPreparationDelivery,reportPreparation} from '../runtime/preparation/store.mjs';
import {createUpdatePlan,isUpdatePlanHolding} from '../runtime/updates/plan.mjs';
import {createTask,updateTask} from '../runtime/orchestration/store.mjs';
import {updateActivity} from '../runtime/updates/activity.mjs';
import {parseObservedPreparation} from '../runtime/preparation/observed.mjs';

async function fixture(t,{purpose='update',managerStopped=false,managerStarting=false}={}) {
 const stateDir=await mkdtemp(join(tmpdir(),'crew-preparation-plan-'));t.after(()=>rm(stateDir,{recursive:true,force:true}));
 const data={manager:{status:managerStopped?'stopped':'completed',lifecycleState:managerStopped?'stopped':'running',threadId:'retained-manager',activeTurnId:null,workStarting:managerStarting,voiceActive:false,voiceConnecting:false,approvals:[]},tasks:[{id:'retained-worker',title:'Current implementation',ticket:'GH-62',status:'running',runId:'retained-run',threadId:'retained-worker-thread',harnessStarted:true,execution:{live:true,stopConfirmed:false},workflowState:{value:'Paused'},updateEvidence:{worker:'live',runtime:'absent',hooks:[]},lifecycleRequests:[]}],deliveries:[],actions:[],interrupts:0};
 await createTask(stateDir,{requestId:'retained-worker',ticket:'GH-62',brief:'Preparation fixture',projectId:'project'});await updateTask(stateDir,'retained-worker',task=>{task.runId='retained-run';task.threadId='retained-worker-thread';task.status='running';});
 const preparation=createPreparationCoordinator({stateDir,projectId:'project',getManager:()=>structuredClone(data.manager),sendManager:async(text,requestId)=>{data.deliveries.push({text,requestId});data.manager.status='working';data.manager.activeTurnId='preparation-turn';return {turn:{id:'preparation-turn',status:'inProgress'}};}});
 const engine=createUpdatePlan({stateDir,version:'1.0.0',preparation,getManager:()=>structuredClone(data.manager),getView:async()=>({tasks:structuredClone(data.tasks)}),stopVoice:async()=>{},interruptManager:async()=>{data.interrupts++;assert.fail('Preparation must never become an interrupt');},requestAction:async request=>{data.actions.push(request);data.tasks.find(task=>task.id===request.taskId).lifecycleRequests.push({...request,id:request.actionId,status:'processing'});},activity:async()=>updateActivity({work:data.manager,view:{tasks:data.tasks}})});await engine.ready;await engine.begin({targetVersion:purpose==='quit'?'1.0.0':'1.1.0',purpose});await engine.tick();
 async function reply(role,state='ready',responseId=role+'-ready',note='Useful continuation is saved.') {
  const plan=await readPreparation(stateDir),participant=plan.participants.find(p=>p.role===role),identity={preparationId:plan.id,participantId:participant.id,requestId:participant.requestId};
  if(role==='worker'&&participant.delivery.state==='pending'){await claimPreparationDelivery(stateDir,identity);await recordPreparationDelivery(stateDir,identity,{state:'acknowledged',nativeTurnId:'worker-turn'});}
  await reportPreparation(stateDir,role==='manager'?{role,projectId:'project'}:{role,taskId:'retained-worker',runId:'retained-run',projectId:'project'},{...identity,responseId,state,note,continuation:'Partial files and next checks remain in the retained worktree.'});
 }
 const settle=()=>{data.manager.status='completed';data.manager.activeTurnId=null;const task=data.tasks[0];task.status='paused';task.execution={live:false,stopConfirmed:true};task.updateEvidence.worker='stopped';for(const action of task.lifecycleRequests)action.status='completed';};
 return {data,engine,reply,settle,stateDir};
}
for(const purpose of ['update','quit'])test(`${purpose} preparation requires agent replies and final natural execution; arbitrary Paused workflow is not acknowledgement`,async t=>{
 const f=await fixture(t,{purpose});assert.equal(f.engine.status().phase,'draining');assert.equal(f.data.deliveries.length,1);assert.match(f.data.deliveries[0].text,/Crew preparation request/);assert.equal(f.data.actions.length,0);assert.equal(f.data.interrupts,0);
 await f.reply('manager');await f.engine.tick();assert.equal(f.data.actions.length,0,'worker workflow label is not readiness');
 await f.reply('worker');await f.engine.tick();assert.equal(f.engine.status().phase,'draining','ready replies cannot cut off final messages');assert.equal(f.data.actions.length,1);assert.equal(f.data.actions[0].settleNaturally,true);assert.equal(f.data.actions[0].cooperative,true);assert.equal(f.engine.status().preparation.participants.find(p=>p.role==='worker').settled,false);
 f.settle();await f.engine.tick();assert.equal(f.engine.status().phase,'ready');const plan=f.engine.status();const observed=parseObservedPreparation(plan.preparation);assert.ok(observed.participants.every(p=>p.response.state==='ready'&&p.settled));assert.equal((await f.engine.markInstalling({planId:plan.id,targetVersion:plan.targetVersion})).marked,true);assert.equal((await readPreparation(f.stateDir)).phase,'complete');assert.equal(f.data.interrupts,0);
 assert.equal(JSON.parse(await readFile(join(f.stateDir,'preparation.json'),'utf8')).participants[1].response.continuation,'Partial files and next checks remain in the retained worktree.');
});
test('ready revision and new native approval both preserve the final shutdown hold',async t=>{
 const f=await fixture(t);await f.reply('manager');await f.reply('worker');await f.engine.tick();f.settle();await f.engine.tick();const plan=f.engine.status();assert.equal(plan.phase,'ready');
 await f.reply('manager','needs-input','manager-decision','Need a human decision before shutdown.');await f.engine.tick();assert.equal(f.engine.status().phase,'draining');assert.match(f.engine.status().reasons.join(),/human decision/);assert.equal((await f.engine.markInstalling({planId:plan.id,targetVersion:plan.targetVersion})).marked,false);
 await f.reply('manager','ready','manager-revised');await f.engine.tick();assert.equal(f.engine.status().phase,'ready');f.data.manager.approvals=[{id:'new-pending-approval'}];assert.equal((await f.engine.markInstalling({planId:plan.id,targetVersion:plan.targetVersion})).marked,false);assert.equal(isUpdatePlanHolding(f.engine.status()),true);assert.deepEqual(f.data.manager.approvals,[{id:'new-pending-approval'}]);assert.equal(f.data.interrupts,0);
});
test('explicitly stopped manager is observed separately and never started to fabricate acknowledgement',async t=>{
 const f=await fixture(t,{managerStopped:true});const participant=f.engine.status().preparation.participants.find(p=>p.role==='manager');assert.equal(participant.required,false);assert.equal(participant.response,null);assert.equal(f.data.deliveries.length,0);assert.equal(f.data.manager.lifecycleState,'stopped');
});
test('a completed assignment remains finished and is not queued to repeat after preparation',async t=>{
 const f=await fixture(t);await f.reply('manager');await f.reply('worker');await f.engine.tick();f.settle();f.data.tasks[0].status='completed';await f.engine.tick();assert.equal(f.engine.status().phase,'ready');assert.equal(f.engine.status().targets[0].resumeEligible,false);assert.equal(f.engine.status().targets[0].progress,'prepared-and-finished');assert.equal(f.data.tasks[0].status,'completed');
});
test('observed preparation rejects malformed settlement and identity fields',async t=>{
 const f=await fixture(t);const original=f.engine.status().preparation;
 for(const change of [p=>delete p.participants[0].settled,p=>p.participants[0].required='yes',p=>p.participants[0].requestId='../bad',p=>p.participants[0].settlementReason={}]){const input=structuredClone(original);change(input);assert.throws(()=>parseObservedPreparation(input));}
});

test('explicit Return to work cancels unready blocked preparation instead of requiring shutdown readiness',async t=>{
 const f=await fixture(t);const plan=f.engine.status();await f.engine.markBlocked('Agent needs a broader human decision.',{planId:plan.id,targetVersion:plan.targetVersion});assert.equal(f.engine.status().phase,'blocked');assert.equal((await readPreparation(f.stateDir)).participants.some(p=>p.required&&!p.response),true);
 await f.engine.releaseForReview();assert.equal(f.engine.status().phase,'complete');assert.equal(isUpdatePlanHolding(f.engine.status()),false);assert.equal((await readPreparation(f.stateDir)).phase,'canceled');assert.equal(f.data.actions.length,0);assert.equal(f.data.interrupts,0);assert.equal(f.data.deliveries.length,1);
});

test('hard blocked preparation refresh is observation-only and never delivers pending manager or worker requests',async t=>{
 const f=await fixture(t,{managerStarting:true});assert.equal(f.data.deliveries.length,0);const before=f.engine.status();await f.engine.markBlocked('Preparation needs explicit human review.',{planId:before.id,targetVersion:before.targetVersion});
 f.data.manager.workStarting=false;await f.engine.tick();const saved=await readPreparation(f.stateDir);assert.equal(saved.phase,'canceled');assert.equal(f.engine.status().phase,'blocked');assert.equal(f.data.deliveries.length,0);assert.equal(f.data.actions.length,0);assert.ok(saved.participants.every(p=>p.delivery.state==='pending'));
 const worker=saved.participants.find(p=>p.role==='worker');assert.equal(await claimPreparationDelivery(f.stateDir,{preparationId:saved.id,participantId:worker.id,requestId:worker.requestId}),false);
});
test('late response from an already delivered agent remains observable after hard block without reopening work',async t=>{
 const f=await fixture(t),before=f.engine.status();assert.equal(f.data.deliveries.length,1);await f.engine.markBlocked('Keep the admission hold for review.',{planId:before.id,targetVersion:before.targetVersion});await f.reply('manager','ready','manager-late-ready','Factual continuation saved after the request was blocked.');f.data.manager.status='completed';f.data.manager.activeTurnId=null;await f.engine.tick();assert.equal(f.engine.status().phase,'blocked');assert.equal(f.engine.status().preparation.participants.find(p=>p.role==='manager').response.state,'ready');assert.equal((await readPreparation(f.stateDir)).phase,'canceled');assert.equal(f.data.deliveries.length,1);assert.equal(f.data.actions.length,0);
});
test('a newly queued verified unstarted task settles under the hold without inventing another agent acknowledgement',async t=>{
 const f=await fixture(t);f.data.tasks.push({id:'queued-after-capture',status:'queued',runId:null,harnessStarted:false,updateEvidence:{worker:'absent',runtime:'absent',hooks:[]},lifecycleRequests:[]});await f.reply('manager');await f.reply('worker');await f.engine.tick();
 const queued=f.data.tasks.find(task=>task.id==='queued-after-capture'),action=f.data.actions.find(action=>action.taskId===queued.id);assert.ok(action);assert.equal(action.expectedRunId,null);assert.equal(action.settleNaturally,true);assert.equal(action.cooperative,true);assert.equal((await readPreparation(f.stateDir)).participants.some(p=>p.taskId===queued.id),false);
 f.settle();queued.status='paused';queued.lifecycleRequests[0].status='completed';await f.engine.tick();assert.equal(f.engine.status().phase,'ready');assert.equal(f.engine.status().targets.find(target=>target.taskId===queued.id).pauseConfirmed,true);assert.equal(f.data.deliveries.length,1);assert.equal(f.data.interrupts,0);
});
test('newly observed queued work with uncertain spawn evidence never receives the unstarted exception',async t=>{
 const f=await fixture(t);f.data.tasks.push({id:'uncertain-new-queue',status:'queued',runId:null,harnessStarted:'pending',spawnIntentAt:new Date().toISOString(),updateEvidence:{worker:'unknown',runtime:'absent',hooks:[]},lifecycleRequests:[]});await f.reply('manager');await f.reply('worker');await f.engine.tick();assert.match(f.engine.status().reasons.join(),/uncertain-new-queue preparation evidence is unavailable/);assert.equal(f.data.actions.some(action=>action.taskId==='uncertain-new-queue'),false);assert.equal(f.engine.status().phase,'draining');
});
