import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createUpdateCoordinator,createInstallLease,newerVersion,signedUpdateSupport,otherNativeInstances} from '../desktop/updater.mjs';
class FakeUpdater extends EventEmitter{
 calls=[];
 async checkForUpdates(){this.calls.push('check');this.emit('update-available',{version:'0.9.0'});}
 async downloadUpdate(){this.calls.push('download');this.emit('download-progress',{percent:43});this.emit('update-downloaded',{version:'0.9.0'});}
}
function fixture(overrides={}){
 const updater=new FakeUpdater(),calls=[],states=[];
 const coordinator=createUpdateCoordinator({updater,currentVersion:'0.8.0',support:{supported:true},activity:async()=>({safe:true,reasons:[]}),prepare:async()=>{calls.push('reserve');return {reserved:true};},cancel:async()=>calls.push('cancel'),stopBackend:async()=>calls.push('stop'),install:async()=>calls.push('install'),lease:{acquire:async()=>{calls.push('lock');return async()=>calls.push('unlock');}},otherInstances:async()=>[],onState:state=>states.push(state),...overrides});
 return {updater,calls,states,coordinator};
}
async function downloaded(f){await f.coordinator.request('check');await f.coordinator.request('download');}
test('manual upgrade path checks, downloads, reserves idle backend, then installs once',async()=>{
 const f=fixture();assert.equal(f.updater.autoDownload,false);assert.equal(f.updater.autoInstallOnAppQuit,false);
 assert.equal(f.updater.allowDowngrade,false);await downloaded(f);
 assert.equal(f.coordinator.getStatus().phase,'downloaded');assert.equal(f.coordinator.getStatus().downloadPercent,100);
 await f.coordinator.request('restart');assert.deepEqual(f.calls,['lock','reserve','stop','install']);
 assert.equal(f.coordinator.getStatus().phase,'installing');assert.equal(f.states.some(s=>s.downloadPercent===43),true);
 await assert.rejects(f.coordinator.request('restart'),/restarting/);
});
test('stable newer releases only; no equal version, downgrade or prerelease installation',async()=>{
 assert.equal(newerVersion('0.9.0','0.8.0'),true);assert.equal(newerVersion('0.10.0','0.9.0'),true);
 for(const value of ['0.8.0','0.7.9','0.9.0-beta.1','garbage'])assert.equal(newerVersion(value,'0.8.0'),false);
 const f=fixture();f.updater.emit('update-downloaded',{version:'0.7.0'});await assert.rejects(f.coordinator.request('restart'),/Download/);assert.deepEqual(f.calls,[]);assert.equal(f.coordinator.getStatus().phase,'idle');await f.coordinator.request('check');assert.equal(f.coordinator.getStatus().phase,'available');
});
test('every reported busy activity and unknown status blocks before controller reservation',async()=>{
 for(const activity of [undefined,{safe:false,reasons:['Voice is active.']},{safe:false,reasons:['Worker provisioning is running.']},{safe:false,reasons:['A worker question awaits an answer.']},{safe:false,reasons:[]},{safe:'yes'}]){
  const f=fixture({activity:async()=>activity});await downloaded(f);await assert.rejects(f.coordinator.request('restart'));
  assert.deepEqual(f.calls,['lock','unlock']);assert.equal(f.coordinator.getStatus().installBlocked,true);
 }
});
test('activity read errors and native instance read errors fail closed',async()=>{
 for(const overrides of [{activity:async()=>{throw Error('offline');}},{otherInstances:async()=>{throw Error('ps failed');}}]){
  const f=fixture(overrides);await downloaded(f);await assert.rejects(f.coordinator.request('restart'));
  assert.deepEqual(f.calls,['lock','unlock']);
 }
});
test('other instance blocks install; newly opened instance after reserve cancels without stopping',async()=>{
 const f=fixture({otherInstances:async()=>[123]});await downloaded(f);await assert.rejects(f.coordinator.request('restart'),/other Crew/);assert.deepEqual(f.calls,['lock','unlock']);
 let scan=0;const g=fixture({otherInstances:async()=>++scan===1?[]:[123]});await downloaded(g);await assert.rejects(g.coordinator.request('restart'),/Another Crew/);
 assert.deepEqual(g.calls,['lock','reserve','cancel','unlock']);
});
test('fresh reserve denies work begun since status read',async()=>{
 const f=fixture({prepare:async()=>({reserved:false,reasons:['Manager became active.']})});await downloaded(f);
 await assert.rejects(f.coordinator.request('restart'),/Manager became active/);assert.deepEqual(f.calls,['lock','unlock']);
});
test('install or shutdown failure cancels reservation and releases lease for retry',async()=>{
 const f=fixture({install:async()=>{throw Error('Installer failed.');}});await downloaded(f);
 await assert.rejects(f.coordinator.request('restart'),/Installer failed/);assert.deepEqual(f.calls,['lock','reserve','stop','cancel','unlock']);
 assert.equal(f.coordinator.getStatus().phase,'downloaded');assert.equal(f.updater.autoInstallOnAppQuit,false);
});
test('updater retrieval errors do not expose provider credentials or query strings',async()=>{
 const f=fixture();f.updater.checkForUpdates=async()=>{throw Error('https://user:secret@host.invalid/file?token=canary');};
 await assert.rejects(f.coordinator.request('check'),error=>!error.message.includes('secret')&&!error.message.includes('canary'));
 assert.equal(JSON.stringify(f.states).includes('canary'),false);
 f.updater.emit('error',Error('Bearer canary'));assert.equal(JSON.stringify(f.states).includes('canary'),false);
});
test('unsigned and development builds never retrieve or install updates',async()=>{
 const f=fixture({support:{supported:false,error:'Signed release required.'}});
 await assert.rejects(f.coordinator.request('check'),/Signed release/);assert.deepEqual(f.updater.calls,[]);
 assert.equal((await f.coordinator.request('status')).installBlocked,true);
});
test('requests are serialized and unsupported actions rejected',async()=>{
 let done;const f=fixture();f.updater.checkForUpdates=()=>new Promise(resolve=>done=resolve);
 const pending=f.coordinator.request('check');await assert.rejects(f.coordinator.request('download'),/already in progress/);
 await assert.rejects(f.coordinator.request('execute'),/Unknown/);done();await pending;
});
test('macOS eligibility requires valid Developer ID signature rather than ad hoc signing',async()=>{
 assert.equal((await signedUpdateSupport({packaged:false})).supported,false);
 let calls=0;const run=async()=>({stderr:++calls===2?'Authority=Developer ID Application: Test\nTeamIdentifier=ABCDE12345\n':''});
 assert.equal((await signedUpdateSupport({packaged:true,executable:'/Applications/Crew.app/Contents/MacOS/Crew',run})).supported,true);
 assert.equal((await signedUpdateSupport({packaged:true,run:async()=>({stderr:'Signature=adhoc\nTeamIdentifier=not set'})})).supported,false);
});
test('native scan blocks old main and detached module supervisors; permits only own backend tree',async()=>{
 const executable='/Applications/Crew.app/Contents/MacOS/Crew';
 const stdout=`1 100 ${executable}\n2 100 ${executable} --config /tmp/a.json\n3 1 ${executable} /Applications/Crew.app/Contents/Resources/app/server.mjs\n4 3 ${executable} /Applications/Crew.app/Contents/Resources/app/codex-bridge.mjs\n5 100 /Applications/Other.app/Contents/MacOS/Other\n6 100 ${executable} unknown\n7 100 ${executable} /Applications/Crew.app/Contents/Resources/app/worker-runner.mjs`;
 assert.deepEqual(await otherNativeInstances({executable,pid:1,backendPid:3,run:async()=>({stdout})}),[2,6,7]);
 await assert.rejects(otherNativeInstances({executable,pid:99,run:async()=>({stdout})}),/ownership snapshot/);
});
test('global lease excludes concurrent live owners, releases atomically and recovers dead PID/start',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'crew-update-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 let rows=new Map([[101,{start:'first'}],[102,{start:'second'}]]);const snapshot=async()=>rows;
 const first=createInstallLease({directory,snapshot,pid:101}),second=createInstallLease({directory,snapshot,pid:102});
 const release=await first.acquire();await assert.rejects(second.acquire(),/Another Crew/);await release();
 const release2=await second.acquire();await release2();
 await first.acquire();rows=new Map([[101,{start:'reused'}],[102,{start:'second'}]]);
 const recovered=await second.acquire();await recovered();
});
test('unknown lock owner is retained, never permission to overwrite',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'crew-update-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 await mkdir(join(directory,'installation.lock'));await writeFile(join(directory,'installation.lock','owner.json'),'{}');
 const lease=createInstallLease({directory,pid:102,snapshot:async()=>new Map([[102,{start:'second'}]])});
 await assert.rejects(lease.acquire(),/Another Crew/);
});

