// Global group hold is visible to a project before its local update plan exists.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configureGlobalCapacity } from '../runtime/orchestration/capacity.mjs';
const root=fileURLToPath(new URL('../runtime/',import.meta.url));
test('global admission hold rejects project manager admissions before local plan begin',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'crew-global-http-')),capacity=join(directory,'capacity'),configPath=join(directory,'config.json'),executable=join(directory,'synthetic-codex.mjs');
 const socket=createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
 await writeFile(executable,`#!${process.execPath}\nif(process.argv.includes('--version')){console.log('codex-cli 0.0.0-synthetic');process.exit(0);}throw new Error('Held manager must not launch');\n`,{mode:0o700});
 const config=JSON.parse(await readFile(join(root,'config/fixture.example.json'),'utf8'));config.runtime={port,codexBinary:executable,dataDir:join(directory,'state')};config.project.id='global-http-fixture';config.project.prompts={manager:join(root,'prompts/manager.md'),worker:join(root,'prompts/worker.md')};await writeFile(configPath,JSON.stringify(config));
 await configureGlobalCapacity({dir:capacity,limit:2,admissionPaused:true});
 const child=spawn(process.execPath,[join(root,'server.mjs')],{cwd:root,env:{...process.env,AI_MANAGER_CONFIG:configPath,AI_MANAGER_PORT:String(port),AI_MANAGER_CODEX_BINARY:executable,CODEX_BINARY:executable,CREW_GLOBAL_CAPACITY_DIR:capacity},stdio:['ignore','pipe','pipe']});
 let diagnostics='';child.stdout.on('data',data=>diagnostics+=data);child.stderr.on('data',data=>diagnostics+=data);
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGTERM');await exited;}await rm(directory,{recursive:true,force:true});});
 const origin=`http://127.0.0.1:${port}`;
 const request=(route,body={})=>fetch(origin+route,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)});
 let ready=false;const deadline=Date.now()+10000;while(Date.now()<deadline){if(child.exitCode!==null)throw new Error(diagnostics);try{const response=await request('/api/state');if(response.ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,25));}assert.equal(ready,true,diagnostics);
 for(const route of ['/api/prepare','/api/voices','/api/connect','/api/voice-ready','/api/work','/api/discuss-attention','/api/manager/lifecycle']){
  const response=await request(route,{action:'start'});assert.equal(response.status,409,route);assert.match((await response.json()).error,/across projects/);
 }
 const state=await (await request('/api/state')).json();assert.equal(state.threadId,undefined);assert.equal(state.voiceActive,false);
 const plan=await (await request('/api/update-plan-status')).json();assert.equal(plan.plan,null);
 await configureGlobalCapacity({dir:capacity,admissionPaused:false});
 const response=await request('/api/manager/lifecycle',{action:'stop'});assert.equal(response.status,200);
});
