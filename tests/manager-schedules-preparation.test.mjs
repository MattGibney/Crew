// Combined admission/provenance test uses production coordinators with an
// in-process native transport double; no subprocess, model, service or media.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createManagerReviews} from '../src/manager/reviews/controller.mts';
import {createManagerSchedules} from '../src/manager/reviews/schedules.mts';
import {createManagerLifecycle} from '../src/manager/lifecycle.mts';
import {promptSnapshot} from '../src/manager/instructions/settings.mts';
import {createUpdateAdmission} from '../src/updates/admission.mts';
import {createUpdatePlan,isUpdatePlanHolding} from '../src/updates/plan.mts';
import {updateActivity} from '../src/updates/activity.mts';
import {createPreparationCoordinator} from '../src/preparation/coordinator.mts';
import {readPreparation,reportPreparation} from '../src/preparation/store.mts';
import {createWorkDelivery} from '../src/manager/bridge/work-delivery.mts';
import {createApplicationOrigins} from '../src/manager/bridge/origins.mts';
import {createConversationTimeline} from '../src/manager/conversation/timeline.mts';
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
const schedule={id:'private-schedule',name:'Saved follow-up',instruction:'Same factual instruction.',enabled:true,timing:{kind:'interval',minutes:10}};

async function fixture(t,{gateThread=false}={}){
 const directory=await mkdtemp(join(tmpdir(),'crew-schedule-preparation-'));await mkdir(join(directory,'state'));
 let reviews;
 t.after(async()=>{reviews?.stop();await origins.flush();await rm(directory,{recursive:true,force:true});});
 const stateDir=join(directory,'state'),statePath=join(directory,'manager.json'),gate=deferred(),entered=deferred(),timeline=createConversationTimeline(),completed=new Set(),calls=[];
 let origins=createApplicationOrigins(statePath),plan=null,sequence=0;
 await origins.ready;if(!gateThread)gate.resolve();
 const raw={threadId:'retained-manager-thread',status:'ready',activeTurnId:null,workStarting:false,voiceActive:false,voiceConnecting:false,approvals:[],managerConnected:false};
 const record=(item,turnId)=>{timeline.record(item,turnId);for(const message of timeline.snapshot())origins.observed(message);};
 const delivery=createWorkDelivery({state:()=>({...raw,connecting:raw.voiceConnecting,approvals:raw.approvals.length,instructions:'Fixture manager instructions.'}),ensureThread:async()=>{entered.resolve();await gate.promise;raw.managerConnected=true;return raw.threadId;},publishPending:value=>{raw.workStarting=value;},markStarted:id=>{raw.activeTurnId=id;raw.status='working';},completed:id=>completed.has(id),provenance:{begin:(id,origin,turn)=>origins.begin(id,origin,turn,timeline.snapshot(),[...completed]),acknowledged:id=>origins.acknowledged(id),failed:()=>origins.failed()},rpc:async(method,input)=>{
  calls.push({method,input});assert.equal(method,'turn/start','background work cannot steer active preparation');
  const turnId='fixture-turn-'+(++sequence);origins.observeTurn(turnId);
  record({id:input.clientUserMessageId,type:'userMessage',content:input.input},turnId);
  record({id:'reply-'+sequence,type:'agentMessage',text:'Routine internal commentary.'},turnId);
  completed.add(turnId);raw.activeTurnId=null;raw.status='completed';
  return{turn:{id:turnId,status:'completed'}};
 }});
 const bridge={state:()=>({...raw,messages:timeline.snapshot().filter(message=>!origins.hidden(message))}),startWork:delivery.start,cancelPendingWork:delivery.cancel,setManagerPrompt(){},stopVoice:async()=>{raw.voiceActive=false;},stopManager:async()=>{raw.status='stopped';raw.activeTurnId=null;raw.managerConnected=false;},prepare:async()=>({account:{type:'chatgpt'}}),ensureThread:async()=>{await gate.promise;raw.managerConnected=true;return raw.threadId;}};
 const manager=await createManagerLifecycle({stateDir,projectId:'combined-project',bridge,prompts:{snapshot:async()=>promptSnapshot('Fixture manager instructions.')}}),admission=createUpdateAdmission(),schedules=createManagerSchedules(stateDir);
 await schedules.ready;await schedules.save({expectedRevision:(await schedules.view()).revision,schedules:[schedule]});
 const observedManager=()=>({...bridge.state(),lifecycleState:manager.view().state});
 const engine=createUpdatePlan({stateDir,version:'0.17.0',getView:async()=>({tasks:[]}),getManager:observedManager,stopVoice:bridge.stopVoice,interruptManager:()=>assert.fail('Preparation must never interrupt'),requestAction:()=>assert.fail('No worker exists'),activity:async()=>updateActivity({work:observedManager(),view:{tasks:[]}}),preparation:createPreparationCoordinator({stateDir,projectId:'combined-project',getManager:observedManager,sendManager:(text,id,preparationId)=>bridge.startWork(text,id,{origin:{source:'preparation',operationId:preparationId}})}),onChange:value=>{plan=value;if(isUpdatePlanHolding(value))admission.hold();else admission.releaseHold();}});await engine.ready;
 reviews=createManagerReviews({stateDir,bridge,manager,controller:{view:async()=>({tasks:[]})},updateAdmission:admission,scratchpad:{snapshot:async()=>({revision:0,commitments:[],notes:[],decisions:[],questions:[]})},held:()=>isUpdatePlanHolding(plan),notice:message=>calls.push({notice:message}),schedules});
 const due=async()=>{const view=await schedules.view();await schedules.checkpoint(schedule.id,{nextAt:Date.now()-1000},view.revision);};
 return{bridge,manager,admission,schedules,reviews,engine,calls,raw,stateDir,entered:entered.promise,release:gate.resolve,due,async restoreOrigins(){await origins.flush();origins=createApplicationOrigins(statePath);await origins.ready;},async receipt(){return(await schedules.view()).schedules[0].run;}};
}

