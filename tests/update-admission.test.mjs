import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createUpdateAdmission} from '../update-admission.mjs';
import {createBridge} from '../codex-bridge.mjs';
const deferred=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve:value=>resolve(value)};};
test('an admitted async request prevents reservation before it reaches manager work',async()=>{const gate=createUpdateAdmission(),hold=deferred();const request=gate.run(()=>hold.promise);assert.equal((await gate.reserve(async()=>({safe:true}))).reserved,false);hold.resolve();await request;assert.equal((await gate.reserve(async()=>({safe:true}))).reserved,true);await assert.rejects(gate.run(async()=>{}),/preparing an update/);gate.cancel();let ran=false;await gate.run(async()=>{ran=true;});assert.equal(ran,true);});
test('reservation freezes new work synchronously and cancellation cannot be undone by a late check',async()=>{const gate=createUpdateAdmission(),hold=deferred();const pending=gate.reserve(()=>hold.promise);await assert.rejects(gate.run(async()=>{}),/preparing an update/);gate.cancel();hold.resolve({safe:true});assert.equal((await pending).reserved,false);assert.equal(gate.reserved,false);});
test('native chat initialization is already visible as work before the first asynchronous boundary',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'crew-update-chat-'));t.after(()=>rm(root,{recursive:true,force:true}));const release=path.join(root,'release'),log=path.join(root,'calls.jsonl'),executable=path.join(root,'fake-codex');
 await writeFile(executable,`#!${process.execPath}\nimport{createInterface}from'node:readline';import{access,appendFile}from'node:fs/promises';for await(const line of createInterface({input:process.stdin})){const m=JSON.parse(line);if(m.id===undefined)continue;await appendFile(${JSON.stringify(log)},JSON.stringify({method:m.method})+'\\n');let result={};if(m.method==='account/read')result={account:{type:'chatgpt',planType:'fixture'}};if(m.method==='thread/start'){while(!await access(${JSON.stringify(release)}).then(()=>true).catch(()=>false))await new Promise(r=>setTimeout(r,10));result={thread:{id:'fixture-thread'}};}if(m.method==='mcpServerStatus/list'||m.method==='thread/turns/list'||m.method==='thread/timeline/list')result={data:[]};if(m.method==='turn/start')result={turn:{id:'fixture-turn'}};console.log(JSON.stringify({id:m.id,result}));}\n`,{mode:0o700});
 const bridge=createBridge({cwd:root,statePath:path.join(root,'manager.json'),executable});t.after(()=>bridge.shutdown());const first=bridge.startWork('Fixture request','request-one'),duplicate=bridge.startWork('Fixture request','request-one');
 assert.equal(bridge.state().workStarting,true,'pending ensureThread must not appear idle');await assert.rejects(bridge.startWork('Other request','request-two'),/already working/);
 await writeFile(release,'continue');assert.deepEqual(await first,await duplicate);const calls=(await readFile(log,'utf8')).trim().split('\n').map(JSON.parse);assert.equal(calls.filter(c=>c.method==='turn/start').length,1);assert.equal(bridge.state().workStarting,false);
});

test('durable update hold survives unsafe reservation and native cancellation until explicit release',async()=>{
 const gate=createUpdateAdmission();gate.hold();assert.equal((await gate.reserve(async()=>({safe:false,reasons:['live worker']}))).reserved,false);assert.equal(gate.reserved,true);gate.cancel();await assert.rejects(gate.run(async()=>{}),/preparing an update/);await assert.rejects(gate.reserve(async()=>{throw new Error('unknown evidence');}),/unknown evidence/);assert.equal(gate.reserved,true);gate.releaseHold();let ran=false;await gate.run(async()=>{ran=true;});assert.equal(ran,true);
});
test('reserved installation always rechecks fresh activity before accepting another reservation',async()=>{
 const gate=createUpdateAdmission();assert.equal((await gate.reserve(async()=>({safe:true}))).reserved,true);let checked=false;assert.equal((await gate.reserve(async()=>{checked=true;return{safe:false,reasons:['changed']};})).reserved,false);assert.equal(checked,true);assert.equal(gate.reserved,false);
});
