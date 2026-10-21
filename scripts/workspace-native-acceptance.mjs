// Disposable native acceptance: uses synthetic Codex/media and temp profiles only.
// Supply CREW_PLAYWRIGHT_MODULE if playwright-core is outside local node_modules.
const {_electron}=await import(process.env.CREW_PLAYWRIGHT_MODULE||'playwright-core');
import {mkdtemp,mkdir,writeFile,readFile,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {pathToFileURL} from 'node:url';import path from 'node:path';import assert from 'node:assert/strict';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
const exec=promisify(execFile),root=process.cwd(),dir=await mkdtemp(path.join(tmpdir(),'crew-multi-native-'));
console.log('Disposable acceptance directory:',dir);
const acceptanceExecutable=process.env.CREW_ACCEPTANCE_EXECUTABLE||path.join(root,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
const binary=path.join(dir,'fake-codex');
const workerPath=path.join(dir,'synthetic-worker.mjs');
await writeFile(workerPath,`import{readFile,appendFile}from'node:fs/promises';import{reportTask}from ${JSON.stringify(pathToFileURL(path.join(root,'orchestration-store.mjs')).href)};const args=process.argv.slice(2);const config=args.find(a=>a.startsWith('mcp_servers.local_orchestration.args='));const [,state,,id,runId]=JSON.parse(config.split('=').slice(1).join('='));console.log(JSON.stringify({type:'thread.started',thread_id:'native-'+id}));await appendFile(${JSON.stringify(path.join(dir,'workers.jsonl'))},JSON.stringify({id,runId,state,pid:process.pid})+'\\n');await reportTask(state,id,runId,{reportId:'progress',kind:'progress',message:'Actual native fixture worker running'});await new Promise(()=>setInterval(()=>{},1000));`);
const {createTask,readTask,requestWorkerAction,reportTask}=await import(pathToFileURL(path.join(root,'orchestration-store.mjs')));
async function until(fn,label){const deadline=Date.now()+30000;while(Date.now()<deadline){const result=await fn();if(result)return result;await new Promise(r=>setTimeout(r,100));}throw Error('Timed out '+label);}

await writeFile(binary,`#!${process.execPath}\nimport{createInterface}from'node:readline';import{appendFileSync}from'node:fs';if(process.argv.includes('--version')){console.log('codex-cli synthetic');process.exit(0);}if(process.argv.includes('exec')){await import(${JSON.stringify(pathToFileURL(workerPath).href)});process.exit(0);}for await(const line of createInterface({input:process.stdin})){const m=JSON.parse(line);appendFileSync(${JSON.stringify(path.join(dir,'protocol.jsonl'))},JSON.stringify({cwd:process.cwd(),...m})+'\\n');if(m.id===undefined)continue;let result={};if(m.method==='account/read')result={account:{type:'chatgpt',planType:'synthetic'}};if(m.method==='thread/start'||m.method==='thread/resume')result={thread:{id:m.params.threadId||'synthetic-'+process.pid}};if(['thread/turns/list','mcpServerStatus/list'].includes(m.method))result={data:[],nextCursor:null};if(m.method==='thread/realtime/start'){console.log(JSON.stringify({method:'thread/realtime/started',params:{threadId:m.params.threadId}}));console.log(JSON.stringify({method:'thread/realtime/sdp',params:{threadId:m.params.threadId,sdp:'v=0 synthetic-answer'}}));}if(m.method==='thread/realtime/listVoices')result={voices:{v3:['cove'],defaultV1:'cove'}};console.log(JSON.stringify({id:m.id,result}));}\n`,{mode:0o700});
const configPath=path.join(dir,'first','project.json');
await exec(process.execPath,[path.join(root,'cli.mjs'),'init','--template','fixture','--config',configPath]);
const raw=JSON.parse(await readFile(configPath,'utf8'));raw.runtime.port=59164;raw.runtime.codexBinary=binary;raw.project.name='Native project one';await writeFile(configPath,JSON.stringify(raw,null,2)+'\n');await mkdir(path.join(dir,'first','.data'),{recursive:true});await writeFile(path.join(dir,'first','.data','manager-chat.json'),JSON.stringify({threadId:'retained-manager-one'}));
const before=await readFile(configPath,'utf8');
const env={...process.env,CREW_APP_DATA:path.join(dir,'app-data'),AI_MANAGER_CONFIG:configPath,AI_MANAGER_CODEX_BINARY:binary,AI_MANAGER_PORT:'59999',VOICE_PORT:'59998'};delete env.ELECTRON_RUN_AS_NODE;
let electron,nativeProcess;const cleanupJobs=[];
try{
 electron=await _electron.launch({executablePath:acceptanceExecutable,args:[root,'--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream'],env,timeout:30000});
 nativeProcess=electron.process();nativeProcess.stderr.on('data',data=>process.stderr.write(data));
 let page=await electron.firstWindow({timeout:30000});await page.waitForURL('http://127.0.0.1:59164/**',{timeout:30000});
 await page.getByLabel('Project: Native project one. Manage projects').waitFor();
 const a=await page.evaluate(()=>window.crewWorkspaces.snapshot());assert.equal(a.projects.length,1);assert.equal(before,await readFile(configPath,'utf8'));
 await page.getByRole('textbox',{name:'Message your manager',exact:true}).fill('Unsent native project one draft');
 await page.waitForFunction(()=>!document.querySelector('button[aria-label="Connect voice"]')?.disabled);
 await page.evaluate(await readFile(path.join(root,'tests/fixtures/browser-media.js'),'utf8'));
 await page.getByRole('button',{name:'Connect voice',exact:true}).click();
 await page.getByText('Voice connected',{exact:true}).first().waitFor();
 assert.equal(await page.evaluate(()=>window.__crewMedia.calls),1);
 const voiceBefore=await page.evaluate(()=>fetch('/api/state',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}).then(r=>r.json()));assert.equal(voiceBefore.voiceActive,true);
 await page.getByLabel('Project: Native project one. Manage projects').click();await page.getByRole('button',{name:'Add project',exact:true}).click().catch(error=>{if(!String(error).includes('closed'))throw error;});
 let setup;for(let i=0;i<100;i++){setup=electron.windows().find(p=>p.url().endsWith('setup.html'));if(setup)break;await new Promise(r=>setTimeout(r,100));}assert.ok(setup);await setup.getByRole('heading',{name:'Set up Crew',exact:true}).waitFor();
 const registryFile=path.join(dir,'app-data','Crew','workspaces.json');let reg=JSON.parse(await readFile(registryFile,'utf8'));assert.equal(reg.projects.length,2);const second=reg.projects.find(p=>p.id!==a.selectedId);
 // Existing onboarding remains the production UI; use its supported native save
 // bridge with an explicit synthetic fixture to avoid any real repository/account.


 const secondRaw=JSON.parse(await readFile(second.configPath,'utf8'));secondRaw.project={...raw.project,id:'native-project-two',name:'Native project two',prompts:{manager:'prompts/manager.md',worker:'prompts/worker.md'}};secondRaw.runtime.codexBinary=binary;
 const setupBefore=await setup.evaluate(()=>window.crewSetup.snapshot());
 await setup.evaluate(input=>window.crewSetup.save(input),{revision:setupBefore.revision,config:secondRaw});
 await setup.evaluate(()=>window.crewSetup.launch()).catch(error=>{if(!String(error).includes('closed'))throw error;});
 for(let i=0;i<100;i++){page=electron.windows().find(p=>p.url().startsWith('http://127.0.0.1:')&&!p.isClosed());if(page)break;await new Promise(r=>setTimeout(r,100));}
 await page.getByRole('textbox',{name:'Message your manager',exact:true}).waitFor({timeout:30000});
 const b=await page.evaluate(()=>window.crewWorkspaces.snapshot());assert.equal(b.selectedId,second.id);assert.equal(b.projects.length,2);assert.equal(b.projects.find(p=>p.id===second.id).name,'Native project two');
 const ordinaryEnv={...env};delete ordinaryEnv.AI_MANAGER_CONFIG;
 await exec(acceptanceExecutable,[root],{env:ordinaryEnv,timeout:30000});
 await until(async()=>(await page.evaluate(()=>window.crewWorkspaces.snapshot())).selectedId===second.id,'ordinary second launch retains selected project');
 const aliasPath=path.join(dir,'second-config-alias.json');await symlink(second.configPath,aliasPath);
 await exec(acceptanceExecutable,[root],{env:{...env,AI_MANAGER_CONFIG:aliasPath},timeout:30000});
 const aliasSnapshot=await page.evaluate(()=>window.crewWorkspaces.snapshot());assert.equal(aliasSnapshot.projects.length,2);assert.equal(aliasSnapshot.selectedId,second.id);

 assert.equal(await page.getByRole('textbox',{name:'Message your manager',exact:true}).inputValue(),'');
 await page.evaluate(()=>window.crewWorkspaces.setWorkerLimit(1));
 const stateA=path.join(dir,'first','.data','orchestration'),stateB=path.resolve(path.dirname(second.configPath),secondRaw.runtime.dataDir,'orchestration');
 const taskId='same-task-id';cleanupJobs.push({stateDir:stateA,taskId},{stateDir:stateB,taskId});
 await Promise.all([createTask(stateA,{requestId:taskId,ticket:'AI-004',brief:'synthetic native worker one',projectId:raw.project.id}),createTask(stateB,{requestId:taskId,ticket:'AI-004',brief:'synthetic native worker two',projectId:secondRaw.project.id})]);
 await until(async()=>{const tasks=await Promise.all([readTask(stateA,taskId),readTask(stateB,taskId)]);return tasks.some(t=>t.threadId)&&tasks.some(t=>t.status==='queued'&&t.capacityWait);},'one global admission, other waiting');
 const slots=JSON.parse(await readFile(path.join(dir,'app-data/Crew/capacity/capacity.json'),'utf8'));assert.equal(slots.claims.length,1);
 await page.evaluate(()=>window.crewWorkspaces.setWorkerLimit(2));
 const running=await until(async()=>{const tasks=await Promise.all([readTask(stateA,taskId),readTask(stateB,taskId)]);return tasks.every(t=>t.threadId&&t.execution?.live)?tasks:null;},'both native workers running');
 assert.notEqual(running[0].worktree,running[1].worktree);assert.notEqual(running[0].runId,running[1].runId);


 await page.evaluate(id=>window.crewWorkspaces.rename({id,name:'Renamed project two'}),second.id);
 await page.getByLabel('Project: Renamed project two. Manage projects').waitFor();
 await page.getByRole('textbox',{name:'Message your manager',exact:true}).fill('Unsent native project two draft');
 const old=page;
 await page.evaluate(id=>{void window.crewWorkspaces.select(id)},a.selectedId).catch(()=>{});
 for(let i=0;i<100;i++){page=electron.windows().find(p=>p!==old&&p.url().startsWith('http://127.0.0.1:59164'));if(page)break;await new Promise(r=>setTimeout(r,100));}
 await page.getByRole('textbox',{name:'Message your manager',exact:true}).waitFor({timeout:30000});assert.equal(await page.getByRole('textbox',{name:'Message your manager',exact:true}).inputValue(),'Unsent native project one draft');
 const stillRunning=await Promise.all([readTask(stateA,taskId),readTask(stateB,taskId)]);assert.deepEqual(stillRunning.map(t=>t.runId),running.map(t=>t.runId));assert.ok(stillRunning.every(t=>t.execution?.live));
 assert.equal((await readFile(path.join(dir,'workers.jsonl'),'utf8')).trim().split('\n').length,2);
 // Attention belongs to its originating project even when task IDs coincide.
 await Promise.all(running.map((t,i)=>reportTask(i?stateB:stateA,taskId,t.runId,{reportId:'question',kind:'question',message:i?'Question for project two':'Question for project one'})));
 await until(async()=>{const value=await page.evaluate(()=>window.crewWorkspaces.snapshot());return value.projects.every(p=>p.pending>0);},'all-project attention');
 const trayTitle=await electron.evaluate(({Menu})=>Menu.getApplicationMenu().items[0].label);assert.equal(trayTitle,'Crew');
 await Promise.all(running.map((t,i)=>requestWorkerAction(i?stateB:stateA,{taskId,actionId:'native-stop',action:'stop',expectedRunId:t.runId})));
 await until(async()=>{const tasks=await Promise.all([readTask(stateA,taskId),readTask(stateB,taskId)]);return tasks.every(t=>t.status==='stopped'&&!t.execution?.live);},'both native workers confirmed stopped');
 await page.getByLabel('Project: Native project one. Manage projects').click();await page.screenshot({path:path.join(dir,'native-project-switcher.png')});
 await page.evaluate(()=>window.crewWorkspaces.setWorkerLimit(1));
 reg=JSON.parse(await readFile(registryFile,'utf8'));assert.equal(reg.workerLimit,1);
 const cap=JSON.parse(await readFile(path.join(dir,'app-data','Crew','capacity','capacity.json'),'utf8'));assert.equal(cap.limit,1);assert.equal(cap.stateDirs.length,2);
 const proof=(await readFile(path.join(dir,'protocol.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);assert.ok(!proof.some(m=>m.method==='turn/start'));assert.equal(proof.filter(m=>m.method==='thread/realtime/start').length,1);assert.ok(proof.some(m=>m.method==='thread/realtime/stop'));
 const afterVoice=await page.evaluate(()=>fetch('/api/state',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}).then(r=>r.json()));assert.equal(afterVoice.voiceActive,false);
 await electron.evaluate(({BrowserWindow})=>{for(const w of BrowserWindow.getAllWindows())w.close();});
 await new Promise(r=>setTimeout(r,600));assert.equal(electron.windows().length,0);
 const marker=JSON.parse(await readFile(path.join(dir,'first','.data','server.json'),'utf8'));process.kill(marker.pid,0);
 const otherRaw=JSON.parse(await readFile(second.configPath,'utf8'));const otherMarker=JSON.parse(await readFile(path.join(path.dirname(second.configPath),otherRaw.runtime.dataDir,'server.json'),'utf8'));process.kill(otherMarker.pid,0);
 // Explicit app-wide Quit via the normal menu; auto-answer only our synthetic dialog.
 await electron.evaluate(({dialog,Menu})=>{dialog.showMessageBox=async options=>{console.log('Synthetic native dialog:',options.message);return {response:1};};Menu.getApplicationMenu().items[0].submenu.items.find(i=>i.label==='Quit Crew…').click();});
 await until(()=>nativeProcess.exitCode!==null,'native Quit exits the app');
 for(const pid of [marker.pid,otherMarker.pid])assert.throws(()=>process.kill(pid,0));
 console.log('Native check: reopen');
 const reopenEnv={...env};delete reopenEnv.AI_MANAGER_CONFIG;
 electron=await _electron.launch({executablePath:acceptanceExecutable,args:[root,'--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream'],env:reopenEnv,timeout:30000});
 nativeProcess=electron.process();nativeProcess.stderr.on('data',data=>process.stderr.write(data));console.log('Native check: reopened process launched');
 page=await electron.firstWindow({timeout:30000});await page.waitForURL('http://127.0.0.1:59164/**',{timeout:30000});
 await page.getByRole('textbox',{name:'Message your manager',exact:true}).waitFor();assert.equal(await page.getByRole('textbox',{name:'Message your manager',exact:true}).inputValue(),'Unsent native project one draft');
 console.log('Native check: reopened draft restored');
 const reopened=await page.evaluate(()=>window.crewWorkspaces.snapshot());assert.equal(reopened.selectedId,reg.selectedId);assert.equal(reopened.workerLimit,1);assert.equal(reopened.projects.length,2);
 console.log('Native check: reopened registry restored');
 const reopenedState=await page.evaluate(()=>fetch('/api/state',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}).then(r=>r.json()));assert.equal(reopenedState.voiceActive,false);
 await electron.evaluate(({dialog,Menu})=>{dialog.showMessageBox=async options=>{console.log('Synthetic native dialog:',options.message);return {response:1};};Menu.getApplicationMenu().items[0].submenu.items.find(i=>i.label==='Quit Crew…').click();});
 await until(()=>nativeProcess.exitCode!==null,'native Quit exits the app');
 console.log(JSON.stringify({pass:true,dir,controllers:[marker.pid,otherMarker.pid],projects:reg.projects.map(p=>p.id),syntheticVoiceOnly:true,reopened:true,liveWorkerSwitch:true,globalRace:true,attention:true}));
}catch(error){console.error(error);if(electron){console.error('WINDOWS',electron.windows().map(p=>p.url()));for(const p of electron.windows())console.error((await p.locator('body').innerText().catch(()=>'' )).slice(0,3500));}throw error;
}finally{
 for(const job of cleanupJobs){const task=await readTask(job.stateDir,job.taskId).catch(()=>null);if(task&&!['stopped','paused','disposed','completed','failed'].includes(task.status))await requestWorkerAction(job.stateDir,{taskId:job.taskId,actionId:'acceptance-cleanup',action:'stop',expectedRunId:task.runId||null}).catch(error=>console.error('Synthetic cleanup requires review:',job.stateDir,error.message));}
 if(cleanupJobs.length)await until(async()=>{const tasks=await Promise.all(cleanupJobs.map(job=>readTask(job.stateDir,job.taskId).catch(()=>null)));return tasks.every(task=>!task||['stopped','paused','disposed','completed','failed'].includes(task.status)&&!task.execution?.live);},'synthetic cleanup').catch(error=>console.error(error.message));
 if(nativeProcess?.exitCode===null){await electron.evaluate(({dialog,Menu})=>{dialog.showMessageBox=async options=>{console.log('Synthetic native dialog:',options.message);return {response:1};};Menu.getApplicationMenu().items[0].submenu.items.find(i=>i.label==='Quit Crew…').click();}).catch(()=>{});}}
