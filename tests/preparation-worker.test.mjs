import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {beginPreparation,readPreparation} from '../src/preparation/store.mts';
import {createTask,updateTask,requestWorkerAction,readTask} from '../src/orchestration/store.mts';
import {parseWorkerStopRequest} from '../src/workers/worker-protocol.mts';
const loader=import.meta.resolve('tsx');
async function until(observe,predicate,label){const end=Date.now()+15000;let value;while(Date.now()<end){value=await observe();if(predicate(value))return value;await new Promise(r=>setTimeout(r,25));}throw Error('Timed out '+label+': '+JSON.stringify(value));}
const readJson=file=>readFile(file,'utf8').then(JSON.parse).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
test('worker preparation uses bound native steer, persists ready before natural turn/result drain, and disables fixture timeout',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'crew-preparation-worker-')),stateDir=path.join(root,'state'),runDir=path.join(root,'run'),taskId='worker-preparation',runId='worker-preparation-run',projectId='project-preparation',threadId='preparation-thread',turnId='preparation-turn';await mkdir(runDir);
 await createTask(stateDir,{requestId:taskId,ticket:'GH-62',brief:'Disposable preparation lifecycle',projectId});await updateTask(stateDir,taskId,task=>{task.runId=runId;task.threadId=threadId;task.status='running';});
 const executable=path.join(root,'native.mjs'),mcp=fileURLToPath(new URL('../src/orchestration/mcp.mts',import.meta.url));
 await writeFile(executable,`#!${process.execPath}
import{createInterface}from'node:readline';import{appendFile,writeFile,access}from'node:fs/promises';import{spawn}from'node:child_process';
const root=${JSON.stringify(root)},stateDir=${JSON.stringify(stateDir)},taskId=${JSON.stringify(taskId)},runId=${JSON.stringify(runId)},threadId=${JSON.stringify(threadId)},turnId=${JSON.stringify(turnId)},send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
async function report(){const p=spawn(process.execPath,['--import',${JSON.stringify(loader)},${JSON.stringify(mcp)},stateDir,'worker',taskId,runId],{stdio:['pipe','pipe','ignore']});let output='';p.stdout.on('data',chunk=>output+=chunk);p.stdin.end(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'report_preparation',arguments:{preparationId:'preparation-one',participantId:'worker-participant',requestId:'worker-request',responseId:'worker-ready',state:'ready',note:'Ready acknowledgement retained; final response still pending.',continuation:'Resume with this factual context.'}}})+'\\n');await new Promise((resolve,reject)=>{p.once('error',reject);p.once('close',code=>code?reject(Error('MCP failed')):resolve())});const result=JSON.parse(output.trim());if(result.result?.isError)throw Error(result.result.content[0].text);await writeFile(root+'/ready-tool.json',JSON.stringify(result));}
let sentFinal=false;const poll=setInterval(async()=>{if(sentFinal||!await access(root+'/release-final').then(()=>true).catch(()=>false))return;sentFinal=true;send({method:'item/completed',params:{threadId,turnId,item:{id:'final-response',type:'agentMessage',text:'Final preparation context is durably complete.'}}});send({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed',items:[]}}});},25);
const lines=createInterface({input:process.stdin});lines.on('close',()=>{clearInterval(poll);process.exit(0)});
for await(const line of lines){const m=JSON.parse(line);await appendFile(root+'/calls.jsonl',JSON.stringify(m)+'\\n');if(!m.method)continue;let result={};if(m.method==='account/read')result={account:{type:'chatgpt'}};if(m.method==='thread/start')result={thread:{id:threadId}};if(m.method==='config/read')result={config:{}};if(m.method==='turn/start')result={turn:{id:turnId,status:'inProgress'}};if(m.method==='turn/steer'){if(m.params.expectedTurnId!==turnId)throw Error('Wrong expected native turn');await report();result={turnId};}send({id:m.id,result});if(m.method==='turn/start')await writeFile(root+'/turn-started','yes');}
`,{mode:0o700});
 const configPath=path.join(runDir,'config.json');await writeFile(configPath,JSON.stringify({stateDir,taskId,runId,executable,ticket:'GH-62',workerPrompt:'Preserve factual context and use the preparation tool.',worktree:root,mcpScript:mcp,project:{id:projectId,mode:'fixture'},timeoutMs:1000,brief:'Explicit disposable preparation test'}));
 const runner=fileURLToPath(new URL('../src/workers/runner.mts',import.meta.url));const child=spawn(process.execPath,['--import',loader,runner,configPath],{stdio:['ignore','ignore','pipe']});let stderr='';child.stderr.on('data',chunk=>stderr+=chunk);const closed=new Promise(resolve=>child.once('close',resolve));t.after(async()=>{if(child.exitCode===null)child.kill('SIGTERM');await closed;await rm(root,{recursive:true,force:true});});
 await until(()=>readFile(path.join(root,'turn-started')).catch(()=>null),Boolean,'native turn');
 await beginPreparation(stateDir,{id:'preparation-one',purpose:'update',projectId,participants:[{id:'worker-participant',role:'worker',taskId,runId,threadId,requestId:'worker-request',required:true,message:'The user chose update; prepare your existing work.'}]});
 await until(()=>readPreparation(stateDir),p=>p?.participants[0].delivery.state==='acknowledged'&&p.participants[0].response?.state==='ready','durable native delivery and explicit ready');
 await writeFile(path.join(runDir,'control.json'),JSON.stringify({runId,requestId:'natural-settlement',action:'pause',cooperative:true,settleNaturally:true}));
 await until(()=>readJson(path.join(runDir,'control-accepted.json')),r=>r?.requestId==='natural-settlement','natural pause accepted');await new Promise(r=>setTimeout(r,1150));
 assert.equal(child.exitCode,null,'Ready response and fixture timeout must not end native preparation');assert.equal(await readJson(path.join(runDir,'exit.json')),null);
 let calls=(await readFile(path.join(root,'calls.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);assert.equal(calls.filter(c=>c.method==='turn/steer').length,1);assert.equal(calls.some(c=>c.method==='turn/interrupt'),false);
 await writeFile(path.join(root,'release-final'),'yes');const exit=await until(()=>readJson(path.join(runDir,'exit.json')),Boolean,'natural correlated terminal');assert.equal(await closed,0,stderr);assert.equal(exit.completedTurn,true);assert.equal(exit.stopConfirmed,true);assert.equal(exit.stopAction,'pause');assert.equal(exit.stopRequestId,'natural-settlement');assert.equal(exit.finalMessage,'Final preparation context is durably complete.');assert.match(await readFile(path.join(runDir,'events.jsonl'),'utf8'),/Final preparation context is durably complete/);
 assert.equal((await readPreparation(stateDir)).participants[0].response.continuation,'Resume with this factual context.');
});
test('natural settlement flag is cooperative-only and participates in durable action idempotency',async t=>{
 const state=await mkdtemp(path.join(tmpdir(),'crew-natural-action-'));t.after(()=>rm(state,{recursive:true,force:true}));await createTask(state,{requestId:'natural-worker',ticket:'GH-62',brief:'Durable natural pause identity'});
 const input={taskId:'natural-worker',actionId:'natural-action',action:'pause',cooperative:true,settleNaturally:true,expectedRunId:null};await requestWorkerAction(state,input);await requestWorkerAction(state,input);assert.equal((await readTask(state,'natural-worker')).lifecycleRequests[0].settleNaturally,true);await assert.rejects(requestWorkerAction(state,{...input,settleNaturally:false}),/changed/);await assert.rejects(requestWorkerAction(state,{...input,actionId:'invalid-action',cooperative:false}),/requires/);assert.equal(parseWorkerStopRequest({runId:'run',requestId:'request',action:'pause',settleNaturally:true}),null);
});