test('Quit hold arriving during scheduled native bootstrap rejects the schedule but allows only explicit preparation',async t=>{
 const f=await fixture(t,{gateThread:true});await f.due();const scheduled=f.reviews.tick();await f.entered;
 await f.engine.begin({targetVersion:'0.17.0',purpose:'quit'});assert.equal(f.admission.reserved,true);
 f.release();await scheduled;assert.equal(f.calls.length,0);assert.equal((await f.receipt()).status,'deferred');assert.equal(f.raw.workStarting,false);
 await f.engine.tick();const prep=await readPreparation(f.stateDir),participant=prep.participants.find(p=>p.role==='manager');
 assert.equal(participant.delivery.state,'acknowledged');assert.equal(f.calls.filter(call=>call.method==='turn/start').length,1,JSON.stringify(await f.receipt()));assert.deepEqual(f.bridge.state().messages,[]);
 await reportPreparation(f.stateDir,{role:'manager',projectId:'combined-project'},{preparationId:prep.id,participantId:participant.id,requestId:participant.requestId,responseId:'manager-prepared',state:'ready',note:'Fixture context retained.'});
 await f.engine.tick();assert.equal(f.engine.status().phase,'ready',f.engine.status().reasons.join(' '));
 await f.due();await f.reviews.tick();assert.equal((await f.receipt()).status,'deferred');assert.equal(f.calls.filter(call=>call.method==='turn/start').length,1);
 await f.engine.cancel();await f.engine.releaseForReview();await f.reviews.tick();assert.equal(f.calls.filter(call=>call.method==='turn/start').length,1,'missed schedule is not replayed after Return to work');
 await f.restoreOrigins();assert.deepEqual(f.bridge.state().messages,[],'preparation text remains private after provenance reload');
});

test('pending reservation defers due schedules without replay; later current schedule remains private while identical human input stays visible',async t=>{
 const f=await fixture(t),checking=deferred();const pending=f.admission.reserve(()=>checking.promise);
 await f.due();await f.reviews.tick();assert.equal(f.calls.length,0);assert.equal((await f.receipt()).status,'deferred');
 checking.resolve({safe:true,reasons:[]});await pending;f.admission.cancel();await f.reviews.tick();assert.equal(f.calls.length,0);
 await f.due();await f.reviews.tick();assert.equal(f.calls.filter(call=>call.method==='turn/start').length,1,JSON.stringify(await f.receipt()));assert.deepEqual(f.bridge.state().messages,[]);
 await f.restoreOrigins();assert.deepEqual(f.bridge.state().messages,[],'internal input and commentary never reappear after reload');
 const sameText=f.calls[0].input.input[0].text;await f.manager.run(()=>f.admission.run(()=>f.bridge.startWork(sameText,'actual-human-request')));
 assert.deepEqual(f.bridge.state().messages.map(message=>message.text),[sameText,'Routine internal commentary.']);
 assert.equal(f.bridge.state().messages[0].id,'actual-human-request');
});

for(const purpose of ['update','quit'])test(`stopped manager stays stopped across due schedule and ${purpose} preparation without spawning a replacement turn`,async t=>{
 const f=await fixture(t);await f.manager.request('stop');assert.equal(f.manager.view().state,'stopped');
 await f.due();await f.reviews.tick();assert.equal((await f.receipt()).status,'deferred');assert.equal(f.calls.length,0);
 await f.engine.begin({targetVersion:purpose==='quit'?'0.17.0':'0.18.0',purpose});await f.engine.tick();assert.equal(f.engine.status().phase,'ready',f.engine.status().reasons.join(' '));
 const prep=await readPreparation(f.stateDir);assert.equal(prep.participants.find(p=>p.role==='manager').required,false);
 await f.due();await f.reviews.tick();assert.equal(f.calls.length,0);assert.equal(f.manager.view().state,'stopped');
 await f.engine.cancel();await f.engine.releaseForReview();await f.reviews.tick();assert.equal(f.calls.length,0);assert.deepEqual(f.bridge.state().messages,[]);
});

test('native approval arriving during schedule bootstrap remains pending and prevents delivery',async t=>{
 const f=await fixture(t,{gateThread:true});await f.due();const scheduled=f.reviews.tick();await f.entered;
 f.raw.approvals=[{id:'human-approval'}];f.release();await scheduled;
 assert.equal(f.calls.length,0);assert.deepEqual(f.bridge.state().approvals,[{id:'human-approval'}]);assert.equal((await f.receipt()).status,'deferred');
 f.raw.approvals=[];await f.reviews.tick();assert.equal(f.calls.length,0,'resolving input does not replay a missed schedule');
});

test('schedule disabled during bootstrap is not delivered and its saved definition is retained',async t=>{
 const f=await fixture(t,{gateThread:true});await f.due();const scheduled=f.reviews.tick();await f.entered;
 await f.schedules.save({expectedRevision:(await f.schedules.view()).revision,schedules:[{...schedule,enabled:false}]});f.release();await scheduled;
 assert.equal(f.calls.length,0);assert.equal((await f.schedules.view()).schedules[0].enabled,false);assert.deepEqual(f.bridge.state().messages,[]);
});
