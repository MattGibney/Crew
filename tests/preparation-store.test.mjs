import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {beginPreparation,readPreparation,claimPreparationDelivery,recordPreparationDelivery,reportPreparation,getPreparationRequest,cancelPreparation,setPreparationPhase} from '../src/preparation/store.mts';
import {createTask,updateTask} from '../src/orchestration/store.mts';
import {createRunnerPreparation} from '../src/workers/runner-preparation.mts';
async function fixture(t) {
 const state=await mkdtemp(path.join(tmpdir(),'crew-preparation-store-'));t.after(()=>rm(state,{recursive:true,force:true}));
 const actor={role:'worker',projectId:'project-one',taskId:'worker-one',runId:'run-one'};
 await createTask(state,{requestId:actor.taskId,ticket:'GH-62',brief:'Disposable preparation contract',projectId:actor.projectId});
 await updateTask(state,actor.taskId,task=>{task.runId=actor.runId;task.threadId='thread-one';task.status='running';});
 const input={id:'preparation-one',purpose:'update',projectId:actor.projectId,participants:[{id:'participant-one',role:'worker',taskId:actor.taskId,runId:actor.runId,threadId:'thread-one',requestId:'request-one',required:true,message:'Preserve a sensible stopping point.'}]};
 const identity={preparationId:input.id,participantId:'participant-one',requestId:'request-one'};
 await beginPreparation(state,input);
 return {state,actor,input,identity,response:{...identity,responseId:'response-one',state:'ready',note:'Factual continuation preserved.',continuation:'Continue from the retained draft.'}};
}
test('preparation durable claim is exclusive and exact delivery/response retries survive reload',async t=>{
 const f=await fixture(t);const original=await readPreparation(f.state);
 assert.deepEqual(await beginPreparation(f.state,f.input),original);
 await assert.rejects(beginPreparation(f.state,{...f.input,purpose:'quit'}),/reused/);
 assert.deepEqual((await Promise.all([claimPreparationDelivery(f.state,f.identity),claimPreparationDelivery(f.state,f.identity)])).sort(),[false,true]);
 await recordPreparationDelivery(f.state,f.identity,{state:'acknowledged',nativeTurnId:'turn-one'});
 const reported=await reportPreparation(f.state,f.actor,f.response);
 assert.deepEqual(await reportPreparation(f.state,f.actor,f.response),reported);
 await reportPreparation(f.state,f.actor,{...f.response,responseId:'response-two',state:'needs-input',note:'Need the human to resolve an existing approval.'});
 assert.deepEqual(await reportPreparation(f.state,f.actor,f.response),reported,'Earlier exact retries do not replace the latest response');
 const saved=await readPreparation(f.state);assert.equal(saved.participants[0].response.state,'needs-input');assert.equal(saved.participants[0].responses.length,2);assert.equal((await stat(path.join(f.state,'preparation.json'))).mode&0o777,0o600);
 await assert.rejects(reportPreparation(f.state,f.actor,{...f.response,note:'Changed retry'}),/reused/);
 await assert.rejects(setPreparationPhase(f.state,f.input.id,'ready'),/Required/);
});
test('preparation rejects stale identities, roles, projects and worker runs',async t=>{
 const f=await fixture(t);await claimPreparationDelivery(f.state,f.identity);await recordPreparationDelivery(f.state,f.identity,{state:'acknowledged',nativeTurnId:'turn-one'});
 for(const actor of [{...f.actor,role:'manager'},{...f.actor,projectId:'other-project'},{...f.actor,taskId:'other-worker'},{...f.actor,runId:'other-run'}])await assert.rejects(reportPreparation(f.state,actor,f.response),/another|binding/);
 await assert.rejects(reportPreparation(f.state,f.actor,{...f.response,requestId:'other-request'}),/Stale/);
 await updateTask(f.state,f.actor.taskId,task=>{task.runId='later-run';});
 await assert.rejects(reportPreparation(f.state,f.actor,f.response),/context changed/);
});
test('cancellation prevents delivery but retains final responses from already delivered agents without reopening',async t=>{
 const f=await fixture(t);await claimPreparationDelivery(f.state,f.identity);await recordPreparationDelivery(f.state,f.identity,{state:'acknowledged',nativeTurnId:'turn-one'});
 await cancelPreparation(f.state,f.input.id);await reportPreparation(f.state,f.actor,f.response);await reportPreparation(f.state,f.actor,{...f.response,responseId:'late-context',state:'preparing',note:'Final factual context retained after cancellation.'});
 assert.equal((await readPreparation(f.state)).phase,'canceled');assert.equal(await claimPreparationDelivery(f.state,f.identity),false);
 const next={...f.input,id:'preparation-two'};await beginPreparation(f.state,next);await cancelPreparation(f.state,next.id);assert.equal(await claimPreparationDelivery(f.state,{...f.identity,preparationId:next.id}),false);
 await assert.rejects(reportPreparation(f.state,f.actor,{...f.response,preparationId:next.id}),/not been delivered/);
});
test('ready acknowledgement is revisable and does not grant completed preparation or create execution',async t=>{
 const f=await fixture(t);await claimPreparationDelivery(f.state,f.identity);await recordPreparationDelivery(f.state,f.identity,{state:'acknowledged',nativeTurnId:'turn-one'});await reportPreparation(f.state,f.actor,f.response);
 assert.equal((await readPreparation(f.state)).phase,'preparing');await setPreparationPhase(f.state,f.input.id,'ready');await reportPreparation(f.state,f.actor,{...f.response,responseId:'revision',state:'blocked',note:'Owned resources still need attention.'});assert.equal((await readPreparation(f.state)).phase,'preparing');
 await assert.rejects(setPreparationPhase(f.state,f.input.id,'complete'),/Required/);await reportPreparation(f.state,f.actor,{...f.response,responseId:'final-ready'});await setPreparationPhase(f.state,f.input.id,'complete');await assert.rejects(reportPreparation(f.state,f.actor,f.response),/completed/);
});
test('worker preparation claims before steering exact native turn and never repeats uncertain delivery after recovery',async t=>{
 const f=await fixture(t);let calls=0;
 const options={stateDir:f.state,actor:f.actor,snapshot:()=>({threadId:'thread-one',turnId:'turn-one',acknowledged:true,ending:false}),onPreparing:()=>{},steer:async request=>{calls++;assert.equal(request.expectedTurnId,'turn-one');assert.match(request.text,/report_preparation/);assert.equal((await readPreparation(f.state)).participants[0].delivery.state,'attempted');throw Error('Disposable transport lost its reply');}};
 await createRunnerPreparation(options)();assert.equal((await readPreparation(f.state)).participants[0].delivery.state,'uncertain');await createRunnerPreparation(options)();assert.equal(calls,1);
});
test('worker without an acknowledged active turn reports failed delivery and never starts a replacement',async t=>{
 const f=await fixture(t);const observe=createRunnerPreparation({stateDir:f.state,actor:f.actor,snapshot:()=>({threadId:'thread-one',turnId:null,acknowledged:false,ending:false}),onPreparing:()=>{},steer:async()=>assert.fail('No replacement native turn')});await observe();assert.equal((await readPreparation(f.state)).participants[0].delivery.state,'failed');
});
test('malformed preparation state is retained and never treated as an absent request',async t=>{
 const f=await fixture(t),target=path.join(f.state,'preparation.json');const plan=await readPreparation(f.state);plan.participants[0].response={responseId:'forged',state:'ready',note:'Not in history',at:new Date().toISOString()};const raw=JSON.stringify(plan);await writeFile(target,raw);await assert.rejects(getPreparationRequest(f.state,f.actor),/history/);assert.equal(await readFile(target,'utf8'),raw);
});
test('unstarted optional participants remain observational and historical terminal plans are preserved',async t=>{
 const f=await fixture(t);await cancelPreparation(f.state,f.input.id);const optional={...f.input,id:'preparation-optional',participants:[{...f.input.participants[0],runId:null,threadId:null,required:false}]};await beginPreparation(f.state,optional);assert.equal(await claimPreparationDelivery(f.state,{...f.identity,preparationId:optional.id}),false);assert.equal(JSON.parse(await readFile(path.join(f.state,'preparations',f.input.id+'.json'),'utf8')).phase,'canceled');await cancelPreparation(f.state,optional.id);await assert.rejects(beginPreparation(f.state,f.input),/historical/);
});
test('a crash after durable attempted claim never permits another native send',async t=>{
 const f=await fixture(t);await claimPreparationDelivery(f.state,f.identity);let called=false;await createRunnerPreparation({stateDir:f.state,actor:f.actor,snapshot:()=>({threadId:'thread-one',turnId:'turn-one',acknowledged:true,ending:false}),onPreparing:()=>{},steer:async()=>{called=true;return{turnId:'turn-one'};}})();assert.equal(called,false);assert.equal((await readPreparation(f.state)).participants[0].delivery.state,'attempted');
});
test('atomic preparation close and concurrent readiness revocation cannot both succeed',async t=>{
 const f=await fixture(t);await claimPreparationDelivery(f.state,f.identity);await recordPreparationDelivery(f.state,f.identity,{state:'acknowledged',nativeTurnId:'turn-one'});await reportPreparation(f.state,f.actor,f.response);
 const [revoked,closed]=await Promise.allSettled([reportPreparation(f.state,f.actor,{...f.response,responseId:'readiness-revoked',state:'blocked',note:'Fresh resource observation needs human review.'}),setPreparationPhase(f.state,f.input.id,'complete')]);
 assert.notEqual(revoked.status,closed.status,'Exactly one linearized change may succeed');const plan=await readPreparation(f.state);if(closed.status==='fulfilled'){assert.equal(plan.phase,'complete');assert.equal(plan.participants[0].response.state,'ready');}else{assert.equal(plan.phase,'preparing');assert.equal(plan.participants[0].response.state,'blocked');}
});
test('scoped ready response proves receipt despite uncertain native steering acknowledgement without rewriting transport or replaying',async t=>{
 const f=await fixture(t);await claimPreparationDelivery(f.state,f.identity);await recordPreparationDelivery(f.state,f.identity,{state:'uncertain',error:'The native steering reply was lost.'});
 await assert.rejects(setPreparationPhase(f.state,f.input.id,'ready'),/Required/);await assert.rejects(setPreparationPhase(f.state,f.input.id,'complete'),/Required/);
 await assert.rejects(reportPreparation(f.state,{...f.actor,runId:'other-run'},f.response),/another worker run/);
 await reportPreparation(f.state,f.actor,f.response);await setPreparationPhase(f.state,f.input.id,'ready');assert.equal(await claimPreparationDelivery(f.state,f.identity),false);
 const completed=await setPreparationPhase(f.state,f.input.id,'complete');assert.equal(completed.participants[0].delivery.state,'uncertain');assert.equal(completed.participants[0].response.state,'ready');assert.equal(completed.participants[0].delivery.nativeTurnId,undefined);
});
test('a scoped ready response arriving before the steering RPC reply permits close while transport remains attempted',async t=>{
 const f=await fixture(t);await claimPreparationDelivery(f.state,f.identity);await reportPreparation(f.state,f.actor,f.response);await setPreparationPhase(f.state,f.input.id,'complete');assert.equal((await readPreparation(f.state)).participants[0].delivery.state,'attempted');assert.equal(await claimPreparationDelivery(f.state,f.identity),false);
});
