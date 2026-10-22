import {existsSync} from 'node:fs';
// GH-50: two packaged versions, explicit disposable profile, manual replacement.
// This deliberately does not invoke Squirrel or claim automatic updater recovery.
// Usage: CREW_ACCEPTANCE_BASELINE_VERSION=0.16.2 node scripts/worker-upgrade-native-acceptance.mjs <old Crew.app> <new Crew.app>
// Baseline defaults to 0.14.0 for existing recorded acceptance commands.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
const {_electron}=await import(process.env.CREW_PLAYWRIGHT_MODULE||'playwright-core');
const exec=promisify(execFile),root=process.cwd(),[oldBundle,newBundle]=process.argv.slice(2);
const baselineVersion=process.env.CREW_ACCEPTANCE_BASELINE_VERSION||'0.14.0';
assert.match(baselineVersion,/^\d+\.\d+\.\d+$/,'Baseline version must be an exact stable version.');
assert.ok(oldBundle&&newBundle,'Supply both packaged Crew.app paths; no installed user app is inferred.');
for(const bundle of [oldBundle,newBundle])assert.ok(path.isAbsolute(bundle)&&bundle.endsWith('.app'));
const dir=await realpath(await mkdtemp(path.join(tmpdir(),'crew-worker-upgrade-'))),installed=path.join(dir,'Crew.app'),binary=path.join(dir,'synthetic-codex'),protocol=path.join(dir,'protocol.jsonl');
console.log('Disposable manual upgrade evidence:',dir);
const packagedRoot=()=>path.join(installed,'Contents/Resources/app');
const source=()=>existsSync(path.join(packagedRoot(),'runtime/package.json'))?path.join(packagedRoot(),'runtime'):packagedRoot();
const packagedStore=()=>path.join(source(),source()===packagedRoot()?'orchestration-store.mjs':'orchestration/store.mjs');
const {createTask,readTask}=await import(pathToFileURL(path.join(root,'runtime/orchestration/store.mjs')));
const projects=[];let electron,nativeProcess,page,stage='old';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,label){const end=Date.now()+30000;while(Date.now()<end){const value=await fn();if(value)return value;await sleep(100);}throw Error('Timed out '+label);}
async function calls(){return (await readFile(protocol,'utf8').catch(()=>'' )).trim().split('\n').filter(Boolean).map(JSON.parse);}
async function quit(){
 if(!nativeProcess||nativeProcess.exitCode!==null||nativeProcess.signalCode!==null)return;
 // Recovery is explicit and limited to this harness's disposable Quit plan.
 // New builds keep the control window open for preparation/approval UI.
 if(page&&!page.isClosed())await page.evaluate(async()=>{
  const action=async value=>{const response=await fetch('/api/updates',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:value})});if(!response.ok)throw Error('Disposable Quit recovery failed');return response.json();};
  const status=await action('status');if(status.workspacePlan?.purpose==='quit'&&['canceled','blocked'].includes(status.workspacePlan.phase))await action('return-to-work');
 });
 // Preserve the older harness boundary for the baseline's legacy Quit path.
 if(stage==='old')await electron.evaluate(({BrowserWindow})=>{for(const window of BrowserWindow.getAllWindows())window.close();});
 await electron.evaluate(({dialog,Menu})=>{dialog.showMessageBox=async()=>({response:1});Menu.getApplicationMenu().items[0].submenu.items.find(x=>x.label==='Quit Crew…').click();});
 await until(()=>nativeProcess.exitCode!==null||nativeProcess.signalCode!==null,'owned native Quit');await electron.close().catch(()=>{});
}
async function request(url,body,method='POST'){const value=await page.evaluate(async({url,body,method})=>{const r=await fetch(url,{method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,body:await r.json()};},{url,body,method});assert.equal(value.status,200,JSON.stringify(value.body));return value.body;}
async function settings(){return request('/api/settings',undefined,'GET');}
async function returnFromOwnedQuit(p){
 if(stage!=='new')return;
 const before=(await request('/api/updates',{action:'status'})).workspacePlan;
 if(!before||before.phase==='complete')return;
 assert.equal(before.purpose,'quit','Only this fixture’s retained Quit hold may be released.');
 assert.equal(before.phase,'canceled','Quit recovery must expose a canceled held plan before explicit Return.');
 const registry=JSON.parse(await readFile(path.join(dir,'app-data','Crew','workspaces.json'),'utf8'));
 const ownedConfigs=new Set(await Promise.all(projects.map(project=>realpath(project.config))));
 assert.ok(before.projects.length>0,'Retained Quit must identify its captured projects.');
 for(const captured of before.projects){
  const registered=registry.projects.find(project=>project.id===captured.id);
  assert.ok(registered,'Retained Quit project must belong to the disposable registry.');
  const canonical=await realpath(registered.configPath);
  assert.ok(ownedConfigs.has(canonical)&&canonical.startsWith(dir+path.sep),'Never release a hold outside this fixture.');
 }
 const blocked=await page.evaluate(async()=>{const response=await fetch('/api/prepare',{method:'POST',headers:{'Content-Type':'application/json'}});return {status:response.status,body:await response.json()};});
 assert.equal(blocked.status,409,'Relaunched Quit preparation must retain admission hold until explicit Return.');
 const proof={kind:p.kind,planId:before.id,purpose:before.purpose,beforePhase:before.phase,prepareBlockedStatus:blocked.status,prepareBlockedMessage:blocked.body.error,action:'return-to-work'};
 summary.explicitQuitReturns.push(proof);
 await request('/api/updates',{action:'return-to-work'});
 const after=(await request('/api/updates',{action:'status'})).workspacePlan;
 assert.equal(after.id,before.id,'Return must release the exact observed Quit plan.');
 assert.equal(after.phase,'complete');
 proof.afterPhase=after.phase;
}
async function launch(p){const env={...process.env,CREW_APP_DATA:path.join(dir,'app-data'),AI_MANAGER_CONFIG:p.config,AI_MANAGER_CODEX_BINARY:binary,CREW_ACCEPTANCE_STAGE:stage,CREW_ACCEPTANCE_STORE:packagedStore()};for(const key of ['ELECTRON_RUN_AS_NODE','AI_MANAGER_PORT','VOICE_PORT'])delete env[key];electron=await _electron.launch({executablePath:path.join(installed,'Contents/MacOS/Crew'),args:['--config',p.config],env,timeout:30000});nativeProcess=electron.process();page=await electron.firstWindow();await page.waitForURL(`http://127.0.0.1:${p.port}/**`);await until(async()=>{const s=await settings();return s.projectId===p.id;},'explicit profile selected');await returnFromOwnedQuit(p);}
async function mcp(p,name,args){const child=spawn(process.execPath,[path.join(source(),'orchestration-mcp.mjs'),p.state,'manager',p.runtime],{stdio:['pipe','pipe','pipe']});let output='',error='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>error+=d);child.stdin.end(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})+'\n');assert.equal(await new Promise(resolve=>child.on('close',resolve)),0,error);const result=JSON.parse(output.trim()).result;assert.ok(!result.isError,result.content?.[0]?.text);return result;}
await writeFile(binary,`#!${process.execPath}
import{createInterface}from'node:readline';import{appendFileSync}from'node:fs';import{pathToFileURL}from'node:url';import{execFileSync}from'node:child_process';
const send=x=>console.log(JSON.stringify(x));if(process.argv.includes('--version')){console.log('codex-cli synthetic-upgrade');process.exit(0);}
const binding=process.argv.find(x=>x.startsWith('mcp_servers.local_orchestration.args='));const bound=binding?JSON.parse(binding.slice(binding.indexOf('=')+1)):[];const[,state,role,task,run]=bound;let thread='upgrade-'+(task||'manager'),turn='turn-'+process.pid,sequence=0;
function call(name,args){const output=execFileSync(process.execPath,bound,{encoding:'utf8',input:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})+'\\n'});const value=JSON.parse(output.trim());if(value.error||value.result.isError)throw Error(value.error?.message||value.result.content[0].text);return JSON.parse(value.result.content[0].text);}
for await(const line of createInterface({input:process.stdin})){const m=JSON.parse(line);appendFileSync(${JSON.stringify(protocol)},JSON.stringify({stage:process.env.CREW_ACCEPTANCE_STAGE,role,pid:process.pid,...m})+'\\n');if(m.id===undefined)continue;let result={};
if(m.method==='account/read')result={account:{type:'chatgpt',planType:'synthetic'}};
if(m.method==='config/read')result={config:{}};if(m.method==='thread/realtime/listVoices')result={voices:{v3:['cove'],defaultV1:'cove'}};
if(m.method==='thread/start'||m.method==='thread/resume'){thread=m.params.threadId||thread;result={thread:{id:thread}};}
if(m.method==='thread/turns/list')result={data:[{id:'saved-turn',status:'completed',items:[{id:'saved-message',type:'agentMessage',text:'Saved upgrade conversation remains available.'}]}],nextCursor:null};
if(m.method==='thread/timeline/list')result={data:[{type:'item',position:0,turnId:'saved-turn',item:{id:'saved-message',type:'agentMessage',text:'Saved upgrade conversation remains available.'}}],nextCursor:null};
if(m.method==='mcpServerStatus/list')result={data:[]};if(m.method==='turn/start'){turn='turn-'+process.pid+'-'+(++sequence);result={turn:{id:turn,status:'inProgress'}};}if(m.method==='turn/steer')result={turnId:m.params.expectedTurnId};send({id:m.id,result});
if(['turn/start','turn/steer'].includes(m.method)&&m.params.input?.[0]?.text?.startsWith('Crew preparation request:')){
 const preparation=call('get_preparation_request',{});if(!preparation)throw Error('Bound upgrade preparation request unavailable');
 call('report_preparation',{preparationId:preparation.preparationId,participantId:preparation.participantId,requestId:preparation.requestId,responseId:'upgrade-ready-'+preparation.requestId,state:'ready',note:'Disposable upgrade context retained and ready.',continuation:'Keep this manager thread, retained worker histories and project files.'});
 send({method:'item/completed',params:{threadId:thread,turnId:turn,item:{id:'preparation-final-'+sequence,type:'agentMessage',text:'Final upgrade preparation response.'}}});send({method:'turn/completed',params:{threadId:thread,turn:{id:turn,status:'completed'}}});continue;
}if(m.method==='turn/start'&&role==='manager'){send({method:'turn/completed',params:{threadId:thread,turn:{id:turn,status:'completed'}}});continue;}
if(m.method==='turn/start'&&role==='worker'){if(process.env.CREW_ACCEPTANCE_STAGE==='new'){const response=execFileSync(${JSON.stringify(process.execPath)},bound,{encoding:'utf8',input:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'set_workflow_state',arguments:{requestId:'upgrade-workflow-'+run,state:'Upgrade verified'}}})+'\\n'});const value=JSON.parse(response.trim());if(value.result.isError)throw Error(value.result.content[0].text);}const output=execFileSync(process.execPath,['--input-type=module','-e','import {sum} from "./src/totals.mjs";console.log(JSON.stringify({emptyActual:sum([]),sumActual:sum([1,2,3])}));'],{encoding:'utf8'});send({method:'item/completed',params:{threadId:thread,turnId:turn,item:{id:'command',type:'commandExecution',command:'node import totals.mjs',exitCode:0,aggregatedOutput:output}}});const {reportTask}=await import(pathToFileURL(process.env.CREW_ACCEPTANCE_STORE));await reportTask(state,task,run,{reportId:'upgrade-result-'+run,kind:'result',message:'Retained '+process.env.CREW_ACCEPTANCE_STAGE+' worker result.',evidence:[JSON.stringify({emptyActual:1,sumActual:7,emptyExpected:0,sumExpected:6,finding:'initial_value_one'})]});send({method:'item/completed',params:{threadId:thread,turnId:turn,item:{id:'reply',type:'agentMessage',text:'Retained worker output.'}}});send({method:'turn/completed',params:{threadId:thread,turn:{id:turn,status:'completed'}}});}}
`,{mode:0o700});
const summary={dir,baselineVersion,manualReplacement:true,automaticUpdaterRecoveryProven:false,syntheticCodex:true,physicalMicrophone:false,sharedQuitPreparation:false,baselineQuitSequence:'close-window-then-Quit',newQuitSequence:'open-control-window-shared-preparation',explicitQuitReturns:[],projects:[]};
try{
 await exec('ditto',[oldBundle,installed]);
 assert.equal(JSON.parse(await readFile(path.join(source(),'package.json'),'utf8')).version,baselineVersion);
 for(const [index,kind]of ['default','custom'].entries()){
  const config=path.join(dir,kind,'project.json');await exec(process.execPath,[path.join(source(),'cli.mjs'),'init','--template','fixture','--config',config]);const raw=JSON.parse(await readFile(config,'utf8'));raw.project.id='upgrade-'+kind;raw.project.name='Upgrade '+kind;raw.runtime.port=59380+index;raw.runtime.codexBinary=binary;await writeFile(config,JSON.stringify(raw));
  const p={id:raw.project.id,kind,config,port:raw.runtime.port,state:path.resolve(path.dirname(config),raw.runtime.dataDir,'orchestration'),taskId:'upgrade-worker-'+kind};p.data=path.dirname(p.state);p.runtime=path.join(p.state,'project-runtime.json');projects.push(p);await mkdir(p.data,{recursive:true});await writeFile(path.join(p.data,'manager-chat.json'),JSON.stringify({threadId:'upgrade-manager-'+kind}));await launch(p);
  let s=await settings();for(const role of ['manager','worker']){const text=kind==='default'?s[role].saved.text:s[role].saved.text+'\nCUSTOM UPGRADE PRESERVATION '+role;await request('/api/settings/prompts',{role,text,expectedVersion:s[role].saved.version},'PUT');s=await settings();}p.beforeSettings=s;p.promptBytes=await readFile(path.join(p.state,'prompt-settings',p.id+'.json'),'utf8');
  await request('/api/prepare');await createTask(p.state,{requestId:p.taskId,ticket:'GH-50',brief:'Disposable upgrade worker; report retained result.',projectId:p.id});p.before=await until(async()=>{const task=await readTask(p.state,p.taskId);return task.status==='completed'?task:null;},'old packaged worker completes');p.runConfig=await readFile(path.join(p.before.runDir,'config.json'),'utf8');await page.getByText('Saved upgrade conversation remains available.',{exact:true}).first().waitFor();await page.screenshot({path:path.join(dir,kind+'-old.png')});p.activeManager=(await settings()).manager;p.activeSnapshot=JSON.parse(await readFile(path.join(p.state,'manager-lifecycle.json'),'utf8')).active;const oldCalls=await calls();p.oldManagerInstructions=oldCalls.filter(x=>x.stage==='old'&&x.role==='manager'&&['thread/start','thread/resume'].includes(x.method)).at(-1).params.developerInstructions;await quit();p.configBytes=await readFile(p.config,'utf8');p.chatBytes=await readFile(path.join(p.data,'manager-chat.json'),'utf8');
 }
 // Only the owned disposable installation changes. Both project roots stay put.
 await rm(installed,{recursive:true});await exec('ditto',[newBundle,installed]);stage='new';
 const expected=Object.fromEntries(await Promise.all(['manager','worker'].map(async role=>[role,await readFile(path.join(source(),'prompts',role+'.md'),'utf8')])));
 for(const p of projects){await launch(p);let s=await settings();for(const role of ['manager','worker'])assert.equal(s[role].saved.text,p.kind==='default'?expected[role]:p.beforeSettings[role].saved.text);if(p.kind==='custom')assert.equal(await readFile(path.join(p.state,'prompt-settings',p.id+'.json'),'utf8'),p.promptBytes);
  assert.equal(s.manager.retainedVersion,p.activeSnapshot.version);assert.deepEqual(JSON.parse(await readFile(path.join(p.state,'manager-lifecycle.json'),'utf8')).active,p.activeSnapshot);if(p.kind==='default')assert.equal(s.manager.pendingRestart,true);await request('/api/prepare');const retainedManager=(await calls()).filter(x=>x.stage==='new'&&x.role==='manager'&&x.method==='thread/resume').at(-1);assert.ok(retainedManager.params.developerInstructions.includes(p.activeSnapshot.text),'retained editable instructions stay unchanged until explicit Restart');assert.equal((await settings()).manager.activeVersion,p.activeSnapshot.version);await request('/api/manager/lifecycle',{action:'restart'});s=await settings();assert.equal(s.manager.pendingRestart,false);const rows=await calls(),manager=rows.filter(x=>x.stage==='new'&&x.role==='manager'&&x.method==='thread/resume').at(-1);assert.equal(manager.params.threadId,'upgrade-manager-'+p.kind);assert.ok(manager.params.developerInstructions.includes(s.manager.saved.text));
  await mcp(p,'get_project_environment',{taskId:p.taskId});await mcp(p,'set_workflow_state',{taskId:p.taskId,requestId:'upgrade-manager-workflow-'+p.kind,state:'Reviewing upgrade'});await mcp(p,'assign_worker_followup',{taskId:p.taskId,requestId:'upgrade-next-'+p.kind,brief:'Continue this retained worker after the upgrade and report the new result.'});const next=await until(async()=>{const task=await readTask(p.state,p.taskId);return task.runId!==p.before.runId&&task.status==='completed'?task:null;},'new packaged continuation');assert.equal(next.threadId,p.before.threadId);assert.equal(next.worktree,p.before.worktree);assert.equal(next.workerPromptSnapshot.text,s.worker.saved.text);assert.equal(next.workflowState.value,'Upgrade verified');assert.equal(next.assignments[0].result.message,p.before.result.message);assert.equal(await readFile(path.join(p.before.runDir,'config.json'),'utf8'),p.runConfig);await page.getByText('Saved upgrade conversation remains available.',{exact:true}).first().waitFor();await page.screenshot({path:path.join(dir,p.kind+'-new.png')});assert.equal(await readFile(p.config,'utf8'),p.configBytes);assert.equal(await readFile(path.join(p.data,'manager-chat.json'),'utf8'),p.chatBytes);summary.projects.push({kind:p.kind,managerThread:manager.params.threadId,workerThread:next.threadId,oldResultRetained:true,newWorkerPrompt:true,customBytesPreserved:p.kind==='custom'});await quit();
 }
 const recorded=await calls();assert.equal(recorded.filter(x=>x.method==='thread/realtime/start').length,0,'no voice connection or capture requested');summary.sharedQuitPreparation=recorded.some(x=>x.stage==='new'&&['turn/start','turn/steer'].includes(x.method)&&x.params?.input?.[0]?.text?.startsWith('Crew preparation request:'));assert.equal(summary.sharedQuitPreparation,true,'new packaged Quit used actual bound preparation tools');assert.ok(summary.explicitQuitReturns.length>0,'Relaunched prepared Quit hold was verified and explicitly returned to work.');summary.pass=true;
}catch(error){summary.error=error.message;process.exitCode=1;throw error;}finally{await quit().catch(error=>console.error('Owned native cleanup:',error.message));await writeFile(path.join(dir,'summary.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify(summary));}
