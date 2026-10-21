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
const sandboxArgs=projectRuntime&&config.environment.plan?.networkAccess===true?['-c','default_permissions="crew_project"','-c',`permissions.crew_project.extends=${JSON.stringify(config.sandbox==='workspace-write'?':workspace':':read-only')}`,'-c','permissions.crew_project.network.enabled=true']:['-c',`sandbox_mode=${JSON.stringify(config.sandbox||'read-only')}`];
const args = ['exec', '--ignore-user-config', '--json', '-c', 'forced_login_method="chatgpt"', '-c', 'model_provider="openai"', ...sandboxArgs, '-c', 'approval_policy="never"', '-c', `mcp_servers.local_orchestration.command=${JSON.stringify(process.execPath)}`, '-c', `mcp_servers.local_orchestration.args=${JSON.stringify(mcpArgs)}`, '-c', 'mcp_servers.local_orchestration.required=true', '-c', 'mcp_servers.local_orchestration.default_tools_approval_mode="approve"', '-o', finalFile];
if (process.env.ELECTRON_RUN_AS_NODE === '1') args.push('-c', 'mcp_servers.local_orchestration.env.ELECTRON_RUN_AS_NODE="1"');
if(config.environment?.toolchain){
 args.push('-c','shell_environment_policy.inherit="all"','-c',`shell_environment_policy.set.PATH=${JSON.stringify(env.PATH)}`);
 if(env.ZDOTDIR)args.push('-c',`shell_environment_policy.set.ZDOTDIR=${JSON.stringify(env.ZDOTDIR)}`);
}
if (config.threadId) args.push('resume', config.threadId);
else args.push('-C', config.worktree);
const fixturePrompt = `${buildWorkerInstructions(config)}
Disposable fixture acceptance procedure (task data): Inspect only this fixture worktree. Run node importing ./src/totals.mjs and print JSON {emptyActual:sum([]),sumActual:sum([1,2,3])}. Verify the Git root and tracked files with real commands. In the result report's evidence array include one JSON string {"emptyActual":NUMBER,"sumActual":NUMBER,"emptyExpected":NUMBER,"sumExpected":NUMBER,"finding":"initial_value_one"}. Expected additive totals are 0 and 6 unless the relayed answer explicitly selects a base fee of 1 (then 1 and 7). Explain the observed difference in the result. The controller independently checks these fixture values.`;
const repositoryPrompt = buildWorkerInstructions(config);
args.push(config.project?.mode === 'repository' ? repositoryPrompt : fixturePrompt);
let threadId=config.threadId||null,completedTurn=false,finalMessage='',commands=[],errorMessage=null,stopRequest=null,stopPromise=null,spawnError=null;
// npm-distributed Codex is a Node entry point. Its harness uses Crew's bundled
// runtime; project commands still use the selected managed Node through PATH.
let nodeEntry=false,executableHandle;
try{executableHandle=await open(config.executable,'r');const header=Buffer.alloc(256);const {bytesRead}=await executableHandle.read(header,0,header.length,0);nodeEntry=/^#![^\n]*(?:\/env\s+node|\/node)(?:\s|$)/.test(header.subarray(0,bytesRead).toString());}catch{}finally{await executableHandle?.close();}
const worker=spawn(nodeEntry?process.execPath:config.executable,nodeEntry?[config.executable,...args]:args,{cwd:config.worktree,env,detached:true,stdio:['ignore','pipe','ignore']});
// Attach before any filesystem await: missing executables must become durable per-run failures.
const closed=new Promise(resolve=>{worker.once('close',code=>resolve(code));worker.once('error',error=>{spawnError=error.code||'spawn failed';errorMessage=`Could not start worker (${spawnError}).`;resolve(null);});});
const tree=worker.pid?new OwnedProcessTree(worker.pid):null;
let writes=Promise.resolve();
const lines=createInterface({input:worker.stdout});
lines.on('line',line=>{
 let event;try{event=JSON.parse(line);}catch{return;}const item=event.item;
 if(event.type==='thread.started')threadId=event.thread_id;
 if(event.type==='turn.completed')completedTurn=true;
 if(event.type==='turn.failed'||event.type==='error')errorMessage=event.error?.message||event.message||'Codex run failed';
 if(event.type==='item.completed'&&item?.type==='agent_message')finalMessage=item.text;
 if(event.type==='item.completed'&&item?.type==='command_execution')commands.push({command:item.command,exitCode:item.exit_code,output:String(item.aggregated_output||'').slice(0,5000)});
 const safe=item?.type==='agent_message'&&event.type==='item.completed'?{type:event.type,item:{type:item.type,text:item.text}}:event.type==='thread.started'?{type:event.type,threadId}:item?.type==='command_execution'?{type:event.type,item:{type:item.type,status:item.status,command:item.command,exitCode:item.exit_code}}:{type:event.type,itemType:item?.type,status:item?.status};
 writes=writes.then(()=>appendFile(path.join(runDir,'events.jsonl'),JSON.stringify({...safe,taskId:config.taskId,runId:config.runId,at:new Date().toISOString()})+'\n',{mode:0o600})).then(()=>atomic('runtime.json',{runId:config.runId,threadId,completedTurn,commands,updatedAt:new Date().toISOString()}));
});
async function capture(){if(tree){const records=await tree.capture();await atomic('ownership.json',{runId:config.runId,records,at:new Date().toISOString()});}}
await capture();
await atomic('owner.json',{runId:config.runId,supervisorPid:process.pid,supervisorIdentity:(await snapshotProcesses()).get(process.pid)||null,workerPid:worker.pid||null,at:new Date().toISOString()});
let cooperative=false;
const stopOwnedWorker=()=>{if(!stopPromise)stopPromise=tree?tree.stop({graceMs:2000}):Promise.resolve({confirmed:Boolean(spawnError),remaining:[]});return stopPromise;};
const timeoutMs=Number.isSafeInteger(config.timeoutMs)&&config.timeoutMs>=1000&&config.timeoutMs<=86400000?config.timeoutMs:300000;
const timeout=setTimeout(()=>{void(async()=>{await acceptControl().catch(()=>{});if(cooperative)return;errorMessage=`Bounded worker run exceeded ${timeoutMs} milliseconds.`;void stopOwnedWorker();})();},timeoutMs);
let checking=false;
async function acceptControl(){const request=JSON.parse(await readFile(path.join(runDir,'control.json'),'utf8'));if(request.runId!==config.runId||typeof request.requestId!=='string'||!['stop','pause'].includes(request.action)||stopRequest?.requestId===request.requestId)return;stopRequest=request;await atomic('control-accepted.json',{...request,at:new Date().toISOString(),supervisorPid:process.pid,workerPid:worker.pid});if(request.cooperative===true){cooperative=true;clearTimeout(timeout);stopPromise=waitOwnedNatural(tree,{interrupt:true,onBlocked:state=>atomic('cooperative-stop.json',{runId:config.runId,requestId:request.requestId,...state,at:new Date().toISOString()}),isSuperseded:()=>!cooperative});}else{if(cooperative){cooperative=false;stopPromise=null;}void stopOwnedWorker();}}
const controlTimer=setInterval(async()=>{if(checking)return;checking=true;try{await capture();await acceptControl();}catch{}finally{checking=false;}},100);
process.on('SIGTERM',()=>{errorMessage='Worker supervisor was stopped.';if(cooperative){cooperative=false;stopPromise=null;}void stopOwnedWorker();});
const exitCode=await closed;
clearTimeout(timeout);clearInterval(controlTimer);
// A natural CLI exit must also leave no captured command/MCP descendant behind.
await acceptControl().catch(()=>{});
let observedStop=stopPromise;
let ownership=await(observedStop||(cooperative?waitOwnedNatural(tree):null)||tree?.stop({graceMs:1000})||Promise.resolve({confirmed:Boolean(spawnError),remaining:[]}));
if(stopPromise&&stopPromise!==observedStop)ownership=await stopPromise;
await writes;
await atomic('exit.json',{runId:config.runId,threadId,exitCode,completedTurn,commands,finalMessage,error:errorMessage,stopped:Boolean(stopRequest)&&ownership.confirmed,stopConfirmed:ownership.confirmed,ownership:{confirmed:ownership.confirmed,remaining:ownership.remaining||[],tracked:ownership.tracked||[]},stopAction:stopRequest?.action||null,stopRequestId:stopRequest?.requestId||null,supervisorPid:process.pid,workerPid:worker.pid||null,at:new Date().toISOString()});
