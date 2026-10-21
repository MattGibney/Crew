// GitHub #43: real native/controller/store acceptance with disposable synthetic Codex/media.
// Build the renderer first. Optional CREW_PLAYWRIGHT_MODULE and CREW_ACCEPTANCE_EXECUTABLE.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const {_electron}=await import(process.env.CREW_PLAYWRIGHT_MODULE||'playwright-core');
const exec=promisify(execFile),root=process.cwd(),dir=await mkdtemp(path.join(tmpdir(),'crew-archive-native-'));
const {createTask,readTask,requestWorkerAction}=await import(pathToFileURL(path.join(root,'orchestration-store.mjs')));
const configPath=path.join(dir,'project','project.json'),binary=path.join(dir,'fake-codex');
const executable=process.env.CREW_ACCEPTANCE_EXECUTABLE||path.join(root,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
console.log('Disposable native archive acceptance:',dir);
const taskId='archive-native-worker',port=Number(process.env.CREW_ACCEPTANCE_PORT||59173);
let electron,nativeProcess,stateDir;
async function until(fn,label){const deadline=Date.now()+45000;while(Date.now()<deadline){const result=await fn();if(result)return result;await new Promise(resolve=>setTimeout(resolve,100));}throw Error('Timed out '+label);}
async function quit(){if(nativeProcess?.exitCode===null){await electron.evaluate(({BrowserWindow})=>{for(const window of BrowserWindow.getAllWindows())window.close();});await electron.evaluate(({dialog,Menu})=>{dialog.showMessageBox=async()=>({response:1});Menu.getApplicationMenu().items[0].submenu.items.find(item=>item.label==='Quit Crew…').click();});await until(()=>nativeProcess.exitCode!==null,'owned native Quit');}}
// Cleanup is registered before launch/first observation. Normal durable stop and app Quit only.
try{
 await writeFile(binary,`#!${process.execPath}
import{createInterface}from'node:readline';import{appendFileSync}from'node:fs';import{execFileSync}from'node:child_process';
import{reportTask}from ${JSON.stringify(pathToFileURL(path.join(root,'orchestration-store.mjs')).href)};
if(process.argv.includes('--version')){console.log('codex synthetic acceptance');process.exit(0);}
const binding=process.argv.find(a=>a.startsWith('mcp_servers.local_orchestration.args='));const[,state,role,taskId,runId]=binding?JSON.parse(binding.slice(binding.indexOf('=')+1)):[];
let threadId='synthetic-'+process.pid;const turnId='archive-turn-'+process.pid;const send=m=>console.log(JSON.stringify(m));
for await(const line of createInterface({input:process.stdin})){const m=JSON.parse(line);appendFileSync(${JSON.stringify(path.join(dir,'protocol.jsonl'))},JSON.stringify({role,method:m.method})+'\\n');if(m.id===undefined)continue;let result={};
if(m.method==='account/read')result={account:{type:'chatgpt',planType:'synthetic'}};
if(m.method==='thread/start'||m.method==='thread/resume'){threadId=m.params.threadId||threadId;result={thread:{id:threadId}};}
if(['thread/turns/list','thread/timeline/list','mcpServerStatus/list'].includes(m.method))result={data:[],nextCursor:null};
if(m.method==='config/read')result={config:{}};
if(m.method==='turn/start')result={turn:{id:turnId,status:'inProgress'}};
if(m.method==='thread/realtime/listVoices')result={voices:{v3:['cove'],defaultV1:'cove'}};
send({id:m.id,result});
if(m.method==='thread/realtime/start'){send({method:'thread/realtime/started',params:{threadId}});send({method:'thread/realtime/sdp',params:{threadId,sdp:'v=0 synthetic-answer'}});}
if(m.method==='turn/interrupt')send({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'interrupted'}}});
if(m.method==='turn/start'&&role==='worker'){
const output=execFileSync(process.execPath,['--input-type=module','-e','import {sum} from "./src/totals.mjs";console.log(JSON.stringify({emptyActual:sum([]),sumActual:sum([1,2,3])}));'],{encoding:'utf8'});
send({method:'item/completed',params:{threadId,turnId,item:{id:'native-command',type:'commandExecution',command:'node import totals.mjs',exitCode:0,aggregatedOutput:output}}});
await reportTask(state,taskId,runId,{reportId:'archive-result',kind:'result',message:'Native archive fixture result retained.',evidence:[JSON.stringify({emptyActual:1,sumActual:7,emptyExpected:0,sumExpected:6,finding:'initial_value_one'})]});
send({method:'item/completed',params:{threadId,turnId,item:{id:'native-reply',type:'agentMessage',text:'Native archive fixture result retained.'}}});send({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed'}}});
}}
`,{mode:0o700});
 await exec(process.execPath,[path.join(root,'cli.mjs'),'init','--template','fixture','--config',configPath]);
 const raw=JSON.parse(await readFile(configPath,'utf8'));raw.runtime.port=port;raw.runtime.codexBinary=binary;raw.project.name='Native archive acceptance';await writeFile(configPath,JSON.stringify(raw,null,2)+'\n');stateDir=path.resolve(path.dirname(configPath),raw.runtime.dataDir,'orchestration');
 await mkdir(path.dirname(stateDir),{recursive:true});await writeFile(path.join(path.dirname(stateDir),'manager-chat.json'),JSON.stringify({threadId:'archive-manager'}));
 const env={...process.env,CREW_APP_DATA:path.join(dir,'app-data'),AI_MANAGER_CONFIG:configPath,AI_MANAGER_CODEX_BINARY:binary};delete env.ELECTRON_RUN_AS_NODE;
 async function launch(){electron=await _electron.launch({executablePath:executable,args:[root,'--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream'],env,timeout:30000});nativeProcess=electron.process();nativeProcess.stderr.on('data',data=>process.stderr.write(data));const page=await electron.firstWindow();await page.waitForURL(`http://127.0.0.1:${port}/**`);return page;}
 let page=await launch();
 await page.getByRole('tab',{name:'Text',exact:true}).click();await page.getByRole('textbox',{name:'Message your manager',exact:true}).fill('Archive preserves this unsent manager draft');
 await page.evaluate(await readFile(path.join(root,'tests/fixtures/browser-media.js'),'utf8'));
 await page.getByRole('tab',{name:'Voice',exact:true}).click();await page.getByRole('button',{name:'Connect voice',exact:true}).click();await page.getByText('Voice connected',{exact:true}).first().waitFor();assert.equal(await page.evaluate(()=>window.__crewMedia.calls),1);
 await createTask(stateDir,{requestId:taskId,ticket:'GH-43',brief:'Native archive acceptance worker',projectId:raw.project.id});
 const completed=await until(async()=>{const task=await readTask(stateDir,taskId).catch(()=>null);return task?.status==='completed'?task:null;},'actual synthetic worker completes');assert.equal(completed.result.message,'Native archive fixture result retained.');
 await page.locator(`[data-worker-id="${taskId}"]`).first().waitFor();await page.locator(`[data-worker-id="${taskId}"]`).first().click();await page.getByRole('tab',{name:'Conversation',exact:true}).waitFor();
 await page.screenshot({path:path.join(dir,'retained-completed-worker.png')});
 await requestWorkerAction(stateDir,{taskId,actionId:'native-archive-action',action:'dispose',expectedRunId:completed.runId});
 const archived=await until(async()=>{const task=await readTask(stateDir,taskId);return task.status==='disposed'&&task.lifecycleRequests.some(r=>r.id==='native-archive-action'&&r.status==='completed')?task:null;},'confirmed ordinary teardown and archive');
 assert.ok(archived.archivedAt);await assert.rejects(access(completed.worktree),{code:'ENOENT'});assert.deepEqual(archived.result,completed.result);assert.equal(archived.brief,completed.brief);
 await page.getByRole('tab',{name:'Voice',exact:true}).waitFor();assert.equal(await page.locator(`[data-worker-id="${taskId}"]`).count(),0);assert.equal(await page.evaluate(()=>window.__crewMedia.calls),1);assert.equal(await page.evaluate(()=>window.__crewMedia.tracks.filter(t=>t.readyState==='live').length),1);
 await page.getByRole('tab',{name:'Text',exact:true}).click();assert.equal(await page.getByRole('textbox',{name:'Message your manager',exact:true}).inputValue(),'Archive preserves this unsent manager draft');
 async function openArchive(){await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('button',{name:'Archived workers',exact:true}).click();}
 const row=()=>page.locator(`[data-archived-worker-id="${taskId}"]`);
 await openArchive();await row().waitFor();assert.equal(await page.getByRole('table').count(),1);assert.equal(await page.getByRole('button',{name:'View history',exact:true}).count(),0);assert.equal(await row().getByRole('button',{name:'Restore',exact:true}).count(),1);await page.screenshot({path:path.join(dir,'archived-workers-table.png')});
 await quit();page=await launch();await openArchive();await row().waitFor();assert.equal((await readTask(stateDir,taskId)).archivedAt,archived.archivedAt);
 const beforeDelete=await readTask(stateDir,taskId);
 await row().getByRole('button',{name:'Delete permanently',exact:true}).click();await row().getByText('Permanently delete this worker’s saved Crew history, results, notes and execution evidence? This cannot be undone.',{exact:true}).waitFor();await page.screenshot({path:path.join(dir,'permanent-delete-confirmation.png')});
 await row().getByRole('button',{name:'Cancel',exact:true}).click();assert.equal((await readTask(stateDir,taskId)).revision,beforeDelete.revision,'Cancel keeps saved worker unchanged');assert.equal(await row().getByRole('button',{name:'Delete permanently',exact:true}).count(),1);
 await row().getByRole('button',{name:'Delete permanently',exact:true}).click();await row().getByRole('button',{name:'Delete permanently',exact:true}).last().click();await row().waitFor({state:'detached'});await assert.rejects(readTask(stateDir,taskId),{code:'ENOENT'});await page.getByText('No archived workers for this project.',{exact:true}).waitFor();await page.screenshot({path:path.join(dir,'archive-after-permanent-delete.png')});
 await quit();page=await launch();await openArchive();await page.getByText('No archived workers for this project.',{exact:true}).waitFor();assert.equal(await row().count(),0);await assert.rejects(readTask(stateDir,taskId),{code:'ENOENT'});await quit();
 const protocol=(await readFile(path.join(dir,'protocol.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);assert.equal(protocol.filter(item=>item.role==='worker'&&item.method==='turn/start').length,1);assert.equal(protocol.filter(item=>item.role==='manager'&&item.method==='turn/start').length,0);
 console.log(JSON.stringify({pass:true,dir,realController:true,syntheticCodex:true,syntheticMediaOnly:true,completedRetained:true,confirmedWorktreeRemoval:true,activeAbsent:true,archivePreservedUntilExplicitDelete:true,nativeRelaunch:true,callAndDraftPreserved:true,deleteCancelPreserves:true,permanentDeleteSurvivesRelaunch:true,restoreUntested:true}));
}catch(error){console.error('Acceptance artifacts:',dir);if(electron)for(const page of electron.windows())console.error((await page.locator('body').innerText().catch(()=>'' )).slice(0,4000));throw error;
}finally{
 if(stateDir){const task=await readTask(stateDir,taskId).catch(()=>null);if(task&&!['completed','failed','stopped','paused','disposed'].includes(task.status)){await requestWorkerAction(stateDir,{taskId,actionId:'native-cleanup-stop',action:'stop',expectedRunId:task.runId||null}).catch(error=>console.error(error.message));await until(async()=>{const task=await readTask(stateDir,taskId);return ['completed','failed','stopped','paused','disposed'].includes(task.status)&&!task.execution?.live;},'durable cleanup stop').catch(error=>console.error(error.message));}}
 await quit().catch(error=>console.error('Owned native cleanup requires review:',error.message));
}
