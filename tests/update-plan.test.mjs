import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createUpdatePlan, readUpdatePlan, isUpdatePlanHolding } from '../runtime/updates/plan.mjs';
async function fixture(t, overrides = {}) {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crew-update-plan-'));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  const data = { tasks: [], manager: { status: 'ready', workStarting: false, activeTurnId: null, approvals: [] }, safe: true, requests: [], voiceStops: 0, interrupts: 0, time: Date.now() };
  const options = { stateDir, version: '1.0.0', getView: async () => ({ tasks: structuredClone(data.tasks) }), getManager: async () => structuredClone(data.manager),
    stopVoice: async () => { assert.ok(isUpdatePlanHolding(await readUpdatePlan(stateDir))); data.voiceStops++; },
    interruptManager: async () => { data.interrupts++; }, requestAction: async request => { if (!data.requests.some(r => r.actionId === request.actionId)) data.requests.push(request); },
    activity: async () => ({ safe: data.safe, reasons: data.safe ? [] : ['Not idle yet'] }), now: () => data.time, ...overrides };
  const engine = createUpdatePlan(options); await engine.ready;
  const restart = async version => { const next = createUpdatePlan({ ...options, version }); await next.ready; return next; };
  return { engine, data, stateDir, options, restart };
}
async function beginDrain(f, options) { await f.engine.begin(options); return f.engine.tick(); }
const running = id => ({ id, runId: `run-${id}`, status: 'running', harnessStarted: true, execution: { live: true, stopConfirmed: false }, lifecycleRequests: [] });
function finishPause(task, request) { task.status = 'paused'; task.execution = { live: false, stopConfirmed: true }; task.lifecycleRequests.push({ ...request, id: request.actionId, status: 'completed' }); }
async function prepareOne(t) {
  const f = await fixture(t); f.data.tasks.push(running('worker1')); f.data.safe = false;
  await beginDrain(f, { targetVersion: '1.1.0' });
  finishPause(f.data.tasks[0], f.data.requests[0]); f.data.safe = true;
  await f.engine.tick(); return f;
}
test('durable hold precedes voice stop and captures queued plus running workers', async t => {
  const f = await fixture(t); f.data.tasks = [running('worker1'), { id: 'queued1', status: 'queued', runId: null }]; f.data.safe = false;
  const plan = await beginDrain(f, { targetVersion: '1.1.0' });
  assert.equal(plan.phase, 'draining'); assert.equal(plan.kind, 'pause-update'); assert.equal(plan.consent, true);
  assert.equal(plan.targets.length, 2); assert.equal(f.data.voiceStops, 1); assert.equal(f.data.requests.length, 2);
  assert.ok(f.data.requests.every(r => r.cooperative === true && r.action === 'pause'));
  assert.equal((await fs.stat(path.join(f.stateDir, 'update-plan.json'))).mode & 0o777, 0o600);
});
test('status alone does not establish pause; fresh process and global evidence required', async t => {
  const f = await fixture(t); const task = running('worker1'); f.data.tasks.push(task); f.data.safe = true;
  await beginDrain(f, { targetVersion: '1.1.0' });
  task.status = 'paused'; await f.engine.tick(); assert.equal(f.engine.status().phase, 'draining');
  task.lifecycleRequests = [{ ...f.data.requests[0], id: f.data.requests[0].actionId, status: 'completed' }];
  await f.engine.tick(); assert.equal(f.engine.status().phase, 'draining');
  task.execution = { live: false, stopConfirmed: true }; f.data.safe = false;
  await f.engine.tick(); assert.equal(f.engine.status().phase, 'draining');
  f.data.safe = true; await f.engine.tick(); assert.equal(f.engine.status().phase, 'ready');
});
test('manager interruption waits for terminal state and rescans newly agreed tasks', async t => {
  const f = await fixture(t); f.data.manager.activeTurnId = 'turn1'; f.data.manager.status = 'working';
  await beginDrain(f, { targetVersion: '1.1.0' }); assert.equal(f.data.interrupts, 1); assert.equal(f.engine.status().phase, 'draining');
  f.data.tasks.push({ id: 'queued-late', status: 'queued', runId: null });
  await f.engine.tick(); assert.equal(f.data.interrupts, 1); assert.equal(f.engine.status().targets.length, 1);
  f.data.manager.activeTurnId = null; f.data.manager.status = 'ready';
  await f.engine.tick(); assert.equal(f.data.requests.length, 1); assert.equal(f.engine.status().manager.interrupted, true);
});
test('pending approvals retained without auto-interrupt or answer', async t => {
  const f = await fixture(t); f.data.manager.approvals.push({ id: 'approval1' });
  await beginDrain(f, { targetVersion: '1.1.0' }); assert.equal(f.data.interrupts, 0); assert.match(f.engine.status().reasons.join(), /approvals/);
});
test('install checks exact identity and fresh safe activity; cancel race cannot install', async t => {
  const f = await prepareOne(t); const plan = f.engine.status();
  assert.equal((await f.engine.markInstalling({ planId: 'wrong', targetVersion: '1.1.0' })).marked, false);
  await f.engine.cancel(); assert.equal(isUpdatePlanHolding(f.engine.status()), true);
  assert.equal((await f.engine.markInstalling({ planId: plan.id, targetVersion: plan.targetVersion })).marked, false);
});
test('new target version resumes only correlated plan-paused workers once in order', async t => {
  const f = await prepareOne(t); const plan = f.engine.status();
  f.data.tasks.push({ id: 'manual-pause', status: 'paused', runId: 'manual' }, { id: 'failed', status: 'failed' });
  assert.equal((await f.engine.markInstalling({ planId: plan.id, targetVersion: plan.targetVersion })).marked, true);
  const restarted = await f.restart('1.1.0'); await restarted.recover();
  assert.equal(restarted.status().phase, 'resuming'); assert.equal(f.data.requests.length, 2);
  const resume = f.data.requests[1]; assert.equal(resume.action, 'resume'); assert.equal(resume.taskId, 'worker1');
  // A repeated tick does not append another request when the durable lifecycle request exists.
  f.data.tasks[0].lifecycleRequests.push({ ...resume, id: resume.actionId, status: 'pending' });
  await restarted.tick(); assert.equal(f.data.requests.length, 2);
  f.data.tasks[0].lifecycleRequests.at(-1).status = 'completed'; f.data.tasks[0].runId = 'new-run'; f.data.tasks[0].status = 'running';
  await restarted.tick(); assert.equal(restarted.status().phase, 'complete'); assert.equal(isUpdatePlanHolding(restarted.status()), false);
  assert.equal(f.data.voiceStops, 1);
});
test('same-version install restart blocks; explicit resume retained work is available', async t => {
  const f = await prepareOne(t); const plan = f.engine.status();
  await f.engine.markInstalling({ planId: plan.id, targetVersion: plan.targetVersion });
  const restarted = await f.restart('1.0.0'); await restarted.recover();
  assert.equal(restarted.status().phase, 'blocked'); assert.equal(f.data.requests.length, 1); assert.ok(isUpdatePlanHolding(restarted.status()));
  await restarted.resumeAfterCancel(); assert.equal(f.data.requests.at(-1).action, 'resume');
});
test('cancel leaves paused work until explicit resume; unanswered question prevents resume', async t => {
  const f = await prepareOne(t); await f.engine.cancel(); assert.equal(f.data.requests.length, 1);
  f.data.tasks[0].question = { id: 'question1', message: 'Need human answer' };
  await f.engine.resumeAfterCancel(); assert.equal(f.engine.status().phase, 'blocked'); assert.equal(f.data.requests.length, 1);
});
test('timeout blocks without force cleanup; stale run prevents resume', async t => {
  const f = await fixture(t); f.data.tasks.push(running('worker1')); f.data.safe = false;
  await beginDrain(f, { targetVersion: '1.1.0' }); f.data.time += 120001;
  await f.engine.tick(); assert.equal(f.engine.status().phase, 'blocked'); assert.equal(f.data.requests.length, 1);
  assert.match(f.engine.status().reasons.join(), /timed out/);
});
test('malformed persisted plan fails closed and is never recreated', async t => {
  const f = await fixture(t); const file = path.join(f.stateDir, 'update-plan.json'); await fs.writeFile(file, '{broken');
  await assert.rejects(readUpdatePlan(f.stateDir), /unreadable/); const next = createUpdatePlan(f.options); await assert.rejects(next.ready, /unreadable/);
  assert.equal(await fs.readFile(file, 'utf8'), '{broken'); assert.ok(isUpdatePlanHolding({ phase: 'unknown' }));
});
test('native failure keeps hold and correlated explicit recovery state', async t => {
  const f = await prepareOne(t); const plan = f.engine.status();
  await f.engine.markInstalling({ planId: plan.id, targetVersion: plan.targetVersion });
  await f.engine.markBlocked('Native installation failed', { planId: plan.id, targetVersion: plan.targetVersion });
  assert.equal(f.engine.status().phase, 'blocked'); assert.ok(isUpdatePlanHolding(f.engine.status())); assert.equal(f.data.requests.length, 1);
});
test('manager completed/interrupted/canceled states are terminal evidence', async t => {
  for (const status of ['completed','interrupted','canceled','cancelled']) {
    const f = await fixture(t); f.data.manager.status = status;
    const plan = await beginDrain(f, {targetVersion:'1.1.0'});
    assert.equal(plan.phase,'ready'); assert.equal(f.data.interrupts,0);
  }
});
test('workStarting without turn ID waits then interrupts the correlated active turn', async t => {
  const f = await fixture(t); f.data.manager.workStarting = true; f.data.manager.status = 'starting';
  await beginDrain(f, {targetVersion:'1.1.0'}); assert.equal(f.data.interrupts,0);
  assert.equal(f.engine.status().manager.interruptRequested,false);
  f.data.manager.activeTurnId='later-turn'; f.data.manager.workStarting=false; f.data.manager.status='working';
  await f.engine.tick(); assert.equal(f.data.interrupts,1); assert.equal(f.engine.status().manager.interruptTurnId,'later-turn');
});
test('historical servicesStarted flag on stopped/manual-paused environment never requests pause', async t => {
  const f = await fixture(t); f.data.tasks.push({id:'manual',runId:'manual-run',status:'paused',environment:{servicesStarted:true,runtime:{status:'stopped'}}});
  await beginDrain(f, {targetVersion:'1.1.0'}); assert.equal(f.data.requests.length,0); assert.equal(f.engine.status().targets.length,0);
});
test('manual/failed tasks drain only positively live fresh evidence, never unknown records', async t => {
  const f = await fixture(t); f.data.safe=false;
  f.data.tasks = [
    {id:'unknown',status:'failed',runId:'unknown-run',execution:{live:true},environment:{runtime:{status:'running'}},updateEvidence:{worker:'unknown',runtime:'unknown',hooks:[]}},
    {id:'live-env',status:'paused',runId:'env-run',updateEvidence:{worker:'stopped',runtime:'live',hooks:[]}},
  ];
  await beginDrain(f, {targetVersion:'1.1.0'});
  assert.deepEqual(f.data.requests.map(r=>r.taskId),['live-env']);
  assert.equal(f.engine.status().targets[0].resumeEligible,false); assert.equal(f.engine.status().phase,'draining');
});
test('fresh shutdown evidence gates readiness independently of historical execution fields', async t => {
  const f = await fixture(t); const task=running('worker1'); f.data.tasks.push(task); f.data.safe=true;
  await beginDrain(f, {targetVersion:'1.1.0'}); finishPause(task,f.data.requests[0]);
  task.updateEvidence={worker:'unknown',runtime:'absent',hooks:[]};
  await f.engine.tick(); assert.equal(f.engine.status().phase,'draining');
  task.updateEvidence.worker='stopped'; await f.engine.tick(); assert.equal(f.engine.status().phase,'ready');
});
test('failed worker with positively live environment is paused, never marked already finished', async t => {
  const f = await fixture(t); f.data.safe=false;
  f.data.tasks.push({id:'failed-env',status:'failed',runId:'env-run',updateEvidence:{worker:'stopped',runtime:'live',hooks:[]}});
  await beginDrain(f, {targetVersion:'1.1.0'});
  assert.equal(f.data.requests.length,1); assert.equal(f.data.requests[0].action,'pause'); assert.equal(f.engine.status().targets[0].resumeEligible,false);
});
test('begin is a durable responsive intent; cancel before any pause retains launch hold', async t => {
  const f=await fixture(t); f.data.tasks.push({id:'queued1',status:'queued',runId:null});
  const plan=await f.engine.begin({targetVersion:'1.1.0'});
  assert.equal(plan.phase,'draining'); assert.equal(f.data.requests.length,0); assert.equal(f.data.voiceStops,0);
  await f.engine.cancel(); await f.engine.tick();
  assert.equal(isUpdatePlanHolding(await readUpdatePlan(f.stateDir)),true); assert.equal(f.data.requests.length,0);
  const repeated=await f.engine.begin({targetVersion:'1.1.0'}); assert.equal(repeated.phase,'canceled'); assert.equal(repeated.id,plan.id);
  await f.engine.resumeAfterCancel(); assert.equal(f.engine.status().phase,'complete'); assert.equal(isUpdatePlanHolding(f.engine.status()),false);
});
test('workers pause while manager approval blocks update; no approval is answered', async t => {
  const f=await fixture(t); f.data.manager.approvals=[{id:'approval1'}]; f.data.tasks.push(running('worker1'));
  await beginDrain(f,{targetVersion:'1.1.0'});
  assert.equal(f.data.requests.length,1); assert.equal(f.data.requests[0].cooperative,true); assert.equal(f.data.interrupts,0);
  assert.match(f.engine.status().reasons.join(),/approvals/); assert.equal(f.data.manager.approvals.length,1);
});
test('explicit return to work releases canceled hold without resuming paused tasks', async t => {
  const f=await prepareOne(t); await f.engine.cancel(); assert.equal(isUpdatePlanHolding(f.engine.status()),true);
  await f.engine.releaseForReview(); assert.equal(f.engine.status().phase,'complete'); assert.equal(f.data.requests.length,1);
  assert.equal(f.data.tasks[0].status,'paused'); assert.equal(isUpdatePlanHolding(f.engine.status()),false);
});
test('answered historical question remains eligible and user-queued recovery creates no duplicate resume', async t => {
  const f=await fixture(t); const task=running('worker1'); task.status='resume_queued'; task.question={id:'question1'}; task.answer={questionId:'question1'};
  f.data.tasks.push(task); f.data.safe=false; await beginDrain(f,{targetVersion:'1.1.0'});
  assert.equal(f.engine.status().targets[0].resumeEligible,true); finishPause(task,f.data.requests[0]); f.data.safe=true; await f.engine.tick(); await f.engine.cancel();
  task.status='resume_queued'; await f.engine.resumeAfterCancel();
  assert.equal(f.engine.status().phase,'complete'); assert.equal(f.data.requests.length,1);
});
test('partial failed pause with stopped worker and live runtime blocks explicit resume', async t => {
  const f=await fixture(t); const task=running('worker1'); f.data.tasks.push(task); f.data.safe=false;
  await beginDrain(f,{targetVersion:'1.1.0'});
  task.status='failed'; task.execution={live:false,stopConfirmed:true};
  task.updateEvidence={worker:'stopped',runtime:'live',hooks:[]};
  task.lifecycleRequests.push({...f.data.requests[0],id:f.data.requests[0].actionId,status:'failed'});
  await f.engine.cancel(); const result=await f.engine.resumeAfterCancel();
  assert.equal(result.phase,'blocked'); assert.equal(isUpdatePlanHolding(result),true); assert.equal(f.data.requests.length,1);
  assert.match(result.reasons.join(),/never confirmed/); assert.doesNotMatch(result.progress.at(-1).message,/was resumed/);
  await f.engine.releaseForReview(); assert.equal(f.engine.status().phase,'complete'); assert.equal(f.data.requests.length,1);
});
test('unconfirmed active or unknown target cannot silently finish explicit resume', async t => {
  for (const worker of ['live','unknown']) {
    const f=await fixture(t); const task=running('worker1'); task.updateEvidence={worker,runtime:'absent',hooks:[]}; f.data.tasks.push(task);
    await f.engine.begin({targetVersion:'1.1.0'}); await f.engine.cancel();
    await f.engine.resumeAfterCancel(); assert.equal(f.engine.status().phase,'blocked'); assert.equal(f.data.requests.length,0);
  }
});

