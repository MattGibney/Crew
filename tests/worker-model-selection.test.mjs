import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {requireWorkerModel} from '../runtime/worker-model-selection.mjs';
import {createTask,readTask,updateTask,requestWorkerModel,requestWorkerAction} from '../runtime/orchestration-store.mjs';

test('catalog uses exact native model IDs, follows pages and rejects unavailable aliases and malformed pagination',async()=>{
 const calls=[];const rpc=async(method,args)=>{calls.push({method,args});return args.cursor?{data:[{model:'fixture-astra',id:'astra-display'}],nextCursor:null}:{data:[{model:'fixture-sol'}],nextCursor:'second'};};
 assert.equal(await requireWorkerModel(rpc,'fixture-astra'),'fixture-astra');assert.equal(calls.length,2);assert.equal(calls[1].args.cursor,'second');
 await assert.rejects(requireWorkerModel(rpc,'astra-display'),/unavailable/);
 await assert.rejects(requireWorkerModel(async()=>({data:[],nextCursor:'same'}),'fixture-astra'),/pagination/);
 await assert.rejects(requireWorkerModel(async()=>({}),'fixture-astra'),/unavailable/);
});

test('model intent targets one current run, preserves immutable brief and does not pause or launch work',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'crew-model-intent-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 for(const id of ['model-worker-one','model-worker-two']){await createTask(dir,{requestId:id,ticket:'GH-22',brief:'Requires Astra; inspect only.'});await updateTask(dir,id,n=>{n.runId='original-run';n.status='running';n.threadId='original-thread';n.worktree='/retained/worktree';});}
 const args={taskId:'model-worker-one',requestId:'model-request-one',expectedRunId:'original-run',model:'fixture-sol',userDecision:'The user explicitly approved Sol instead of the original Astra requirement.'};
 const [first,retry]=await Promise.all([requestWorkerModel(dir,args),requestWorkerModel(dir,args)]);
 assert.equal(first.revision,retry.revision);assert.equal(first.modelSelection.status,'pending');assert.equal(first.status,'running');assert.equal(first.brief,'Requires Astra; inspect only.');assert.equal(first.threadId,'original-thread');assert.equal(first.worktree,'/retained/worktree');assert.equal(first.lifecycleRequests.length,0);assert.equal(first.modelRequests.length,1);assert.equal((await readTask(dir,'model-worker-two')).modelSelection,undefined);
 await assert.rejects(requestWorkerModel(dir,{...args,model:'fixture-astra'}),/changed content/);
 await assert.rejects(requestWorkerModel(dir,{...args,requestId:'model-request-stale',expectedRunId:'other-run'}),/Stale/);
 await assert.rejects(requestWorkerModel(dir,{...args,requestId:'model-request-other'}),/pending model/);
 await updateTask(dir,args.taskId,n=>{n.runId='resumed-run';n.modelSelection.status='selected';});
 assert.equal((await requestWorkerModel(dir,args)).modelRequests.length,1,'exact retry survives advancing run');
 const next={...args,requestId:'model-request-two',expectedRunId:'resumed-run',model:'fixture-astra'};
 await requestWorkerAction(dir,{taskId:args.taskId,actionId:'model-pause-action',action:'pause',cooperative:true,expectedRunId:'resumed-run'});
 await assert.rejects(requestWorkerModel(dir,next),/pending lifecycle/);
});

test('manager model tool is project-scoped, idempotent, and never exposed to workers',async t=>{
 const {spawn}=await import('node:child_process');const {writeFile}=await import('node:fs/promises');
 const dir=await mkdtemp(path.join(tmpdir(),'crew-model-mcp-'));t.after(()=>rm(dir,{recursive:true,force:true}));const taskId='model-mcp-worker';await createTask(dir,{requestId:taskId,ticket:'GH-22',brief:'Inspect only',projectId:'test-project'});await updateTask(dir,taskId,n=>{n.runId='model-mcp-run';n.status='running';});const runtime=path.join(dir,'runtime.json');await writeFile(runtime,JSON.stringify({project:{id:'test-project',mode:'repository'}}));
 const call=(role,extra,name,args)=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,[path.resolve('runtime/orchestration-mcp.mjs'),dir,role,...extra]);let output='';child.stdout.on('data',d=>output+=d);child.once('error',reject);child.once('close',code=>{try{assert.equal(code,0);resolve(JSON.parse(output.trim()).result);}catch(error){reject(error);}});child.stdin.end(JSON.stringify({id:1,jsonrpc:'2.0',method:'tools/call',params:{name,arguments:args}})+'\n');});
 const args={taskId,requestId:'model-mcp-request',expectedRunId:'model-mcp-run',model:'fixture-sol',userDecision:'The user approved Sol.'};assert.equal((await call('manager',[runtime],'set_worker_model',args)).isError,undefined);assert.equal((await call('manager',[runtime],'set_worker_model',args)).isError,undefined);assert.equal((await readTask(dir,taskId)).modelRequests.length,1);
 assert.equal((await call('worker',[taskId,'model-mcp-run'],'set_worker_model',args)).isError,true);
 await writeFile(runtime,JSON.stringify({project:{id:'other-project',mode:'repository'}}));assert.match((await call('manager',[runtime],'set_worker_model',{...args,requestId:'model-mcp-other'})).content[0].text,/another project/);
 await writeFile(runtime,JSON.stringify({project:{id:'test-project',mode:'repository'}}));assert.equal((await call('manager',[runtime],'worker_action',{taskId,actionId:'model-coop-pause',expectedRunId:'model-mcp-run',action:'pause',cooperative:true})).isError,undefined);assert.equal((await readTask(dir,taskId)).lifecycleRequests[0].cooperative,true);
});
