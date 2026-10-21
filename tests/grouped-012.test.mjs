import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createConversationTimeline} from '../runtime/conversation-timeline.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import os from 'node:os';
import {createController} from '../runtime/controller.mjs';
import {createTask,readTask,requestWorkerAction,requestWorkerModel} from '../runtime/orchestration-store.mjs';
const exec=promisify(execFile);
async function wait(fn,predicate,label){const end=Date.now()+30000;let value;while(Date.now()<end){value=await fn();if(predicate(value))return value;await new Promise(r=>setTimeout(r,40));}throw Error(`Timed out ${label}: ${JSON.stringify(value)}`);}
test('GH-20/24/22 reviewed retained plan, cooperative model continuation and restored handoff presentation preserve one context',async t=>{
 const dir=await realpath(await mkdtemp(path.join(os.tmpdir(),'crew-grouped-012-'))),repo=path.join(dir,'repo'),state=path.join(dir,'state'),binary=path.join(dir,'native.mjs'),log=path.join(dir,'calls.jsonl');await mkdir(repo);await exec('git',['init','-b','main',repo]);const script=`import fs from 'node:fs';const phase=process.argv[2],file='.fixture/state.json';fs.mkdirSync('.fixture',{recursive:true});const data=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):{};if(phase==='setup')data.seeds=(data.seeds||0)+1;if(phase==='teardown')data.disposed=true;fs.writeFileSync(file,JSON.stringify(data));`;
 await writeFile(path.join(repo,'action.mjs'),script);await writeFile(path.join(repo,'.gitignore'),'.fixture/\n');await exec('git',['-C',repo,'add','.']);await exec('git',['-C',repo,'-c','user.name=Fixture','-c','user.email=fixture@localhost.invalid','commit','-m','Fixture']);
 await writeFile(binary,`#!${process.execPath}
import{createInterface}from'node:readline';import{appendFileSync,openSync,closeSync,unlinkSync}from'node:fs';import{reportTask}from${JSON.stringify(new URL('../runtime/orchestration-store.mjs',import.meta.url).href)};
const raw=process.argv.find(x=>x.startsWith('mcp_servers.local_orchestration.args='));const[,state,,task,run]=JSON.parse(raw.slice(raw.indexOf('=')+1));
// Exclusive ownership makes accidental overlap a real child-process failure.
const lock=${JSON.stringify(path.join(dir,'active'))};closeSync(openSync(lock,'wx'));const log=${JSON.stringify(log)},threadId='retained-model-thread',turnId='turn-'+run,send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
const lines=createInterface({input:process.stdin});lines.on('close',()=>{appendFileSync(log,JSON.stringify({method:'fixture/exit',run})+'\\n');unlinkSync(lock);process.exit(0);});
for await(const line of lines){const m=JSON.parse(line);if(m.id===undefined)continue;appendFileSync(log,JSON.stringify({...m,run})+'\\n');let result={};
if(m.method==='account/read')result={account:{type:'chatgpt'}};
if(m.method==='model/list')result={data:[{model:'fixture-sol'},{model:'fixture-astra'}],nextCursor:null};
if(m.method==='thread/start'||m.method==='thread/resume')result={thread:{id:threadId},model:m.params.model||'fixture-astra'};
if(m.method==='config/read')result={config:{sandbox_mode:'read-only',approval_policy:'on-request'}};
if(m.method==='turn/start')result={turn:{id:turnId,status:'inProgress'}};
if(m.method==='thread/resume')send({method:'turn/completed',params:{threadId,turn:{id:'previous-turn-stale',status:'completed',items:[]}}});
if(m.method==='thread/resume')send({method:'model/rerouted',params:{threadId,turnId:'previous-turn-stale',fromModel:'old-model',toModel:'stale-route',reason:'highRiskCyberActivity'}});
if(m.method==='turn/start'&&m.params.model==='fixture-sol'){send({method:'item/completed',params:{threadId,turnId,item:{id:'early-current',type:'commandExecution',command:'early-current-command',exitCode:0,aggregatedOutput:'current evidence'}}});send({method:'item/completed',params:{threadId,turnId:'previous-turn-stale',item:{id:'stale-early',type:'commandExecution',command:'stale-old-command',exitCode:0,aggregatedOutput:'stale evidence'}}});}
send({id:m.id,result});
if(m.method==='turn/start'){send({method:'turn/started',params:{threadId,turn:{id:turnId,status:'inProgress'}}});await reportTask(state,task,run,{reportId:'model-progress',kind:m.params.model?'blocked':'progress',message:m.params.model?'Synthetic continuation held for another explicit instruction.':'Synthetic original worker running.'});if(m.params.model==='fixture-sol'){send({method:'item/completed',params:{threadId,turnId:'previous-turn-stale',item:{id:'stale-command',type:'commandExecution',command:'stale-after-ack-command',exitCode:0}}});send({method:'item/completed',params:{threadId,turnId:'previous-turn-stale',item:{id:'stale-reply',type:'agentMessage',text:'stale old reply'}}});send({method:'turn/started',params:{threadId,turn:{id:'previous-turn-stale',status:'inProgress'}}});send({method:'model/rerouted',params:{threadId,turnId:'previous-turn-stale',fromModel:'old-model',toModel:'stale-after-response',reason:'highRiskCyberActivity'}});send({method:'turn/completed',params:{threadId,turn:{id:'previous-turn-stale',status:'completed',items:[]}}});}if(m.params.model)send({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed',items:[]}}});}
if(m.method==='turn/interrupt')send({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'interrupted',items:[]}}});}
`,{mode:0o700});
 const source={path:'action.mjs',sha256:createHash('sha256').update(script).digest('hex')},hook=phase=>({command:`${JSON.stringify(process.execPath)} action.mjs ${phase}`,source,timeoutMs:10000}),originalPlan={schemaVersion:1,sources:[source],setup:hook('setup'),start:null,resume:null,ready:null,stop:null,teardown:null};
 const project={id:'model-fixture',name:'Model fixture',mode:'repository',readiness:{ready:true},repositories:[{id:'repo',path:repo,baseRef:'main'}],worker:{sandbox:'read-only',timeoutMs:60000,maxConcurrent:1,environment:{executionPlan:originalPlan}}},taskId='model-native-worker';
 let controller=await createController({stateDir:state,sourceDir:path.resolve('runtime'),executable:binary,project});
 const action=async(action,extra={})=>{const task=await readTask(state,taskId);await requestWorkerAction(state,{taskId,actionId:action+'-'+Date.now(),action,expectedRunId:task.runId||null,...extra});};
 t.after(async()=>{try{const task=await readTask(state,taskId);if(!['paused','stopped','failed','completed','disposed'].includes(task.status)){await action('pause',{cooperative:true});await wait(()=>readTask(state,taskId),x=>['paused','stopped','failed'].includes(x.status),'cleanup pause');}}finally{await controller.stop();await rm(dir,{recursive:true,force:true});}});
 await createTask(state,{requestId:taskId,ticket:'GH-22',brief:'Use Astra to inspect this fixture. Read-only; no other scope.',projectId:project.id,repositoryId:'repo'});await action('start');
 const initial=await wait(()=>readTask(state,taskId),x=>x.progress==='Synthetic original worker running.'&&x.threadId,'original execution');const immutable={id:initial.id,brief:initial.brief,worktree:initial.worktree,threadId:initial.threadId,workerPromptSnapshot:initial.workerPromptSnapshot};
 const request={taskId,requestId:'native-model-request',expectedRunId:initial.runId,model:'fixture-sol',userDecision:'The user approves Sol in place of the original Astra requirement; inspect only.'};
 await requestWorkerModel(state,request);await controller.tick();assert.equal((await readTask(state,taskId)).runId,initial.runId);assert.equal((await readTask(state,taskId)).status,'running');
 const calls=async()=>JSON.parse('['+(await readFile(log,'utf8')).trim().split('\n').join(',')+']');assert.equal((await calls()).filter(c=>c.method==='model/list').length,0,'model intent does not affect running provider');
 await action('pause',{cooperative:true});const paused=await wait(()=>readTask(state,taskId),x=>x.status==='paused','cooperative pause');const exit=JSON.parse(await readFile(path.join(paused.runDir,'exit.json')));assert.equal(exit.stopConfirmed,true);assert.equal(exit.nativeTurnStatus,'interrupted');

 // Add teardown to current settings only after the retained worker has exited.
 await controller.stop();const currentPlan={...originalPlan,teardown:hook('teardown')};project.worker.environment.executionPlan=currentPlan;
 const runtime=path.join(dir,'manager-runtime.json');await writeFile(runtime,JSON.stringify({project}));
 const managerTool=async(name,args)=>{const {spawn}=await import('node:child_process');const child=spawn(process.execPath,[path.resolve('runtime/orchestration-mcp.mjs'),state,'manager',runtime]);let output='',errors='';child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>errors+=data);child.stdin.end(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})+'\n');const code=await new Promise(resolve=>child.once('close',resolve));assert.equal(code,0,errors);const result=JSON.parse(output.trim()).result;assert.equal(result.isError,undefined,result.content[0].text);return JSON.parse(result.content[0].text);};
 controller=await createController({stateDir:state,sourceDir:path.resolve('runtime'),executable:binary,project});

 const viewed=await managerTool('review_worker_recovery',{taskId,action:'reconcile_plan'});assert.equal(viewed.allowed,true,JSON.stringify(viewed));assert.deepEqual(viewed.differences.map(d=>d.field),['teardown']);
 assert.equal((await readTask(state,taskId)).environment.plan.teardown,null,'review executes no command or metadata adoption');
 const decision='Use the reviewed teardown for this retained fixture only.';
 await managerTool('request_worker_recovery',{taskId,actionId:'grouped-reviewed-recovery',action:'reconcile_plan',expectedRunId:paused.runId,reviewHash:viewed.reviewHash,decision});
 const recovered=await wait(()=>readTask(state,taskId),x=>x.lifecycleRequests.some(r=>r.id==='grouped-reviewed-recovery'&&r.status==='completed'),'reviewed adoption');
 // Recovery adoption and pending model intent survive another controller reload without replay.
 await controller.stop();controller=await createController({stateDir:state,sourceDir:path.resolve('runtime'),executable:binary,project});
 const reloaded=await readTask(state,taskId);assert.equal(reloaded.environment.recoveryHistory.length,1);assert.equal(reloaded.modelRequests[0].userDecision,request.userDecision);assert.equal(reloaded.runId,initial.runId);
 assert.deepEqual(recovered.environment.recoveryHistory[0].previousPlan,originalPlan);assert.equal(recovered.environment.plan.teardown.command,currentPlan.teardown.command);assert.equal(recovered.runId,initial.runId);assert.equal(recovered.modelSelection.status,'pending');
 const readData=async()=>JSON.parse(await readFile(path.join(initial.worktree,'.fixture/state.json'),'utf8'));assert.deepEqual(await readData(),{seeds:1},'adoption never replays setup or executes teardown');
 await action('resume');const selected=await wait(()=>readTask(state,taskId),x=>x.status==='blocked'&&x.modelSelection.status==='selected'&&x.execution?.live===false,'resumed selection');
 for(const [key,value]of Object.entries(immutable))assert.deepEqual(selected[key],value,key+' preserved');assert.notEqual(selected.runId,initial.runId);assert.equal(selected.modelSelection.runtime.selectedModel,'fixture-sol');assert.equal(selected.modelSelection.runtime.threadId,initial.threadId);const selectedExit=JSON.parse(await readFile(path.join(selected.runDir,'exit.json')));assert.deepEqual(selectedExit.commands.map(c=>c.command),['early-current-command']);assert.notEqual(selectedExit.finalMessage,'stale old reply');assert.ok(!(await readFile(path.join(selected.runDir,'events.jsonl'),'utf8')).includes('stale-'));
 let rows=await calls();const resume=rows.find(c=>c.method==='thread/resume');assert.equal(resume.params.threadId,initial.threadId);assert.equal(resume.params.model,'fixture-sol');const turn=rows.find(c=>c.method==='turn/start'&&c.run===selected.runId);assert.equal(turn.params.model,'fixture-sol');assert.match(turn.params.input[0].text,/approves Sol/);assert.match(turn.params.input[0].text,/Use Astra/);assert.equal(rows.filter(c=>c.method==='turn/interrupt').length,1);assert.equal(rows.filter(c=>c.method==='thread/start').length,1);

 assert.deepEqual(await readData(),{seeds:1},'continuation retains setup-once resources');
 assert.equal(selected.modelRequests[0].userDecision,request.userDecision);assert.equal(selected.environment.recoveryHistory.length,1);
 // The exact recovery/model decision is user wording, while old worker chatter is context.
 const input=`${decision} Resume this worker with fixture-sol.`,envelope=`<realtime_delegation><input>${input}</input><transcript_delta>assistant: stale model fixture-astra and prior cleanup request</transcript_delta></realtime_delegation>`;
 const timeline=createConversationTimeline();timeline.record({type:'userMessage',id:'native-recovery-decision',content:[{type:'text',text:envelope}]},'manager-recovery-turn');timeline.record({type:'agentMessage',id:'native-recovery-result',text:'Reviewed lifecycle adopted; explicit continuation selected fixture-sol.'},'manager-recovery-turn');
 timeline.realtime({type:'bemItemPromoted',id:'recovery-promotion',itemId:'native-recovery-decision'});
 const persisted=JSON.parse(JSON.stringify(timeline.snapshot())),restored=createConversationTimeline();restored.restore(persisted);restored.realtime({type:'bemItemPromoted',id:'recovery-promotion',itemId:'native-recovery-decision'});
 assert.deepEqual(restored.snapshot(),persisted);assert.equal(restored.snapshot().length,2);const userRow=restored.snapshot().find(row=>row.id==='native-recovery-decision');assert.equal(userRow.text,input);assert.equal(userRow.turnId,'manager-recovery-turn');assert.equal(userRow.promotionId,'recovery-promotion');assert.ok(!JSON.stringify(restored.snapshot()).includes('transcript_delta'));
 // Only an explicit disposal runs the reviewed command and removes the owned worktree.
 await action('dispose');const disposed=await wait(()=>readTask(state,taskId),x=>x.status==='disposed','reviewed teardown disposal');assert.ok(disposed.environment.hooks.some(h=>h.phase==='teardown'&&h.status==='succeeded'));
});