test('manager finishing during awaited worker pause does not block; exact pause and process evidence still gate readiness', async t => {
  let entered, release;
  const enqueued = new Promise(resolve => { entered = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, {
    requestAction: async request => {
      f.data.requests.push(request);
      entered();
      await pending;
    },
    interruptManager: async ({ expectedTurnId }) => {
      f.data.interrupts++;
      assert.equal(f.data.manager.activeTurnId, expectedTurnId, 'never interrupt a turn that naturally finished');
    },
  });
  f.data.manager = { status:'working', workStarting:false, activeTurnId:'finishing-turn', approvals:[] };
  const task = running('worker1'); f.data.tasks.push(task); f.data.safe = false;
  await f.engine.begin({targetVersion:'1.1.0'});
  const ticking = f.engine.tick();
  await enqueued;
  f.data.manager.activeTurnId = null; f.data.manager.status = 'completed';
  task.status = 'paused';
  release();
  await ticking;
  assert.equal(f.engine.status().phase,'draining'); assert.equal(f.data.interrupts,0);
  await f.engine.tick(); assert.equal(f.engine.status().phase,'draining','card status is not lifecycle confirmation');
  task.lifecycleRequests.push({...f.data.requests[0],id:f.data.requests[0].actionId,status:'completed'});
  await f.engine.tick(); assert.equal(f.engine.status().phase,'draining','completed pause without stopped process is insufficient');
  task.execution = {live:false,stopConfirmed:true}; f.data.safe = true;
  await f.engine.tick(); assert.equal(f.engine.status().phase,'ready');
  assert.equal(f.engine.status().targets[0].pauseConfirmed,true); assert.equal(f.data.interrupts,0);
  assert.equal(f.engine.status().manager.interrupted,false,'natural completion is not claimed as interruption');
});

test('manager completing after final recheck permits fresh terminal evidence when interrupt rejects', async t => {
  const f = await fixture(t, { interruptManager: async ({expectedTurnId}) => {
    assert.equal(expectedTurnId,'finishing-turn'); f.data.interrupts++;
    f.data.manager.activeTurnId=null; f.data.manager.status='completed';
    throw new Error('Native turn already completed');
  }});
  f.data.manager = {status:'working',workStarting:false,activeTurnId:'finishing-turn',approvals:[]};
  await beginDrain(f,{targetVersion:'1.1.0'});
  assert.notEqual(f.engine.status().phase,'blocked'); assert.equal(f.data.interrupts,1);
  await f.engine.tick(); assert.equal(f.engine.status().phase,'ready');
});

for (const replacement of ['new-turn','approval']) test(`manager ${replacement} appearing during worker enqueue is preserved without interrupting it`, async t => {
  const f = await fixture(t,{requestAction:async request=>{
    f.data.requests.push(request);
    if(replacement==='new-turn') f.data.manager.activeTurnId='different-turn';
    else f.data.manager.approvals=[{id:'new-human-decision'}];
  }});
  f.data.manager={status:'working',workStarting:false,activeTurnId:'captured-turn',approvals:[]};
  f.data.tasks.push(running('worker1')); f.data.safe=false;
  await beginDrain(f,{targetVersion:'1.1.0'});
  assert.equal(f.data.interrupts,0); assert.equal(isUpdatePlanHolding(f.engine.status()),true);
  if(replacement==='new-turn') { assert.equal(f.engine.status().phase,'blocked'); assert.equal(f.data.manager.activeTurnId,'different-turn'); }
  else { assert.notEqual(f.engine.status().phase,'ready'); assert.deepEqual(f.data.manager.approvals,[{id:'new-human-decision'}]); }
});

for (const replacement of ['new-turn','approval','unknown']) test(`rejected manager interrupt retains hold for ${replacement} instead of assuming completion`, async t => {
  const f = await fixture(t,{interruptManager:async()=>{
    f.data.interrupts++;
    if(replacement==='new-turn') f.data.manager.activeTurnId='different-turn';
    else if(replacement==='approval') {f.data.manager.activeTurnId=null;f.data.manager.status='completed';f.data.manager.approvals=[{id:'pending-human-decision'}];}
    else {f.data.manager.activeTurnId=null;f.data.manager.status='connection lost';}
    throw new Error('Native interruption could not be confirmed');
  }});
  f.data.manager={status:'working',workStarting:false,activeTurnId:'captured-turn',approvals:[]};
  await beginDrain(f,{targetVersion:'1.1.0'});
  assert.equal(f.engine.status().phase,'blocked'); assert.equal(isUpdatePlanHolding(f.engine.status()),true);
  assert.equal(f.data.interrupts,1);
  if(replacement==='approval') assert.deepEqual(f.data.manager.approvals,[{id:'pending-human-decision'}]);
  if(replacement==='new-turn') assert.equal(f.data.manager.activeTurnId,'different-turn');
  if(replacement==='unknown') assert.equal(f.data.manager.status,'connection lost');
});

for (const phase of ['blocked','canceled']) test(`${phase} update observes later exact worker pause proof without releasing hold or executing recovery`, async t => {
  const f=await fixture(t); f.data.safe=false;
  f.data.manager={status:'working',workStarting:false,activeTurnId:'retained-manager-turn',approvals:[]};
  const task=running('worker1'); f.data.tasks.push(task);
  await beginDrain(f,{targetVersion:'1.1.0'});
  if(phase==='blocked') {f.data.time+=120001;await f.engine.tick();}
  else await f.engine.cancel();
  const retained=f.engine.status(),requests=structuredClone(f.data.requests),interrupts=f.data.interrupts,voiceStops=f.data.voiceStops;
  assert.equal(retained.phase,phase); assert.equal(retained.targets[0].progress,'pause-requested');
  task.status='paused';
  await f.engine.tick(); assert.equal(f.engine.status().targets[0].pauseConfirmed,false,'a paused card alone is insufficient');
  task.lifecycleRequests.push({...requests[0],id:requests[0].actionId,status:'completed'});
  task.updateEvidence={worker:'unknown',runtime:'absent',hooks:[]};
  await f.engine.tick(); assert.equal(f.engine.status().targets[0].pauseConfirmed,false,'unknown process ownership still blocks confirmation');
  task.execution={live:false,stopConfirmed:true};task.updateEvidence.worker='stopped';f.data.safe=true;
  await f.engine.tick();
  for(const engine of [f.engine,await f.restart('1.0.0')]) {
    await engine.tick();await engine.tick();
    const observed=engine.status();
    assert.equal(observed.phase,phase);assert.equal(isUpdatePlanHolding(observed),true);
    assert.deepEqual(observed.reasons,retained.reasons,'observation must not clear the explicit recovery blocker');
    assert.equal(observed.targets[0].progress,'paused');assert.equal(observed.targets[0].pauseConfirmed,true);
    assert.equal(observed.targets[0].pauseActionId,retained.targets[0].pauseActionId);
    assert.deepEqual(observed.manager,retained.manager,'worker proof never fabricates manager interruption');
    assert.deepEqual(f.data.requests,requests,'no additional pause or resume is authorized by observation');
    assert.equal(f.data.interrupts,interrupts);assert.equal(f.data.voiceStops,voiceStops);
  }
});
