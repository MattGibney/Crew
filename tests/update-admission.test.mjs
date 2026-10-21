import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createUpdateAdmission} from '../runtime/updates/admission.mjs';
import {createBridge} from '../runtime/manager/bridge/index.mjs';
const deferred=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve:value=>resolve(value)};};
test('an admitted async request prevents reservation before it reaches manager work',async()=>{const gate=createUpdateAdmission(),hold=deferred();const request=gate.run(()=>hold.promise);assert.equal((await gate.reserve(async()=>({safe:true}))).reserved,false);hold.resolve();await request;assert.equal((await gate.reserve(async()=>({safe:true}))).reserved,true);await assert.rejects(gate.run(async()=>{}),/preparing an update/);gate.cancel();let ran=false;await gate.run(async()=>{ran=true;});assert.equal(ran,true);});
test('reservation freezes new work synchronously and cancellation cannot be undone by a late check',async()=>{const gate=createUpdateAdmission(),hold=deferred();const pending=gate.reserve(()=>hold.promise);await assert.rejects(gate.run(async()=>{}),/preparing an update/);gate.cancel();hold.resolve({safe:true});assert.equal((await pending).reserved,false);assert.equal(gate.reserved,false);});
test('native chat initialization is already visible as work before the first asynchronous boundary',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'crew-update-chat-'));let bridge;
 // Shut down the owned producer and drain its journal before removing state.
 // Separate after hooks can leave a live child if filesystem cleanup fails first.
 t.after(async()=>{try{await bridge?.shutdown();}finally{await rm(root,{recursive:true,force:true});}});const release=path.join(root,'release'),steerRelease=path.join(root,'steer-release'),log=path.join(root,'calls.jsonl'),executable=path.join(root,'fake-codex');
 await writeFile(executable,`#!${process.execPath}\nimport{createInterface}from'node:readline';import{access,appendFile}from'node:fs/promises';for await(const line of createInterface({input:process.stdin})){const m=JSON.parse(line);if(m.id===undefined)continue;await appendFile(${JSON.stringify(log)},JSON.stringify({method:m.method,params:m.params})+'\\n');let result={};if(m.method==='account/read')result={account:{type:'chatgpt',planType:'fixture'}};if(m.method==='thread/start'){while(!await access(${JSON.stringify(release)}).then(()=>true).catch(()=>false))await new Promise(r=>setTimeout(r,10));result={thread:{id:'fixture-thread'}};}if(m.method==='mcpServerStatus/list'||m.method==='thread/turns/list'||m.method==='thread/timeline/list')result={data:[]};if(m.method==='turn/start')result={turn:{id:'fixture-turn',status:'inProgress'}};if(m.method==='turn/steer'){while(!await access(${JSON.stringify(steerRelease)}).then(()=>true).catch(()=>false))await new Promise(r=>setTimeout(r,10));result={turnId:m.params.expectedTurnId};}console.log(JSON.stringify({id:m.id,result}));}\n`,{mode:0o700});
 bridge=createBridge({cwd:root,statePath:path.join(root,'manager.json'),executable});
 const gate=createUpdateAdmission(),first=gate.run(()=>bridge.startWork('Fixture request','request-one')),duplicate=gate.run(()=>bridge.startWork('Fixture request','request-one'));
 const second=gate.run(()=>bridge.startWork('Other request','request-two'));
 assert.equal(bridge.state().workStarting,true,'pending ensureThread and queued input must not appear idle');
 assert.equal((await gate.reserve(async()=>({safe:true}))).reserved,false,'Queued transport work prevents update reservation');
 await writeFile(release,'continue');assert.deepEqual(await first,await duplicate);
 const calls=async()=> (await readFile(log,'utf8')).trim().split('\n').map(JSON.parse);
 const deadline=Date.now()+5000;while(!(await calls()).some(call=>call.method==='turn/steer')){if(Date.now()>deadline)throw new Error('Queued human steering did not reach native transport');await new Promise(resolve=>setTimeout(resolve,10));}
 assert.equal(bridge.state().workStarting,true,'A pending native steer acknowledgement remains visible work');
 assert.equal((await gate.reserve(async()=>({safe:true}))).reserved,false,'Update cannot reserve while queued input is awaiting native acknowledgement');
 await writeFile(steerRelease,'continue');assert.deepEqual(await second,{turnId:'fixture-turn'});
 const records=await calls();assert.equal(records.filter(c=>c.method==='turn/start').length,1);assert.equal(records.filter(c=>c.method==='turn/steer').length,1);
 assert.deepEqual(records.find(call=>call.method==='turn/steer').params,{threadId:'fixture-thread',expectedTurnId:'fixture-turn',clientUserMessageId:'request-two',input:[{type:'text',text:'Other request'}]});
 assert.equal(bridge.state().workStarting,false);assert.equal(bridge.state().activeTurnId,'fixture-turn');
 assert.equal((await gate.reserve(async()=>({safe:!bridge.state().activeTurnId&&!bridge.state().workStarting}))).reserved,false,'Native acknowledgement does not imply the active turn has ended');
});

test('durable update hold survives unsafe reservation and native cancellation until explicit release',async()=>{
 const gate=createUpdateAdmission();gate.hold();assert.equal((await gate.reserve(async()=>({safe:false,reasons:['live worker']}))).reserved,false);assert.equal(gate.reserved,true);gate.cancel();await assert.rejects(gate.run(async()=>{}),/preparing an update/);await assert.rejects(gate.reserve(async()=>{throw new Error('unknown evidence');}),/unknown evidence/);assert.equal(gate.reserved,true);gate.releaseHold();let ran=false;await gate.run(async()=>{ran=true;});assert.equal(ran,true);
});
test('reserved installation always rechecks fresh activity before accepting another reservation',async()=>{
 const gate=createUpdateAdmission();assert.equal((await gate.reserve(async()=>({safe:true}))).reserved,true);let checked=false;assert.equal((await gate.reserve(async()=>{checked=true;return{safe:false,reasons:['changed']};})).reserved,false);assert.equal(checked,true);assert.equal(gate.reserved,false);
});
