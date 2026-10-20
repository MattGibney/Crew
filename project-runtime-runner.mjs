// AI-012: persistent owned foreground project script; no controller/window lifetime coupling.
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {readFile,writeFile,rename} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {OwnedProcessTree,snapshotProcesses} from './process-ownership.mjs';
const configPath=process.argv[2],config=JSON.parse(await readFile(configPath,'utf8')),dir=path.dirname(configPath),now=()=>new Date().toISOString();
async function save(name,value){const file=path.join(dir,name),temp=`${file}.${randomUUID()}.tmp`;await writeFile(temp,JSON.stringify(value,null,2)+'\n',{mode:0o600});await rename(temp,file);}
let closed=false,spawnError=null,commandCode=null,resolveCommand,stopPromise=null,stopRequest=null,diagnostics=null;
const commandDone=new Promise(r=>{resolveCommand=r;});
const runtimeEnv={...process.env};for(const key of ['OPENAI_API_KEY','CODEX_API_KEY','OPENAI_BASE_URL'])delete runtimeEnv[key];
const child=spawn(process.execPath,[fileURLToPath(new URL('./environment-command.mjs',import.meta.url)),configPath],{cwd:config.worktree,env:runtimeEnv,detached:true,stdio:['pipe','pipe','ignore']});
const childDone=new Promise(r=>{child.once('error',e=>{spawnError=e.code||'spawn failed';closed=true;resolveCommand();r();});child.once('close',()=>{closed=true;resolveCommand();r();});});
child.stdin.on('error',e=>{spawnError=e.code||'control failed';resolveCommand();});
const lines=createInterface({input:child.stdout});lines.on('line',line=>{try{const e=JSON.parse(line);if(e.type==='hook-started')void save('command-started.json',{id:config.id,environmentId:config.environmentId,pid:e.pid,at:now()});if(e.type==='hook-diagnostics')diagnostics=e.diagnostics;if(e.type==='hook-exit'){diagnostics=e.diagnostics||diagnostics;commandCode=e.code;spawnError=e.error;resolveCommand();}}catch{}});
const tree=child.pid?new OwnedProcessTree(child.pid):null;
await save('started.json',{id:config.id,environmentId:config.environmentId,pid:process.pid,identity:(await snapshotProcesses()).get(process.pid)||null,workerPid:child.pid||null,at:now()});
if(tree)await tree.capture();if(!closed)child.stdin.write('start\n');
const stop=()=>{if(!stopPromise)stopPromise=tree?tree.stop({graceMs:2500}):Promise.resolve({confirmed:Boolean(spawnError),remaining:[]});return stopPromise;};
let checking=false;const timer=setInterval(async()=>{if(checking)return;checking=true;try{if(tree)await save('ownership.json',{id:config.id,records:await tree.capture(),at:now()});const control=JSON.parse(await readFile(path.join(dir,'control.json'),'utf8'));if(control.id===config.id&&control.environmentId===config.environmentId&&control.action==='stop'){stopRequest=control;void stop();}}catch{}finally{checking=false;}},150);
process.on('SIGTERM',()=>{stopRequest={id:config.id,action:'stop',reason:'supervisor signal'};void stop();});
await commandDone;clearInterval(timer);const ownership=await(stopPromise||stop());await childDone;lines.close();
await save('exit.json',{id:config.id,environmentId:config.environmentId,stopConfirmed:ownership.confirmed,remaining:ownership.remaining||[],exitCode:commandCode,error:spawnError,requestedStop:Boolean(stopRequest),diagnostics,at:now()});
