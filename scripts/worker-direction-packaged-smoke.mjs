// GH-50/GH-62 packaged Electron smoke. Synthetic native peer; isolated profile/repo only.
// CREW_ACCEPTANCE_EXECUTABLE must name the built package's Contents/MacOS/Crew.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createTask,readTask} from '../runtime/orchestration/store.mjs';
const {_electron}=await import(process.env.CREW_PLAYWRIGHT_MODULE||'playwright-core');
const exec=promisify(execFile),root=process.cwd(),executable=process.env.CREW_ACCEPTANCE_EXECUTABLE;
if(!executable||!path.isAbsolute(executable)||!executable.includes('.app/Contents/MacOS/'))throw Error('Supply the built package executable through CREW_ACCEPTANCE_EXECUTABLE.');
const dir=await mkdtemp(path.join(tmpdir(),'crew-gh50-packaged-')),configPath=path.join(dir,'project','project.json'),binary=path.join(dir,'synthetic-codex'),protocol=path.join(dir,'protocol.jsonl');
const port=Number(process.env.CREW_ACCEPTANCE_PORT||59181),taskId='packaged-smoke-worker';
console.log(JSON.stringify({event:'packaged-smoke-fixture',evidenceDir:dir,executable}));
let electron,nativeProcess,stateDir;
const until=async(fn,label)=>{const end=Date.now()+45000;while(Date.now()<end){const value=await fn();if(value)return value;await new Promise(resolve=>setTimeout(resolve,100));}throw Error('Timed out '+label);};
async function quit(){if(nativeProcess?.exitCode===null&&nativeProcess?.signalCode===null){const page=electron.windows()[0];if(page){await page.evaluate(async()=>{const request=async action=>{const response=await fetch('/api/updates',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action})});if(!response.ok)throw Error('Fixture preparation recovery failed');return response.json();};const status=await request('status');if(status.workspacePlan?.purpose==='quit'&&status.workspacePlan.phase==='canceled')await request('return-to-work');});}await electron.evaluate(({dialog,Menu})=>{dialog.showMessageBox=async()=>({response:1});Menu.getApplicationMenu().items[0].submenu.items.find(item=>item.label==='Quit Crew…').click();});await until(()=>nativeProcess.exitCode!==null||nativeProcess.signalCode!==null,'owned packaged Quit');}}
try{
 await writeFile(binary,`#!${process.execPath}
import{createInterface}from'node:readline';import{appendFileSync}from'node:fs';import{execFileSync,spawnSync}from'node:child_process';
if(process.argv.includes('--version')){console.log('codex synthetic packaged smoke');process.exit(0);}
const binding=process.argv.find(arg=>arg.startsWith('mcp_servers.local_orchestration.args='));const mcpArgs=binding?JSON.parse(binding.slice(binding.indexOf('=')+1)):[];const[,state,role,taskId,runId]=mcpArgs;
let threadId=role==='worker'?'packaged-native-worker':'packaged-native-manager',resumed=false,sequence=0;const send=value=>console.log(JSON.stringify(value));
function call(name,args){const request={jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}};const result=spawnSync(process.execPath,mcpArgs,{input:JSON.stringify(request)+'\\n',encoding:'utf8',env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}});if(result.status!==0)throw Error('Bound packaged MCP failed: '+result.stderr);const response=JSON.parse(result.stdout.trim()).result;if(response.isError)throw Error('Bound packaged tool failed: '+response.content?.[0]?.text);return response;}
for await(const line of createInterface({input:process.stdin})){const m=JSON.parse(line);if(m.id===undefined)continue;appendFileSync(${JSON.stringify(protocol)},JSON.stringify({role,method:m.method,threadId,input:m.params?.input?.[0]?.text})+'\\n');let result={};
if(m.method==='account/read')result={account:{type:'chatgpt',planType:'synthetic'}};
if(m.method==='config/read')result={config:{sandbox_mode:'read-only',approval_policy:'on-request'}};
if(m.method==='thread/start'||m.method==='thread/resume'){resumed=m.method==='thread/resume';threadId=m.params.threadId||threadId;result={thread:{id:threadId}};}
if(m.method==='thread/timeline/list'){send({id:m.id,error:{code:-32601,message:'Method not found'}});continue;}
if(['thread/turns/list','mcpServerStatus/list'].includes(m.method))result={data:[]};
if(m.method==='thread/realtime/listVoices')result={voices:{v3:['cove'],defaultV1:'cove'}};
if(m.method==='thread/realtime/start')throw Error('Voice must remain disconnected during packaged smoke');
const turnId='packaged-turn-'+(runId||process.pid)+'-'+(++sequence);
if(m.method==='turn/start')result={turn:{id:turnId,status:'inProgress'}};
if(m.method==='turn/steer')result={turnId:m.params.expectedTurnId};
send({id:m.id,result});
if(m.method==='turn/interrupt')send({method:'turn/completed',params:{threadId,turn:{id:m.params.turnId,status:'interrupted'}}});
if(m.method==='turn/start'){
 let text;
 if(m.params.input[0].text.startsWith('Crew preparation request:')){
  const response=call('get_preparation_request',{}),request=JSON.parse(response.content[0].text);if(!request)throw Error('Missing bound packaged preparation request');
  call('report_preparation',{preparationId:request.preparationId,participantId:request.participantId,requestId:request.requestId,responseId:'packaged-ready-'+request.requestId,state:'ready',note:'Packaged fixture continuation is saved; ready for shutdown.',continuation:'Retained worker results, files and chat remain available.'});text='Final packaged preparation response received before shutdown.';
 }else if(role==='worker'){
  const commandArgs=['--input-type=module','-e','import {sum} from "./src/totals.mjs";console.log(JSON.stringify({emptyActual:sum([]),sumActual:sum([1,2,3])}));'];
  const output=execFileSync(process.execPath,commandArgs,{encoding:'utf8'});
  send({method:'item/completed',params:{threadId,turnId,item:{id:'smoke-command',type:'commandExecution',command:[process.execPath,...commandArgs.map(arg=>JSON.stringify(arg))].join(' '),exitCode:0,aggregatedOutput:output}}});
  call('set_workflow_state',{requestId:'workflow-'+runId,state:resumed?'Ready for review':'Research complete'});
  text=resumed?'Packaged follow-up result retained.':'Packaged initial research result retained.';
  call('report',{reportId:'packaged-result',kind:'result',message:text,evidence:[JSON.stringify({emptyActual:1,sumActual:7,emptyExpected:0,sumExpected:6,finding:'initial_value_one'})]});
 }else if(m.params.input[0].text==='Continue packaged smoke worker with the existing context.'){
  call('assign_worker_followup',{taskId:${JSON.stringify(taskId)},requestId:'packaged-smoke-direction',brief:m.params.input[0].text});text='Direction queued for the retained fixture worker.';
 }else text='Tell me your next direction for this retained fixture worker.';
 send({method:'item/completed',params:{threadId,turnId,item:{id:'smoke-reply-'+sequence,type:'agentMessage',text}}});send({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed'}}});
}}
`,{mode:0o700});
 await exec(process.execPath,[path.join(root,'runtime/cli.mjs'),'init','--template','fixture','--config',configPath]);
 const raw=JSON.parse(await readFile(configPath,'utf8'));raw.runtime.port=port;raw.runtime.codexBinary=binary;raw.project.name='GH50 packaged smoke';await writeFile(configPath,JSON.stringify(raw,null,2)+'\n');
 stateDir=path.resolve(path.dirname(configPath),raw.runtime.dataDir,'orchestration');await mkdir(path.dirname(stateDir),{recursive:true});await writeFile(path.join(path.dirname(stateDir),'manager-chat.json'),JSON.stringify({threadId:'packaged-native-manager'}));
 const env={...process.env,CREW_APP_DATA:path.join(dir,'app-data'),AI_MANAGER_CONFIG:configPath,AI_MANAGER_CODEX_BINARY:binary};for(const key of ['ELECTRON_RUN_AS_NODE','AI_MANAGER_PORT','VOICE_PORT'])delete env[key];
 const errors=[];
 async function launch(){electron=await _electron.launch({executablePath:executable,args:[],env,timeout:45000});nativeProcess=electron.process();const page=await electron.firstWindow({timeout:45000});await page.waitForURL('http://127.0.0.1:'+port+'/**',{timeout:45000});await page.evaluate(()=>{window.__smokeMicrophoneCalls=0;const media=navigator.mediaDevices;if(media)media.getUserMedia=async()=>{window.__smokeMicrophoneCalls++;throw Error('Physical media prohibited in packaged smoke');};});page.on('pageerror',error=>errors.push(error.message));return page;}
 let page=await launch();await page.getByRole('tab',{name:'Text',exact:true}).click();
 await createTask(stateDir,{requestId:taskId,ticket:'GH-50',brief:'Research the disposable packaged fixture',projectId:raw.project.id});
 const initial=await until(async()=>{const task=await readTask(stateDir,taskId);if(task.status==='failed')throw Error(task.failure);return task.status==='completed'&&task.workflowState?.value==='Research complete'?task:null;},'packaged synthetic worker result');
 await page.locator('[data-worker-id="'+taskId+'"]').click();await page.getByRole('tab',{name:'Overview',exact:true}).click();
 const detail=()=>page.getByRole('region',{name:'Worker detail',exact:true});
 await detail().getByLabel('Status: Research complete',{exact:true}).first().waitFor();await detail().getByLabel('Execution: Turn ended',{exact:true}).first().waitFor();
 await page.getByRole('button',{name:'Send direction',exact:true}).click();await page.getByRole('tab',{name:'Text',exact:true}).click();
 await page.getByRole('textbox',{name:'Message your manager',exact:true}).fill('Continue packaged smoke worker with the existing context.');await page.getByRole('button',{name:'Send message',exact:true}).click();
 const followed=await until(async()=>{const task=await readTask(stateDir,taskId);if(task.status==='failed')throw Error(task.failure);return task.status==='completed'&&task.assignments?.length===2&&task.workflowState?.value==='Ready for review'?task:null;},'packaged same-context followup');
 assert.equal(followed.threadId,initial.threadId);assert.equal(followed.worktree,initial.worktree);assert.equal(followed.assignments[0].result.message,initial.result.message);
 await page.getByRole('textbox',{name:'Message your manager',exact:true}).fill('Unsent packaged smoke draft');
 await page.locator('[data-worker-id="'+taskId+'"]').click();await page.getByRole('tab',{name:'Overview',exact:true}).click();await detail().getByLabel('Status: Ready for review',{exact:true}).first().waitFor();
 await page.screenshot({path:path.join(dir,'packaged-workflow-and-execution.png')});
 assert.equal(await page.evaluate(()=>window.__smokeMicrophoneCalls),0);const before={threadId:followed.threadId,worktree:followed.worktree,result:followed.result,assignments:followed.assignments,workflowState:followed.workflowState,workflowHistory:followed.workflowHistory,history:followed.history};
 await quit();page=await launch();await page.getByRole('tab',{name:'Text',exact:true}).click();assert.equal(await page.getByRole('textbox',{name:'Message your manager',exact:true}).inputValue(),'Unsent packaged smoke draft');
 await page.locator('[data-worker-id="'+taskId+'"]').click();await page.getByRole('tab',{name:'Overview',exact:true}).click();await detail().getByLabel('Status: Ready for review',{exact:true}).first().waitFor();await detail().getByLabel('Execution: Turn ended',{exact:true}).first().waitFor();
 const after=await readTask(stateDir,taskId);for(const key of Object.keys(before))assert.deepEqual(after[key],before[key],key+' survives packaged relaunch');
 await page.getByRole('tab',{name:'Conversation',exact:true}).click();await detail().getByText('Packaged follow-up result retained.',{exact:true}).first().waitFor();await page.screenshot({path:path.join(dir,'packaged-history-after-relaunch.png')});
 const calls=(await readFile(protocol,'utf8')).trim().split('\n').map(JSON.parse);assert.equal(calls.filter(call=>call.method==='thread/realtime/start').length,0);assert.equal(calls.filter(call=>call.role==='worker'&&call.method==='turn/start').length,2);assert.equal(calls.filter(call=>call.role==='worker'&&call.method==='thread/resume').length,1);assert.equal(await page.evaluate(()=>window.__smokeMicrophoneCalls),0);assert.deepEqual(errors,[]);
 assert.ok(calls.some(call=>call.role==='manager'&&call.method==='turn/start'&&call.input?.startsWith('Crew preparation request:')),'explicit Quit received an actual agent preparation response');
 const proof={pass:true,evidenceDir:dir,packagedExecutable:executable,syntheticNativePeer:true,physicalMicrophoneCalls:0,sameWorkerThread:after.threadId,sameWorktree:after.worktree,assignments:after.assignments.length,explicitWorkflow:after.workflowState.value,persistedHistory:true,draftPreserved:true,packagedMcpTools:true,sharedQuitPreparation:true,preparationReports: calls.filter(call=>call.role==='manager'&&call.method==='turn/start'&&call.input?.startsWith('Crew preparation request:')).length};await writeFile(path.join(dir,'proof.json'),JSON.stringify(proof,null,2)+'\n');console.log(JSON.stringify(proof));
}catch(error){console.error('Packaged smoke evidence:',dir);for(const page of electron?.windows()||[])await page.screenshot({path:path.join(dir,'packaged-failure.png')}).catch(()=>{});throw error;}finally{await quit();}
