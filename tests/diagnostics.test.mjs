import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createDiagnosticsRecorder,DIAGNOSTIC_LIMIT} from '../diagnostics.mjs';
import {runEnvironmentHooks,environmentFile} from '../worker-environment.mjs';
test('streaming diagnostics bound output and redact split assignments, URL credentials/query, bearer, JWT and keys',()=>{
 const recorder=createDiagnosticsRecorder(),secret='privateDiagnosticCanary123';recorder.push('stderr','ERROR: expected Node 22 but found Node 20\nAPI_TO');recorder.push('stderr',`KEN=${secret}\nhttps://user:${secret}@example.invalid/path?token=${secret}#private\nBearer ${secret}\neyJhbGciOiJIUzI1NiJ9.eyJ1c2VyIjoiY2FuYXJ5In0.c2lnbmF0dXJl\n-----BEGIN PRIVATE KEY-----\n${secret}\n-----END PRIVATE KEY-----\n`);
 let value=recorder.finish();assert.match(value.text,/expected Node 22/);assert.equal(value.text.includes(secret),false);assert.equal(value.text.includes('eyJhbGci'),false);assert.equal(value.text.includes('user:'),false);assert.equal(value.text.includes('?token'),false);
 for(let i=0;i<1000;i++)recorder.push('stdout',`normal build progress line ${i}\n`);recorder.push('stderr','x'.repeat(50000));value=recorder.finish();assert.ok(value.text.length<=DIAGNOSTIC_LIMIT);assert.equal(value.truncated,true);assert.equal(value.sanitized,true);assert.equal(value.complete,false);assert.match(value.notice,/best-effort/);for(let i=0;i<200;i++)recorder.push('stdout','Unicode progress 🎵'.repeat(10)+'\n');assert.ok(Buffer.byteLength(recorder.finish().text,'utf8')<=DIAGNOSTIC_LIMIT);
});
test('actual failed command retains useful bounded sanitized diagnostics without durable secret canaries',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'crew-diagnostics-')),stateDir=path.join(dir,'state'),taskId='diagnostic-task';await mkdir(path.join(stateDir,'runs',taskId),{recursive:true});t.after(()=>rm(dir,{recursive:true,force:true}));
 const secret='DurableSecretCanary0123456789';const script=`console.error('TOKEN='+process.env.CREW_DIAGNOSTIC_CANARY);console.error('https://user:'+process.env.CREW_DIAGNOSTIC_CANARY+'@example.invalid/path?key='+process.env.CREW_DIAGNOSTIC_CANARY);for(let i=0;i<700;i++)console.log('ordinary build progress '+i);console.error('ERROR: required generic tool is missing');process.exitCode=1;`;
 const prior=process.env.CREW_DIAGNOSTIC_CANARY;process.env.CREW_DIAGNOSTIC_CANARY=secret;
 try{await assert.rejects(runEnvironmentHooks({stateDir,taskId,worktree:dir,hooks:{setup:{command:process.execPath,args:['-e',script],timeoutMs:10000}},phases:['setup']}),/failed \(exit 1\)/);}finally{if(prior===undefined)delete process.env.CREW_DIAGNOSTIC_CANARY;else process.env.CREW_DIAGNOSTIC_CANARY=prior;}
 const environment=JSON.parse(await readFile(environmentFile(stateDir,taskId),'utf8')),hook=environment.hooks[0],exit=JSON.parse(await readFile(path.join(hook.runDir,'exit.json'),'utf8'));assert.match(hook.diagnostics.text,/required generic tool is missing/);assert.equal(hook.diagnostics.sanitized,true);assert.ok(hook.diagnostics.text.length<=DIAGNOSTIC_LIMIT);assert.deepEqual(exit.diagnostics,hook.diagnostics);
 async function scan(folder){for(const entry of await readdir(folder,{withFileTypes:true})){const file=path.join(folder,entry.name);if(entry.isDirectory())await scan(file);else assert.equal((await readFile(file,'utf8')).includes(secret),false,`Secret canary was persisted in ${entry.name}`);}}await scan(stateDir);
});
test('stderr cause is reserved independently of stdout flood in either pipe arrival order',()=>{
 const flood=Array.from({length:1000},(_,i)=>`ordinary build progress ${i}\n`).join('');
 for(const errorFirst of [true,false]){
  const recorder=createDiagnosticsRecorder();if(errorFirst)recorder.push('stderr','ERROR: required generic tool is missing\n');recorder.push('stdout',flood);if(!errorFirst)recorder.push('stderr','ERROR: required generic tool is missing\n');const result=recorder.finish();assert.match(result.text,/required generic tool is missing/);assert.match(result.text,/ordinary build progress 999/);assert.ok(Buffer.byteLength(result.text,'utf8')<=DIAGNOSTIC_LIMIT);assert.equal(result.perStreamLimit,4096);assert.equal(result.truncated,true);
 }
});
