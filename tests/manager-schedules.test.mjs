import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createManagerSchedules,nextScheduleAt,validateSchedules} from '../src/manager/reviews/schedules.mts';
import {createScheduleRunner} from '../src/manager/reviews/schedule-runner.mts';
const custom=(id='worker-check')=>({id,name:'Check worker',instruction:'Check my saved worker.',enabled:true,timing:{kind:'interval',minutes:10}});
async function fixture(t){let at=Date.parse('2026-10-22T10:00Z');const dir=await mkdtemp(join(tmpdir(),'crew-schedules-'));t.after(()=>rm(dir,{recursive:true,force:true}));const store=createManagerSchedules(dir,()=>at);await store.ready;return {store,dir,now:()=>at,advance:n=>at+=n};}
test('schedule definitions validate timing and survive reload with optimistic concurrency',async t=>{
 const f=await fixture(t),initial=await f.store.view();
 assert.equal(initial.schedules.length,1);assert.equal(initial.schedules[0].id,'commitment-review');
 await f.store.save({expectedRevision:initial.revision,schedules:[custom(),{...custom('daily'),timing:{kind:'daily',time:'09:00',timeZone:'Europe/London'}}]});
 await assert.rejects(f.store.save({expectedRevision:initial.revision,schedules:[]}),/changed/);
 const again=createManagerSchedules(f.dir,f.now);assert.deepEqual((await again.view()).schedules.map(s=>s.id),['worker-check','daily']);
 assert.throws(()=>validateSchedules([{...custom(),timing:{kind:'daily',time:'25:01',timeZone:'Europe/London'}}]),/interval/);
 assert.throws(()=>validateSchedules([{...custom(),timing:{kind:'daily',time:'09:01',timeZone:'bad-zone'}}]),/time zone/);
});
test('stopped/held manager skips due work without backlog, then runs one current slot',async t=>{
 const f=await fixture(t);await f.store.save({expectedRevision:(await f.store.view()).revision,schedules:[custom()]});
 let allowed=false,calls=0;const runner=createScheduleRunner({store:f.store,now:f.now,eligible:async()=>allowed,run:async()=>{calls++;return {};}});
 f.advance(10*60000);await runner.tick();assert.equal(calls,0);assert.equal((await f.store.view()).schedules[0].run.status,'deferred');
 allowed=true;await runner.tick();assert.equal(calls,0);
 f.advance(6*3600000);await runner.tick();assert.equal(calls,1);await runner.tick();assert.equal(calls,1);
 runner.stop();f.advance(10*60000);await runner.tick();assert.equal(calls,1);
});
test('concurrent timer ticks cannot submit duplicate work and unknown delivery is not replayed',async t=>{
 const f=await fixture(t);await f.store.save({expectedRevision:(await f.store.view()).revision,schedules:[custom()]});
 let release;const gate=new Promise(resolve=>release=resolve);let calls=0;
 const runner=createScheduleRunner({store:f.store,now:f.now,eligible:async()=>true,run:async()=>{calls++;await gate;throw new Error('Delivery uncertain');}});
 f.advance(600000);const first=runner.tick();while(calls===0)await new Promise(r=>setTimeout(r,2));await runner.tick();assert.equal(calls,1);release();await first;
 const reopened=createManagerSchedules(f.dir,f.now);assert.equal((await reopened.view()).schedules[0].run.status,'error');
 await createScheduleRunner({store:reopened,now:f.now,eligible:async()=>true,run:async()=>calls++}).tick();assert.equal(calls,1);
});
test('daily timing follows explicit timezone and never repeats a fall-back daily slot',()=>{
 const next=nextScheduleAt({kind:'daily',time:'09:00',timeZone:'Europe/London'},Date.parse('2026-10-24T08:01Z'));
 assert.equal(new Date(next).toISOString(),'2026-10-25T09:00:00.000Z');
 const fallback=nextScheduleAt({kind:'daily',time:'01:30',timeZone:'Europe/London'},Date.parse('2026-10-25T00:30Z'));
 assert.equal(new Date(fallback).toISOString(),'2026-10-26T01:30:00.000Z');
});

test('deleting or disabling a schedule during the admission await prevents its dispatch',async t=>{
 const f=await fixture(t);await f.store.save({expectedRevision:(await f.store.view()).revision,schedules:[custom()]});f.advance(600000);
 let calls=0,checks=0;
 const runner=createScheduleRunner({store:f.store,now:f.now,eligible:async()=>{if(++checks===1)await f.store.save({expectedRevision:(await f.store.view()).revision,schedules:[]});return true;},run:async()=>calls++});
 await runner.tick();assert.equal(calls,0);assert.deepEqual((await f.store.view()).schedules,[]);
});

test('saved disable/instruction changes invalidate final native-admission snapshots immediately',async t=>{
 const f=await fixture(t);await f.store.save({expectedRevision:(await f.store.view()).revision,schedules:[custom()]});
 const selected=(await f.store.view()).schedules[0];assert.equal(f.store.current(selected),true);
 await f.store.save({expectedRevision:(await f.store.view()).revision,schedules:[{...custom(),enabled:false}]});assert.equal(f.store.current(selected),false);
 await f.store.save({expectedRevision:(await f.store.view()).revision,schedules:[{...custom(),instruction:'A different instruction'}]});assert.equal(f.store.current(selected),false);
});
