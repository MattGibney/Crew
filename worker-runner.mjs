import {requireWorkerModel} from './worker-model-selection.mjs';
import {applyProjectToolchain} from './project-toolchain.mjs';
// Detached per-run supervisor: survives controller/browser/voice closure.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFile, writeFile, rename, open, appendFile } from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {OwnedProcessTree,snapshotProcesses} from './process-ownership.mjs';
import { buildWorkerInstructions } from './prompt-settings.mjs';
import {waitOwnedNatural} from './cooperative-process.mjs';
import {recordWorkerRequest,workerRequestDecisions,deliverWorkerRequest,markWorkerRequestResolved,invalidateWorkerRequests} from './worker-approvals.mjs';
const configPath = process.argv[2];
const config = JSON.parse(await readFile(configPath, 'utf8'));
const runDir = path.dirname(configPath);
async function atomic(name, value) {
  const file = path.join(runDir, name), temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); await rename(temp, file);
}
const claim = await open(path.join(runDir, 'runner.claim'), 'wx', 0o600); await claim.close();
await atomic('started.json', { runId: config.runId, pid: process.pid, at: new Date().toISOString() });
const env = { ...applyProjectToolchain(config.environment?.toolchain), GIT_OPTIONAL_LOCKS: '0' };
for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL']) delete env[key];
if (!['read-only', 'workspace-write'].includes(config.sandbox || 'read-only')) throw new Error('Invalid worker sandbox');
const finalFile = path.join(runDir, 'final.txt');
const mcpArgs = [config.mcpScript, config.stateDir, 'worker', config.taskId, config.runId];
const projectRuntime=config.environment?.kind==='project-execution';
if(config.environment?.preset)throw new Error('Obsolete project-specific runtime state is not supported.');
if(projectRuntime&&!['ready','running'].includes(config.environment.status))throw new Error('Project execution plan has no completed setup and running foreground action.');
// Codex resolves user, trusted project and managed policy itself. Only the
// subscription identity and this run's orchestration endpoint are Crew-owned.
const args = ['app-server', '--stdio', '-c', 'forced_login_method="chatgpt"', '-c', 'model_provider="openai"', '-c', `mcp_servers.local_orchestration.command=${JSON.stringify(process.execPath)}`, '-c', `mcp_servers.local_orchestration.args=${JSON.stringify(mcpArgs)}`, '-c', 'mcp_servers.local_orchestration.required=true', '-c', 'mcp_servers.local_orchestration.default_tools_approval_mode="approve"'];
if (process.env.ELECTRON_RUN_AS_NODE === '1') args.push('-c', 'mcp_servers.local_orchestration.env.ELECTRON_RUN_AS_NODE="1"');
const fixturePrompt = `${buildWorkerInstructions(config)}
Disposable fixture acceptance procedure (task data): Inspect only this fixture worktree. Run node importing ./src/totals.mjs and print JSON {emptyActual:sum([]),sumActual:sum([1,2,3])}. Verify the Git root and tracked files with real commands. In the result report's evidence array include one JSON string {"emptyActual":NUMBER,"sumActual":NUMBER,"emptyExpected":NUMBER,"sumExpected":NUMBER,"finding":"initial_value_one"}. Expected additive totals are 0 and 6 unless the relayed answer explicitly selects a base fee of 1 (then 1 and 7). Explain the observed difference in the result. The controller independently checks these fixture values.`;
const repositoryPrompt = buildWorkerInstructions(config);
const selectedModel=config.modelSelection?.model||null;
let modelWrites=Promise.resolve();
const modelEvidence=(status,message,extra={})=>{if(!selectedModel)return Promise.resolve();const evidence={runId:config.runId,requestId:config.modelSelection.id,requestedModel:selectedModel,threadId,turnId,status,message,...extra,at:new Date().toISOString()};modelWrites=modelWrites.then(()=>atomic('model-selection.json',evidence));return modelWrites;};
const prompt=config.project?.mode === 'repository' ? repositoryPrompt : fixturePrompt;
let reroutedModel=null;
const pendingModelReroutes=new Map(),pendingModelCompletions=new Map();
let threadId=config.threadId||null,nativeTurnStatus=null,completedTurn=false,finalMessage='',commands=[],errorMessage=null,stopRequest=null,stopPromise=null,spawnError=null;
// npm-distributed Codex is a Node entry point. Its harness uses Crew's bundled
// runtime; project commands still use the selected managed Node through PATH.
let nodeEntry=false,executableHandle;
try{executableHandle=await open(config.executable,'r');const header=Buffer.alloc(256);const {bytesRead}=await executableHandle.read(header,0,header.length,0);nodeEntry=/^#![^\n]*(?:\/env\s+node|\/node)(?:\s|$)/.test(header.subarray(0,bytesRead).toString());}catch{}finally{await executableHandle?.close();}
const worker=spawn(nodeEntry?process.execPath:config.executable,nodeEntry?[config.executable,...args]:args,{cwd:config.worktree,env,detached:true,stdio:['pipe','pipe','pipe']});
// Attach before any filesystem await: missing executables must become durable per-run failures.
const closed=new Promise(resolve=>{worker.once('close',code=>resolve(code));worker.once('error',error=>{spawnError=error.code||'spawn failed';errorMessage=`Could not start worker (${spawnError}).`;resolve(null);});});
const tree=worker.pid?new OwnedProcessTree(worker.pid):null;
let writes=Promise.resolve(),nextId=0,turnId=null,ending=false,turnStartPending=false,finishPending=false,threadStartPending=false,interruptRequested=false,handling=Promise.resolve();
const pending=new Map(),nativeRequests=new Map(),attemptedResponses=new Set();
const requestContext=()=>({stateDir:config.stateDir,taskId:config.taskId,runId:config.runId});
const send=message=>{if(!worker.stdin.destroyed)worker.stdin.write(JSON.stringify(message)+'\n');};
const sendResponse=message=>new Promise((resolve,reject)=>{
 if(worker.stdin.destroyed||worker.stdin.writableEnded)return reject(Object.assign(new Error('Native worker response channel is closed.'),{code:'NATIVE_CHANNEL_CLOSED'}));
 const timer=setTimeout(()=>reject(Object.assign(new Error('Native response write timed out; delivery is unknown.'),{code:'NATIVE_WRITE_TIMEOUT'})),5000);
 worker.stdin.write(JSON.stringify(message)+'\n',error=>{clearTimeout(timer);error?reject(error):resolve();});
});
worker.stdin.on('error',error=>{errorMessage=errorMessage||`Worker protocol channel closed (${error.code||'error'}).`;});
function rpc(method,params={}){return new Promise((resolve,reject)=>{const id=++nextId,timer=setTimeout(()=>{pending.delete(id);reject(new Error(`${method} timed out.`));},90000);pending.set(id,{resolve,reject,timer});send({id,method,params});});}
function interruptTurn(){if(interruptRequested||!turnId||ending||(selectedModel&&turnStartPending))return;interruptRequested=true;void rpc('turn/interrupt',{threadId,turnId}).catch(error=>{errorMessage=error.message;});}
function saveRuntime(){writes=writes.then(()=>atomic('runtime.json',{runId:config.runId,threadId,turnId,completedTurn,commands,updatedAt:new Date().toISOString()}));return writes;}
async function applyModelReroute(params){
 if(!selectedModel||turnStartPending||params.threadId!==threadId||!turnId||params.turnId!==turnId)return;
 reroutedModel=params.toModel;
 await modelEvidence('rerouted',`The native provider rerouted this turn from ${params.fromModel} to ${params.toModel}. Review the reported model with the manager; Crew did not substitute a model.`,{selectedModel:params.toModel,source:'native-model-rerouted',reason:params.reason});
}
async function reconcileModelReroute(){if(selectedModel&&turnStartPending)return;const observed=pendingModelReroutes.get(turnId);pendingModelReroutes.clear();if(observed)await applyModelReroute(observed);}
async function completeTurn(params){
 if(turnId&&params.turn.id!==turnId)return;
 nativeTurnStatus=params.turn.status;completedTurn=nativeTurnStatus==='completed';
 if(params.turn.error){errorMessage=params.turn.error.message||'Codex turn failed';await modelEvidence('failed',`Native worker failed after model selection: ${errorMessage}`,{selectedModel:null});}
 await finish();
}
async function reconcileModelCompletion(){if(selectedModel&&turnStartPending)return;const observed=pendingModelCompletions.get(turnId);pendingModelCompletions.clear();if(observed)await completeTurn(observed);}
async function finish(){if(ending)return;if(turnStartPending){finishPending=true;return;}ending=true;await saveRuntime();await writeFile(finalFile,finalMessage,{mode:0o600});await invalidateWorkerRequests({...requestContext(),reason:'Worker turn ended; this native request is no longer actionable.'});worker.stdin.end();}
const approvalMethods=new Set(['item/commandExecution/requestApproval','item/fileChange/requestApproval','item/permissions/requestApproval','item/tool/requestUserInput','mcpServer/elicitation/request']);
async function handle(message){
 if(message.id!==undefined&&pending.has(message.id)&&!message.method){const entry=pending.get(message.id);pending.delete(message.id);clearTimeout(entry.timer);message.error?entry.reject(new Error(message.error.message)):entry.resolve(message.result);return;}
 const {method,params={}}=message;
 if(message.id!==undefined&&method){
  if(method==='currentTime/read'){send({id:message.id,result:{currentTimeAt:Math.floor(Date.now()/1000)}});return;}
  if(approvalMethods.has(method)){
   if(!threadId&&threadStartPending&&typeof params.threadId==='string')threadId=params.threadId;
   if(params.threadId&&params.threadId!==threadId)throw new Error('Worker approval belongs to another thread.');
   if(params.turnId&&turnId&&params.turnId!==turnId)throw new Error('Worker approval belongs to another turn.');
   const record=await recordWorkerRequest({...requestContext(),threadId,turnId:params.turnId||turnId,requestId:message.id,method,params:{...params,threadId,turnId:params.turnId||turnId}});nativeRequests.set(record.approvalId,record);await saveRuntime();return;
  }
  errorMessage=`Worker requested unsupported native method ${method}; no action was approved.`;
  send({id:message.id,error:{code:-32601,message:errorMessage}});return;
 }
 if(params.threadId&&params.threadId!==threadId)return;
 if(method==='thread/started'&&!threadId&&params.thread?.id){threadId=params.thread.id;await saveRuntime();}
 if(method==='turn/started'){
  if(selectedModel&&(params.threadId!==threadId||(!turnId&&!turnStartPending)||(turnId&&params.turn.id!==turnId)))return;
  turnId=params.turn.id;await reconcileModelReroute();await reconcileModelCompletion();await saveRuntime();if(stopRequest?.cooperative)interruptTurn();
 }
 if(method==='model/rerouted'&&selectedModel&&params.threadId===threadId){
  if(turnStartPending&&typeof params.turnId==='string'){
   // Early notifications are not evidence until the actual current turn binds.
   if(pendingModelReroutes.size>=20)throw new Error('Too many uncorrelated native model notifications; model selection is unverified.');
   pendingModelReroutes.set(params.turnId,params);
  }else if(turnId)await applyModelReroute(params);
 }
 if(method==='item/completed'){
  const item=params.item;
  if(item?.type==='agentMessage')finalMessage=item.text||'';
  if(item?.type==='commandExecution')commands.push({command:item.command,exitCode:item.exitCode,output:String(item.aggregatedOutput||'').slice(0,5000)});
  writes=writes.then(()=>appendFile(path.join(runDir,'events.jsonl'),JSON.stringify({taskId:config.taskId,runId:config.runId,at:new Date().toISOString(),type:'item.completed',nativeMethod:method,turnId:params.turnId,item:item?.type==='agentMessage'?{id:item.id,type:'agent_message',text:String(item.text||'').slice(0,12000)}:item?.type==='commandExecution'?{id:item.id,type:'command_execution',command:item.command,status:item.status,exitCode:item.exitCode}:{type:item?.type,status:item?.status}})+'\n',{mode:0o600}));await saveRuntime();
 }
 if(method==='serverRequest/resolved'&&!ending&&!nativeTurnStatus){
  for(const [id,request]of nativeRequests)if(request.requestId===params.requestId){await markWorkerRequestResolved({...requestContext(),approvalId:id});nativeRequests.delete(id);}
 }
 if(method==='turn/completed'){
  if(selectedModel&&params.threadId!==threadId)return;
  if(selectedModel&&(turnStartPending||!turnId)){
   if(turnStartPending&&typeof params.turn?.id==='string'){
    if(pendingModelCompletions.size>=20)throw new Error('Too many uncorrelated native turn completions; model selection is unverified.');
    pendingModelCompletions.set(params.turn.id,params);
   }
   return;
  }
  await completeTurn(params);
 }
 if(method==='error'){errorMessage=params.error?.message||'Codex worker error';await modelEvidence('failed',`Native worker reported an error: ${errorMessage}`,{selectedModel:null});}
}
const lines=createInterface({input:worker.stdout});
lines.on('line',line=>{
 let message;try{message=JSON.parse(line);}catch{return;}
 // RPC responses cannot wait behind an event handler which itself awaits RPC.
 if(message.id!==undefined&&!message.method&&pending.has(message.id)){void handle(message);return;}
 handling=handling.then(()=>handle(message)).catch(async error=>{errorMessage=error.message;await finish();});
});
let diagnosticBytes=0;
worker.stderr.on('data',chunk=>{if(diagnosticBytes>=8192)return;diagnosticBytes+=chunk.length;}); // Never persist potentially sensitive native diagnostics.
const bootstrap=(async()=>{
 try{
  await rpc('initialize',{clientInfo:{name:'crew_worker',version:'0.10.0'},capabilities:{experimentalApi:true,mcpServerOpenaiFormElicitation:true}});send({method:'initialized',params:{}});if(ending||stopRequest){await finish();return;}
  const {account}=await rpc('account/read',{refreshToken:false});if(account?.type!=='chatgpt')throw new Error('ChatGPT subscription sign-in is required for workers.');if(ending||stopRequest){await finish();return;}
  if(selectedModel){await modelEvidence('validating','Validating the requested model before the next native turn.');await requireWorkerModel(rpc,selectedModel);if(!config.threadId)throw new Error('Model continuation requires the retained native conversation; no replacement thread was started.');}
  if(ending||stopRequest){await finish();return;}
  const options={cwd:config.worktree,...(selectedModel?{model:selectedModel}:{})};
  // Disposable fixture acceptance retains its explicitly authorized read-only boundary.
  if(config.project?.mode!=='repository')options.sandbox='read-only';
  threadStartPending=true;const started=await rpc(config.threadId?'thread/resume':'thread/start',config.threadId?{...options,threadId:config.threadId,excludeTurns:true}:options);
  threadStartPending=false;
  if(selectedModel&&started.thread.id!==config.threadId)throw new Error('Native model continuation returned another thread; no new turn was started.');
  threadId=started.thread.id;await saveRuntime();
  if(selectedModel&&started.model!==selectedModel)throw new Error('Native model selection did not confirm the requested exact model; no fallback turn was started.');if(ending||stopRequest){await finish();return;}
  const settings=await rpc('config/read',{cwd:config.worktree,includeLayers:false});
  await atomic('effective-policy.json',{runId:config.runId,threadId,configResolutionCwd:config.worktree,source:started.sandbox?'native-thread-response':'config-read',sandboxType:started.sandbox?.type??null,configSandboxMode:settings.config?.sandbox_mode??null,approvalPolicy:started.approvalPolicy??settings.config?.approval_policy??null,approvalsReviewer:started.approvalsReviewer??null,permissionsProfile:settings.config?.default_permissions??null});
  if(ending||stopRequest){await finish();return;}
  turnStartPending=true;const result=await rpc('turn/start',{threadId,...(selectedModel?{model:selectedModel}:{}),input:[{type:'text',text:prompt}]});
  turnStartPending=false;if(selectedModel&&(typeof result.turn?.id!=='string'||!result.turn.id))throw new Error('Native model continuation did not acknowledge a turn identity; selection was not confirmed.');if(selectedModel&&turnId&&turnId!==result.turn.id)throw new Error('Native model continuation returned a different turn identity; selection was not confirmed.');if(!turnId)turnId=result.turn.id;await reconcileModelReroute();await reconcileModelCompletion();await saveRuntime();if(!errorMessage&&!reroutedModel)await modelEvidence('selected',`Native worker selected ${selectedModel} for the resumed turn.`,{selectedModel,source:'native-thread-resume-response-and-turn-start',turnStartAcknowledged:true});if(finishPending)await finish();else if(stopRequest?.cooperative)interruptTurn();
 }catch(error){turnStartPending=false;if(!stopRequest&&!nativeTurnStatus){errorMessage=error.message;await modelEvidence('failed',`Model change failed: ${error.message} Retained task, worktree and native conversation were preserved.`,{selectedModel:null});}await finish();}
})();
async function capture(){if(tree){const records=await tree.capture();await atomic('ownership.json',{runId:config.runId,records,at:new Date().toISOString()});}}
await capture();
await atomic('owner.json',{runId:config.runId,supervisorPid:process.pid,supervisorIdentity:(await snapshotProcesses()).get(process.pid)||null,workerPid:worker.pid||null,at:new Date().toISOString()});
let cooperative=false;
const stopOwnedWorker=()=>{if(!stopPromise)stopPromise=tree?tree.stop({graceMs:2000}):Promise.resolve({confirmed:Boolean(spawnError),remaining:[]});return stopPromise;};
const timeoutMs=Number.isSafeInteger(config.timeoutMs)&&config.timeoutMs>=1000&&config.timeoutMs<=86400000?config.timeoutMs:300000;
let timeout;const checkTimeout=()=>{timeout=setTimeout(()=>{void(async()=>{await acceptControl().catch(()=>{});if(cooperative)return;if(nativeRequests.size){checkTimeout();return;}errorMessage=`Bounded worker run exceeded ${timeoutMs} milliseconds.`;void stopOwnedWorker();})();},timeoutMs);};checkTimeout();
let checking=false,protocolFailure=null;
async function retainProtocolFailure(error,stage){
 if(protocolFailure)return;
 const code=typeof error.code==='string'&&/^[A-Z][A-Z0-9_]{0,31}$/.test(error.code)?error.code:error instanceof SyntaxError?'INVALID_JSON':'PROTOCOL_FAILURE';
 protocolFailure={runId:config.runId,stage,code,message:`Worker ${stage} failed (${code}); pending native requests were retained without an automatic response.`,at:new Date().toISOString()};
 errorMessage=errorMessage||protocolFailure.message;
 await atomic('protocol-error.json',protocolFailure);
}

async function acceptControl(){let request;try{request=JSON.parse(await readFile(path.join(runDir,'control.json'),'utf8'));}catch(error){if(error.code==='ENOENT')return;throw error;}if(request.runId!==config.runId||typeof request.requestId!=='string'||!['stop','pause'].includes(request.action)||stopRequest?.requestId===request.requestId)return;stopRequest=request;await atomic('control-accepted.json',{...request,at:new Date().toISOString(),supervisorPid:process.pid,workerPid:worker.pid});if(request.cooperative===true){cooperative=true;clearTimeout(timeout);if(turnId&&!ending)interruptTurn();else if(!ending&&!turnStartPending)void finish();stopPromise=waitOwnedNatural(tree,{onBlocked:state=>atomic('cooperative-stop.json',{runId:config.runId,requestId:request.requestId,...state,at:new Date().toISOString()}),isSuperseded:()=>!cooperative});}else{if(cooperative){cooperative=false;stopPromise=null;}void stopOwnedWorker();}}
const controlTimer=setInterval(async()=>{if(checking)return;checking=true;let stage='process ownership observation';try{await capture();stage='lifecycle control read';await acceptControl();stage='native decision read';for(const decision of await workerRequestDecisions(requestContext())){const request=nativeRequests.get(decision.approvalId);if(!request||ending||attemptedResponses.has(decision.approvalId))continue;stage='native response delivery';await deliverWorkerRequest({...requestContext(),approvalId:decision.approvalId},async record=>{attemptedResponses.add(decision.approvalId);await sendResponse({id:request.requestId,result:record.response});});}}catch(error){await retainProtocolFailure(error,stage).catch(()=>{});}finally{checking=false;}},100);
process.on('SIGTERM',()=>{errorMessage='Worker supervisor was stopped.';if(cooperative){cooperative=false;stopPromise=null;}void stopOwnedWorker();});
const exitCode=await closed;
clearTimeout(timeout);clearInterval(controlTimer);
// A natural CLI exit must also leave no captured command/MCP descendant behind.
await acceptControl().catch(()=>{});
let observedStop=stopPromise;
let ownership=await(observedStop||(cooperative?waitOwnedNatural(tree):null)||tree?.stop({graceMs:1000})||Promise.resolve({confirmed:Boolean(spawnError),remaining:[]}));
if(stopPromise&&stopPromise!==observedStop)ownership=await stopPromise;
for(const entry of pending.values()){clearTimeout(entry.timer);entry.reject(new Error('Codex worker exited.'));}pending.clear();
await bootstrap;await handling;await writes;
await invalidateWorkerRequests({...requestContext(),reason:'Worker process exited.'});
await atomic('exit.json',{runId:config.runId,threadId,nativeTurnStatus,exitCode:errorMessage&&exitCode===0?1:exitCode,completedTurn,commands,finalMessage,error:errorMessage,stopped:Boolean(stopRequest)&&ownership.confirmed,stopConfirmed:ownership.confirmed,ownership:{confirmed:ownership.confirmed,remaining:ownership.remaining||[],tracked:ownership.tracked||[]},stopAction:stopRequest?.action||null,stopRequestId:stopRequest?.requestId||null,supervisorPid:process.pid,workerPid:worker.pid||null,at:new Date().toISOString()});
