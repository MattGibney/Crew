import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createTask,updateTask} from '../runtime/orchestration/store.mjs';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,label){const deadline=Date.now()+10000;while(Date.now()<deadline){const value=await fn();if(value)return value;await sleep(20);}throw Error('Timed out '+label);}
for(const phase of ['initialize','turn/start'])test(`cooperative pause during pending ${phase} preserves native turn ownership`,async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'crew-bootstrap-pause-')),stateDir=path.join(root,'state'),runDir=path.join(root,'run'),taskId='bootstrap-worker',runId='bootstrap-run';await mkdir(runDir);await createTask(stateDir,{requestId:taskId,ticket:'GH-13',brief:'Disposable bootstrap race check'});await updateTask(stateDir,taskId,task=>{task.runId=runId;task.status='running';});
 const executable=path.join(root,'codex.mjs');await writeFile(executable,`#!${process.execPath}
import{createInterface}from'node:readline';import{appendFile,writeFile,access}from'node:fs/promises';
const root=${JSON.stringify(root)},phase=${JSON.stringify(phase)},send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
const lines=createInterface({input:process.stdin});lines.on('close',async()=>{await writeFile(root+'/closed','yes');process.exit(0);});
for await(const line of lines){const m=JSON.parse(line);if(m.id===undefined)continue;await appendFile(root+'/requests.jsonl',JSON.stringify(m)+'\\n');if(m.method===phase){await writeFile(root+'/pending','yes');while(!await access(root+'/release').then(()=>true).catch(()=>false))await new Promise(r=>setTimeout(r,10));}let result={};if(m.method==='account/read')result={account:{type:'chatgpt'}};if(m.method==='thread/start')result={thread:{id:'bootstrap-thread'}};if(m.method==='config/read')result={config:{}};if(m.method==='turn/start')result={turn:{id:'bootstrap-turn',status:'inProgress'}};send({id:m.id,result});if(m.method==='turn/interrupt')send({method:'turn/completed',params:{threadId:'bootstrap-thread',turn:{id:'bootstrap-turn',status:'interrupted',items:[]}}});}
`,{mode:0o700});
 const configPath=path.join(runDir,'config.json');await writeFile(configPath,JSON.stringify({stateDir,taskId,runId,executable,ticket:'GH-13',workerPrompt:'Read-only disposable fixture.',worktree:root,mcpScript:path.resolve('runtime/orchestration-mcp.mjs'),sandbox:'read-only',timeoutMs:15000,project:{mode:'repository'},brief:'Disposable bootstrap pause'}));
 const child=spawn(process.execPath,[path.resolve('runtime/workers/runner.mjs'),configPath],{stdio:['ignore','ignore','pipe']});let diagnostic='';child.stderr.on('data',chunk=>diagnostic+=chunk);const closed=new Promise(resolve=>child.once('close',resolve));t.after(async()=>{if(child.exitCode===null)child.kill('SIGTERM');await closed;await rm(root,{recursive:true,force:true});});
 await until(()=>readFile(path.join(root,'pending')).catch(()=>false),'native pending request');
 await writeFile(path.join(runDir,'control.json'),JSON.stringify({runId,requestId:'bootstrap-pause',action:'pause',cooperative:true}));
 await until(()=>readFile(path.join(runDir,'control-accepted.json')).catch(()=>false),'pause accepted');
 if(phase==='turn/start'){await sleep(150);await assert.rejects(readFile(path.join(root,'closed')),{code:'ENOENT'});}
 await writeFile(path.join(root,'release'),'yes');await until(()=>readFile(path.join(runDir,'exit.json')).catch(()=>false),'durable matching exit');assert.equal(await closed,0,diagnostic);
 const requests=(await readFile(path.join(root,'requests.jsonl'),'utf8')).trim().split('\n').map(JSON.parse),exit=JSON.parse(await readFile(path.join(runDir,'exit.json'),'utf8'));assert.equal(exit.stopConfirmed,true);assert.equal(exit.stopRequestId,'bootstrap-pause');
 if(phase==='initialize')assert.equal(requests.some(r=>r.method==='turn/start'),false);
 else{const interrupts=requests.filter(r=>r.method==='turn/interrupt');assert.equal(interrupts.length,1);assert.deepEqual(interrupts[0].params,{threadId:'bootstrap-thread',turnId:'bootstrap-turn'});}
});

