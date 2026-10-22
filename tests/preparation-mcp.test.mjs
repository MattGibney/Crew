import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createTask,updateTask} from '../src/orchestration/store.mts';
import {beginPreparation,claimPreparationDelivery,recordPreparationDelivery,readPreparation} from '../src/preparation/store.mts';
const mcp=fileURLToPath(new URL('../src/orchestration/mcp.mts',import.meta.url)),loader=import.meta.resolve('tsx');
async function rpc(t,state,role,extra,method,params={}){
 const child=spawn(process.execPath,['--import',loader,mcp,state,role,...extra],{stdio:['pipe','pipe','pipe']});let out='',err='';child.stdout.on('data',chunk=>out+=chunk);child.stderr.on('data',chunk=>err+=chunk);const closed=new Promise(resolve=>child.once('close',resolve));const timeout=setTimeout(()=>child.kill('SIGTERM'),10000);t.after(async()=>{clearTimeout(timeout);if(child.exitCode===null)child.kill('SIGTERM');await closed;});child.stdin.end(JSON.stringify({jsonrpc:'2.0',id:1,method,params})+'\n');assert.equal(await closed,0,err);clearTimeout(timeout);return JSON.parse(out).result;
}
test('manager and worker preparation tools expose only their exact bound requests and reject cross-role/run/project responses',async t=>{
 const state=await mkdtemp(path.join(tmpdir(),'crew-preparation-mcp-'));t.after(()=>rm(state,{recursive:true,force:true}));
 await createTask(state,{requestId:'worker-one',ticket:'GH-62',brief:'Explicit disposable preparation',projectId:'project-one'});await updateTask(state,'worker-one',task=>{task.runId='run-one';task.threadId='thread-worker';task.status='running';});
 const runtime=path.join(state,'runtime.json');await writeFile(runtime,JSON.stringify({project:{id:'project-one',mode:'repository'}}));
 const members=[{id:'manager-one',role:'manager',taskId:null,runId:null,threadId:'thread-manager',requestId:'manager-request',required:true,message:'Prepare the manager context.'},{id:'worker-one',role:'worker',taskId:'worker-one',runId:'run-one',threadId:'thread-worker',requestId:'worker-request',required:true,message:'Prepare the worker context.'}];
 await beginPreparation(state,{id:'preparation-one',purpose:'quit',projectId:'project-one',participants:members});
 const call=(role,extra,name,args={})=>rpc(t,state,role,extra,'tools/call',{name,arguments:args});
 for(const [role,extra,member] of [['manager',[runtime],members[0]],['worker',['worker-one','run-one'],members[1]]]){
  const tools=await rpc(t,state,role,extra,'tools/list');assert.ok(tools.tools.some(tool=>tool.name==='get_preparation_request'));assert.ok(tools.tools.some(tool=>tool.name==='report_preparation'));
  const request=await call(role,extra,'get_preparation_request');assert.equal(request.isError,undefined);assert.equal(JSON.parse(request.content[0].text).participantId,member.id);
  const identity={preparationId:'preparation-one',participantId:member.id,requestId:member.requestId};await claimPreparationDelivery(state,identity);await recordPreparationDelivery(state,identity,{state:'acknowledged',nativeTurnId:'turn-'+role});
  const response={...identity,responseId:role+'-ready',state:'ready',note:'Factual '+role+' continuation saved.'};assert.equal((await call(role,extra,'report_preparation',response)).isError,undefined);
 }
 const crossRole=await call('worker',['worker-one','run-one'],'report_preparation',{preparationId:'preparation-one',participantId:'manager-one',requestId:'manager-request',responseId:'wrong-role',state:'ready',note:'Must not bind to manager.'});assert.equal(crossRole.isError,true);assert.match(crossRole.content[0].text,/another role/);
 const stale=await call('worker',['worker-one','stale-run'],'get_preparation_request');assert.equal(stale.isError,true);assert.match(stale.content[0].text,/Stale/);
 await writeFile(runtime,JSON.stringify({project:{id:'other-project',mode:'repository'}}));const crossProject=await call('manager',[runtime],'get_preparation_request');assert.equal(crossProject.isError,true);assert.match(crossProject.content[0].text,/another role or project/);
 assert.equal((await readPreparation(state)).participants.filter(p=>p.response?.state==='ready').length,2);
});