test('downloaded update remains ready across later periodic checks',async()=>{
 const f=fixture();await downloaded(f);await f.coordinator.request('check');
 assert.equal(f.coordinator.getStatus().phase,'downloaded');assert.deepEqual(f.updater.calls,['check','download']);
});
test('restart handoff preserves exact custom instance only for upgraded version and dead owner',async t=>{
 const {createRestartHandoff}=await import('../desktop/updater.mjs');
 const directory=await mkdtemp(join(tmpdir(),'crew-update-handoff-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 let rows=new Map([[101,{start:'old'}]]),now=1000;
 const handoff=createRestartHandoff({directory,pid:101,snapshot:async()=>rows,now:()=>now});
 await handoff.write({configPath:'/Users/test/Library/Application Support/Crew/custom/project.json',version:'0.9.0'});
 assert.equal(await handoff.consume('0.8.0'),null);assert.equal(await handoff.consume('0.9.0'),null);
 rows=new Map([[101,{start:'reused'}]]);
 assert.equal(await handoff.consume('0.9.0'),'/Users/test/Library/Application Support/Crew/custom/project.json');
 assert.equal(await handoff.consume('0.9.0'),null);
 rows=new Map([[101,{start:'new'}]]);const cancel=await handoff.write({configPath:'/tmp/project.json',version:'0.9.1'});await cancel();
 assert.equal(await handoff.consume('0.9.1'),null);
 await handoff.write({configPath:'/tmp/project.json',version:'0.9.2'});rows=new Map();now+=11*60*1000;
 assert.equal(await handoff.consume('0.9.2'),null);
});

test('concurrent recovery of a dead install owner yields one owner, never two',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'crew-update-recover-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const rows=new Map([[101,{start:'old'}],[102,{start:'second'}],[103,{start:'third'}]]),snapshot=async()=>rows;
 await createInstallLease({directory,snapshot,pid:101}).acquire();rows.delete(101);
 const results=await Promise.allSettled([createInstallLease({directory,snapshot,pid:102}).acquire(),createInstallLease({directory,snapshot,pid:103}).acquire()]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 for(const result of results)if(result.status==='fulfilled')await result.value();
});
test('explicit same-instance relaunch consumes handoff; different config never steals it',async t=>{
 const {createRestartHandoff}=await import('../desktop/updater.mjs');
 const directory=await mkdtemp(join(tmpdir(),'crew-update-relaunch-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 let rows=new Map([[101,{start:'old'}]]);
 const handoff=createRestartHandoff({directory,pid:101,snapshot:async()=>rows});
 await handoff.write({configPath:'/tmp/custom.json',version:'0.9.0'});rows=new Map();
 assert.equal(await handoff.consume('0.9.0','/tmp/other.json'),null);
 assert.equal(await handoff.consume('0.9.0','/tmp/custom.json'),'/tmp/custom.json');
 assert.equal(await handoff.consume('0.9.0'),null);
});

test('native setup admission closes before asynchronous reservation and reopens only on refusal/cancel',async()=>{
 const {createNativeUpdateGate}=await import('../desktop/updater.mjs');
 let finish,busy=false;const gate=createNativeUpdateGate({busy:()=>busy});
 const pending=gate.reserve(()=>new Promise(resolve=>finish=resolve));
 assert.throws(()=>gate.assertSetupAllowed(),/preparing an update/);
 await assert.rejects(gate.reserve(async()=>({reserved:true})),/in progress/);
 finish({reserved:true});await pending;assert.throws(()=>gate.assertSetupAllowed(),/preparing an update/);
 gate.cancel();assert.doesNotThrow(()=>gate.assertSetupAllowed());
 busy=true;let called=false;await assert.rejects(gate.reserve(async()=>{called=true;return {reserved:true};}),/in progress/);assert.equal(called,false);
 busy=false;await gate.reserve(async()=>({reserved:false}));assert.doesNotThrow(()=>gate.assertSetupAllowed());
 await assert.rejects(gate.reserve(async()=>{throw Error('controller disconnected');}),/disconnected/);assert.doesNotThrow(()=>gate.assertSetupAllowed());
});

test('restart handoff belongs to its canonical installed executable, never another Crew copy',async t=>{
 const {createRestartHandoff}=await import('../desktop/updater.mjs');
 const directory=await mkdtemp(join(tmpdir(),'crew-update-bundle-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const executable=join(directory,'Crew.app','Contents','MacOS','Crew'),otherExecutable=join(directory,'OtherCrew.app','Contents','MacOS','Crew');
 for(const file of [executable,otherExecutable]){await mkdir(join(file,'..'),{recursive:true});await writeFile(file,'old release');}
 let rows=new Map([[101,{start:'old'}]]);const options={directory,pid:101,snapshot:async()=>rows};
 const old=createRestartHandoff({...options,executable});await old.write({configPath:'/tmp/custom-instance.json',version:'0.9.1'});rows=new Map();
 assert.equal(await createRestartHandoff({...options,executable:otherExecutable}).consume('0.9.1'),null);
 // A new version replaces the binary at the same installation location.
 await writeFile(executable,'new release');
 assert.equal(await createRestartHandoff({...options,executable}).consume('0.9.1'),'/tmp/custom-instance.json');
 assert.equal(await old.consume('0.9.1'),null);
 // Existing handoffs lacking installation identity remain inert and retained.
 const legacy={configPath:'/tmp/legacy.json',version:'0.9.1',pid:101,start:'old',at:Date.now(),token:'00000000-0000-0000-0000-000000000000'};
 await writeFile(join(directory,'restart.json'),JSON.stringify(legacy));
 assert.equal(await old.consume('0.9.1'),null);
 const {readFile}=await import('node:fs/promises');assert.deepEqual(JSON.parse(await readFile(join(directory,'restart.json'),'utf8')),legacy);
});

function pauseFixture(overrides={}){
 const calls=[];let plan=null,failMark=false;
 const original=fixture(overrides.native||{});
 const engine={
  native:original.coordinator,
  begin:async input=>{calls.push('begin');plan={id:'approved-plan-1',kind:'pause-update',consent:true,phase:'draining',targetVersion:input.targetVersion};return {plan};},
  status:async()=>({plan:plan?structuredClone(plan):null}),
  cancel:async({planId})=>{calls.push('cancel-plan');assert.equal(planId,plan.id);if(plan.phase==='installing')throw Error('Installation already committed.');plan.phase='canceled';return {plan};},
  markInstalling:async({planId,targetVersion})=>{calls.push('mark-installing');if(failMark||plan.phase!=='ready'||planId!==plan.id||targetVersion!==plan.targetVersion)return {marked:false};plan.phase='installing';return {marked:true};},
  markBlocked:async()=>{calls.push('mark-blocked');if(plan.phase!=='canceled')plan.phase='blocked';return {plan};},
  ...overrides.engine,
 };
 return {original,calls,engine,get plan(){return plan;},set plan(value){plan=value;},set failMark(value){failMark=value;}};
}
async function pauseReady(f){await downloaded(f.original);await f.helper.request('pause-update');f.plan.phase='ready';}

test('approved pause plan drains without install, then only correlated ready target commits before backend stops',async()=>{
 const {createPauseUpdateCoordinator}=await import('../desktop/updater.mjs');let f;f=pauseFixture({native:{stopBackend:async()=>{assert.equal(f.plan.phase,'installing');f.original.calls.push('stop');}}});f.helper=createPauseUpdateCoordinator(f.engine);
 await downloaded(f.original);await f.helper.request('pause-update');await f.helper.advancePlan();assert.deepEqual(f.original.calls,[]);
 f.plan.phase='ready';await f.helper.advancePlan();assert.deepEqual(f.calls,['begin','mark-installing']);assert.equal(f.plan.phase,'installing');assert.deepEqual(f.original.calls,['lock','reserve','stop','install']);
});
test('durable explicit consent can be recovered, but absent consent, wrong kind, wrong target and canceled plans never install',async()=>{
 const {createPauseUpdateCoordinator}=await import('../desktop/updater.mjs');
 for(const change of [{consent:false},{kind:'something-else'},{targetVersion:'0.10.0'},{phase:'canceled'},{phase:'draining'}]){
  const f=pauseFixture();f.helper=createPauseUpdateCoordinator(f.engine);await pauseReady(f);Object.assign(f.plan,change);await f.helper.advancePlan();assert.deepEqual(f.original.calls,[]);
 }
 const recovered=pauseFixture();recovered.helper=createPauseUpdateCoordinator(recovered.engine);await pauseReady(recovered);
 recovered.helper=createPauseUpdateCoordinator(recovered.engine);await recovered.helper.advancePlan();assert.equal(recovered.original.calls.includes('install'),true);
});
test('cancel wins against an already observed ready plan while native gate check is pending',async()=>{
 const {createPauseUpdateCoordinator}=await import('../desktop/updater.mjs');const gate=deferredForUpdate();
 const f=pauseFixture({native:{activity:()=>gate.promise}});f.helper=createPauseUpdateCoordinator(f.engine);await pauseReady(f);
 const advance=f.helper.advancePlan();await new Promise(resolve=>setImmediate(resolve));await f.helper.request('cancel-pause-update');gate.resolve({safe:true,reasons:[]});
 await assert.rejects(advance,/changed or was canceled/);assert.equal(f.plan.phase,'canceled');assert.equal(f.original.calls.includes('stop'),false);assert.equal(f.original.calls.includes('install'),false);assert.equal(f.original.calls.includes('unlock'),true);
});
function deferredForUpdate(){let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};}
test('unknown or changed install confirmation rolls back reservation and cannot install',async()=>{
 const {createPauseUpdateCoordinator}=await import('../desktop/updater.mjs');const f=pauseFixture();f.helper=createPauseUpdateCoordinator(f.engine);await pauseReady(f);f.failMark=true;
 await assert.rejects(f.helper.advancePlan(),/changed or was canceled/);assert.deepEqual(f.original.calls,['lock','reserve','cancel','unlock']);assert.equal(f.plan.phase,'blocked');
});
test('native installer failure restores backend before durable blocked callback and never polling retries same plan',async()=>{
 const {createPauseUpdateCoordinator}=await import('../desktop/updater.mjs');const f=pauseFixture({native:{install:async()=>{throw Error('Synthetic install failure.');}}});f.helper=createPauseUpdateCoordinator(f.engine);await pauseReady(f);
 await assert.rejects(f.helper.advancePlan(),/Synthetic install failure/);assert.deepEqual(f.original.calls,['lock','reserve','stop','cancel','unlock']);assert.equal(f.plan.phase,'blocked');
 f.plan.phase='ready';await f.helper.advancePlan();assert.equal(f.calls.filter(value=>value==='mark-installing').length,1);
});
test('ordinary restart honors ready plan marking and refuses nonready durable plans',async()=>{
 const {createPauseUpdateCoordinator}=await import('../desktop/updater.mjs');const f=pauseFixture();f.helper=createPauseUpdateCoordinator(f.engine);await pauseReady(f);await f.helper.restart();assert.equal(f.calls.includes('mark-installing'),true);
 for(const phase of ['draining','blocked','resuming','installing','canceled']){const blocked=pauseFixture();blocked.helper=createPauseUpdateCoordinator(blocked.engine);await pauseReady(blocked);blocked.plan.phase=phase;await assert.rejects(blocked.helper.restart(),/Resume paused work or Return to work/);assert.deepEqual(blocked.original.calls,[]);}
});
test('pause requires downloaded newer signed update and does not begin from update availability alone',async()=>{
 const {createPauseUpdateCoordinator}=await import('../desktop/updater.mjs');const f=pauseFixture();f.helper=createPauseUpdateCoordinator(f.engine);
 await f.original.coordinator.request('check');await assert.rejects(f.helper.request('pause-update'),/Download a newer signed/);assert.deepEqual(f.calls,[]);
});

test('only completed plan releases native ordinary restart; canceled retains hold until explicit return',async()=>{
 const {createPauseUpdateCoordinator}=await import('../desktop/updater.mjs');const f=pauseFixture();f.helper=createPauseUpdateCoordinator(f.engine);await pauseReady(f);
 await f.helper.request('cancel-pause-update');await assert.rejects(f.helper.restart(),/Resume paused work or Return to work/);assert.equal(f.original.calls.length,0);
 f.plan.phase='complete';await f.helper.restart();assert.equal(f.original.calls.includes('install'),true);assert.equal(f.calls.includes('mark-installing'),false);
});