test('natural completion before delayed turn/start reply preserves successful terminal evidence',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'crew-early-completion-')),stateDir=path.join(root,'state'),runDir=path.join(root,'run'),taskId='completion-worker',runId='completion-run';await mkdir(runDir);await createTask(stateDir,{requestId:taskId,ticket:'GH-13',brief:'Disposable event ordering check'});await updateTask(stateDir,taskId,task=>{task.runId=runId;task.status='running';});
 const executable=path.join(root,'codex.mjs');await writeFile(executable,`#!${process.execPath}
import{createInterface}from'node:readline';import{writeFile,access}from'node:fs/promises';
const root=${JSON.stringify(root)},send=m=>process.stdout.write(JSON.stringify(m)+'\\n');const lines=createInterface({input:process.stdin});lines.on('close',async()=>{await writeFile(root+'/closed','yes');process.exit(0);});
for await(const line of lines){const m=JSON.parse(line);if(m.id===undefined)continue;let result={};if(m.method==='account/read')result={account:{type:'chatgpt'}};if(m.method==='thread/start')result={thread:{id:'early-thread'}};if(m.method==='config/read')result={config:{}};if(m.method==='turn/start'){send({method:'turn/completed',params:{threadId:'early-thread',turn:{id:'early-turn',status:'completed',items:[]}}});await writeFile(root+'/completed','yes');while(!await access(root+'/release').then(()=>true).catch(()=>false))await new Promise(r=>setTimeout(r,10));result={turn:{id:'early-turn',status:'completed'}};}send({id:m.id,result});}
`,{mode:0o700});
 const configPath=path.join(runDir,'config.json');await writeFile(configPath,JSON.stringify({stateDir,taskId,runId,executable,ticket:'GH-13',workerPrompt:'Read-only disposable fixture.',worktree:root,mcpScript:path.resolve('runtime/orchestration-mcp.mjs'),sandbox:'read-only',timeoutMs:15000,project:{mode:'repository'},brief:'Disposable event ordering check'}));
 const child=spawn(process.execPath,[path.resolve('runtime/workers/runner.mjs'),configPath],{stdio:['ignore','ignore','pipe']});let diagnostic='';child.stderr.on('data',chunk=>diagnostic+=chunk);const closed=new Promise(resolve=>child.once('close',resolve));t.after(async()=>{if(child.exitCode===null)child.kill('SIGTERM');await closed;await rm(root,{recursive:true,force:true});});
 await until(()=>readFile(path.join(root,'completed')).catch(()=>false),'completion notification before reply');await sleep(150);await assert.rejects(readFile(path.join(root,'closed')),{code:'ENOENT'});await writeFile(path.join(root,'release'),'yes');
 await until(()=>readFile(path.join(runDir,'exit.json')).catch(()=>false),'successful matching terminal');assert.equal(await closed,0,diagnostic);const exit=JSON.parse(await readFile(path.join(runDir,'exit.json'),'utf8'));assert.equal(exit.nativeTurnStatus,'completed');assert.equal(exit.completedTurn,true);assert.equal(exit.error,null);assert.equal(exit.exitCode,0);assert.equal(exit.stopConfirmed,true);
});

test('successful silent native command survives decoder, event journal and terminal command evidence', async t => {
 const root=await mkdtemp(path.join(tmpdir(),'crew-silent-command-')),stateDir=path.join(root,'state'),runDir=path.join(root,'run'),taskId='silent-command-worker',runId='silent-command-run';
 await mkdir(runDir);await createTask(stateDir,{requestId:taskId,ticket:'GH-37',brief:'Retain silent native command evidence'});await updateTask(stateDir,taskId,task=>{task.runId=runId;task.status='running';});
 const executable=path.join(root,'codex.mjs'),command='node -e ""';
 await writeFile(executable,`#!${process.execPath}
import{createInterface}from'node:readline';import{execFileSync}from'node:child_process';
const threadId='silent-thread',turnId='silent-turn',send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
const lines=createInterface({input:process.stdin});lines.on('close',()=>process.exit(0));
for await(const line of lines){const m=JSON.parse(line);if(m.id===undefined)continue;let result={};if(m.method==='account/read')result={account:{type:'chatgpt'}};if(m.method==='thread/start')result={thread:{id:threadId}};if(m.method==='config/read')result={config:{}};if(m.method==='turn/start')result={turn:{id:turnId,status:'inProgress'}};send({id:m.id,result});if(m.method==='turn/start'){const output=execFileSync(process.execPath,['-e',''],{encoding:'utf8'});if(output!=='')throw Error('Expected a silent command');send({method:'item/completed',params:{threadId,turnId,item:{id:'silent-command-item',type:'commandExecution',command:${JSON.stringify(command)},status:'completed',exitCode:0,aggregatedOutput:null}}});send({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed',items:[]}}});}}
`,{mode:0o700});
 const configPath=path.join(runDir,'config.json');await writeFile(configPath,JSON.stringify({stateDir,taskId,runId,executable,ticket:'GH-37',workerPrompt:'Disposable silent command fixture.',worktree:root,mcpScript:path.resolve('runtime/orchestration-mcp.mjs'),project:{mode:'repository'},brief:'Observe a successful silent native command'}));
 const child=spawn(process.execPath,[path.resolve('runtime/workers/runner.mjs'),configPath],{stdio:['ignore','ignore','pipe']});let diagnostic='';child.stderr.on('data',chunk=>diagnostic+=chunk);const closed=new Promise(resolve=>child.once('close',resolve));
 t.after(async()=>{if(child.exitCode===null)child.kill('SIGTERM');await closed;await rm(root,{recursive:true,force:true});});
 await until(()=>readFile(path.join(runDir,'exit.json')).catch(()=>false),'silent command terminal record');assert.equal(await closed,0,diagnostic);
 const exit=JSON.parse(await readFile(path.join(runDir,'exit.json'),'utf8'));
 assert.equal(exit.completedTurn,true);assert.equal(exit.error,null);assert.equal(exit.exitCode,0);
 assert.deepEqual(exit.commands,[{command,exitCode:0,output:''}]);
 const events=(await readFile(path.join(runDir,'events.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
 assert.deepEqual(events.filter(event=>event.item.type==='command_execution').map(event=>({runId:event.runId,turnId:event.turnId,item:event.item})),[{runId,turnId:'silent-turn',item:{id:'silent-command-item',type:'command_execution',command,status:'completed',exitCode:0}}]);
});
