import test from 'node:test';
import assert from 'node:assert/strict';
import {createPreparationQuit} from '../runtime/desktop/preparation-quit.mjs';

function fixture() {
 const calls=[];
 let plan=null,held=false,quitting=false;
 const children=['selected','hidden'].map(id=>({id,phase:'pending'}));
 const group={
  status:()=>structuredClone(plan),
  async begin(input){calls.push(['begin',input]);held=true;plan={id:'quit-plan',kind:'pause-update',purpose:input.purpose,consent:true,targetVersion:input.targetVersion,phase:'draining',targets:[]};return structuredClone(plan);},
  async markInstalling(input){calls.push(['mark-all',input]);if(plan?.phase!=='ready'||plan.id!==input.planId||plan.targetVersion!==input.targetVersion)return{marked:false,plan:structuredClone(plan)};for(const child of children)child.phase='installing';plan.phase='installing';return{marked:true,plan:structuredClone(plan)};},
  async markBlocked(reason,input){calls.push(['blocked',input]);if(plan&&plan.id===input.planId&&plan.phase!=='complete'){plan.phase='blocked';plan.reasons=[reason];}},
 };
 const context={
  currentVersion:'0.16.2',group,
  async assertCanBegin(){calls.push(['guard']);},
  async showProgress(){calls.push(['show-window']);},
  async activity(){calls.push(['activity']);return{safe:true,reasons:[]};},
  lease:{async acquire(){calls.push(['lease']);return async()=>{calls.push(['release']);};}},
  setQuitting(value){quitting=value;calls.push(['quitting',value]);},
  async stopOwnedControllers(){assert.equal(held,true);assert.ok(children.every(child=>child.phase==='installing'),'all children precede the first shutdown');for(const child of children)calls.push(['stop',child.id]);},
  finish(){calls.push(['exit']);},
 };
 const coordinator=createPreparationQuit(context);
 return {coordinator,context,calls,children,get held(){return held;},get quitting(){return quitting;},get plan(){return plan;},set plan(value){plan=value;}};
}

test('explicit Quit begins current-version shared preparation and opens control surface while every controller remains running',async()=>{
 const f=fixture();await f.coordinator.begin();
 assert.deepEqual(f.calls,[['guard'],['begin',{targetVersion:'0.16.2',purpose:'quit'}],['show-window']]);
 assert.equal(f.held,true);assert.equal(f.quitting,false);assert.equal(f.plan.phase,'draining');
 await f.coordinator.advance();assert.equal(f.calls.some(call=>['lease','stop','exit'].includes(call[0])),false);
 await f.coordinator.begin();assert.equal(f.calls.filter(call=>call[0]==='begin').length,1);assert.equal(f.calls.filter(call=>call[0]==='show-window').length,2);
});

test('ready Quit verifies every project twice, marks every child, then closes owned controllers once without invoking an installer',async()=>{
 const f=fixture();await f.coordinator.begin();f.plan.phase='ready';
 await Promise.all([f.coordinator.advance(),f.coordinator.advance()]);
 assert.deepEqual(f.calls.slice(3),[['activity'],['lease'],['activity'],['mark-all',{planId:'quit-plan',targetVersion:'0.16.2'}],['quitting',true],['stop','selected'],['stop','hidden'],['release'],['exit']]);
 assert.equal(f.held,true);assert.equal(f.plan.phase,'installing');assert.equal(f.quitting,true);
 await f.coordinator.advance();assert.equal(f.calls.filter(call=>call[0]==='exit').length,1);
});

test('an update purpose or incomplete agent preparation never triggers native Quit',async()=>{
 for(const phase of ['draining','blocked','canceled','resuming','installing']){
  const f=fixture();await f.coordinator.begin();f.plan.phase=phase;await f.coordinator.advance();assert.equal(f.calls.some(call=>call[0]==='stop'),false,phase);
 }
 const f=fixture();await f.coordinator.begin();f.plan.purpose='update';f.plan.phase='ready';await f.coordinator.advance();assert.equal(f.calls.some(call=>call[0]==='lease'),false);
 await assert.rejects(f.coordinator.begin(),/current update preparation/);assert.equal(f.plan.purpose,'update');
});

test('fresh activity changing while acquiring lease keeps the shared hold and every controller running',async()=>{
 const f=fixture();await f.coordinator.begin();f.plan.phase='ready';let checks=0;
 f.context.activity=async()=>({safe:++checks===1,reasons:['Hidden project approval needs a human response.']});
 await assert.rejects(f.coordinator.advance(),/Hidden project approval/);
 assert.equal(f.plan.phase,'blocked');assert.equal(f.held,true);assert.equal(f.quitting,false);
 assert.match(f.plan.reasons.join(' '),/Hidden project approval/);
 assert.equal(f.calls.some(call=>call[0]==='stop'),false);assert.equal(f.calls.filter(call=>call[0]==='release').length,1);
 await f.coordinator.advance();assert.equal(f.calls.filter(call=>call[0]==='lease').length,1);
});

test('failed all-project final marker blocks Quit before any owned controller stops',async()=>{
 const f=fixture();await f.coordinator.begin();f.plan.phase='ready';
 f.context.group.markInstalling=async()=>({marked:false,plan:structuredClone(f.plan)});
 await assert.rejects(f.coordinator.advance(),/Every project/);
 assert.equal(f.plan.phase,'blocked');assert.equal(f.held,true);assert.equal(f.calls.some(call=>call[0]==='stop'),false);
 assert.equal(f.calls.filter(call=>call[0]==='release').length,1);
});

test('partial owned shutdown failure retains prepared evidence and hold without exiting, restarting or retrying controllers',async()=>{
 const f=fixture();await f.coordinator.begin();f.plan.phase='ready';
 f.context.stopOwnedControllers=async()=>{f.calls.push(['stop','selected']);throw Error('Hidden controller exit is not confirmed');};
 await assert.rejects(f.coordinator.advance(),/not confirmed/);
 assert.equal(f.plan.phase,'blocked');assert.equal(f.held,true);assert.equal(f.quitting,false);assert.ok(f.children.every(child=>child.phase==='installing'));
 assert.equal(f.calls.some(call=>call[0]==='exit'),false);await f.coordinator.advance();
 assert.equal(f.calls.filter(call=>call[0]==='stop').length,1);assert.equal(f.calls.filter(call=>call[0]==='release').length,1);
});

test('canceling while final observation is pending cannot pass the Quit barrier',async()=>{
 const f=fixture();await f.coordinator.begin();f.plan.phase='ready';let entered,release;
 const waiting=new Promise(resolve=>{entered=resolve;}),continueCheck=new Promise(resolve=>{release=resolve;});
 f.context.activity=async()=>{entered();await continueCheck;return{safe:true};};
 const advancing=f.coordinator.advance();await waiting;f.plan.phase='complete';release();await assert.rejects(advancing,/Every project/);
 assert.equal(f.calls.some(call=>call[0]==='stop'),false);assert.equal(f.plan.phase,'complete');
});

test('a mismatched final barrier response cannot close controllers even when marked true',async()=>{
 const f=fixture();await f.coordinator.begin();f.plan.phase='ready';
 f.context.group.markInstalling=async()=>({marked:true,plan:{...f.plan,phase:'installing',targetVersion:'different-version'}});
 await assert.rejects(f.coordinator.advance(),/Every project/);assert.equal(f.calls.some(call=>call[0]==='stop'),false);assert.equal(f.plan.phase,'blocked');
});
