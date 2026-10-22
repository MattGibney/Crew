// GH74: actual packaged Settings and environment store; disposable profile only.
// CREW_ACCEPTANCE_EXECUTABLE=/absolute/Crew.app/Contents/MacOS/Crew node scripts/settings-null-phases-packaged-acceptance.mjs
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const {_electron}=await import(process.env.CREW_PLAYWRIGHT_MODULE||'playwright-core');
const executable=process.env.CREW_ACCEPTANCE_EXECUTABLE;
assert.ok(executable&&path.isAbsolute(executable)&&executable.includes('.app/Contents/MacOS/'),'Supply the packaged Crew executable explicitly.');
const bundled=path.resolve(path.dirname(executable),'../Resources/app/runtime');
const version=JSON.parse(await readFile(path.join(bundled,'package.json'),'utf8')).version;
if(process.env.CREW_ACCEPTANCE_EXPECTED_VERSION)assert.equal(version,process.env.CREW_ACCEPTANCE_EXPECTED_VERSION);
const output=await mkdtemp(path.join(tmpdir(),'crew-gh74-settings-')),configPath=path.join(output,'project','project.json'),binary=path.join(output,'synthetic-codex'),protocol=path.join(output,'protocol.jsonl');
const port=Number(process.env.CREW_ACCEPTANCE_PORT||59474),run=promisify(execFile),nullPhases=['setup','ready','resume','stop','teardown'];
const errors=[],proof={ticket:'GH74',output,executable,version,syntheticProvider:true,physicalMicrophoneCalls:0};
let app,native,page;
console.log(JSON.stringify({event:'settings-null-phases-fixture',output,executable,version}));
async function until(fn,label){const end=Date.now()+45000;while(Date.now()<end){if(await fn())return;await new Promise(resolve=>setTimeout(resolve,100));}throw Error('Timed out '+label);}
async function quit(){
 if(!native||native.exitCode!==null||native.signalCode!==null)return;
 await app.evaluate(({dialog,Menu})=>{dialog.showMessageBox=async()=>({response:1});Menu.getApplicationMenu().items[0].submenu.items.find(item=>item.label==='Quit Crew…').click();});
 await until(()=>native.exitCode!==null||native.signalCode!==null,'normal owned native Quit');
 await app.close().catch(()=>{});
}
async function settings(){const response=await page.request.get(`http://127.0.0.1:${port}/api/settings`);assert.equal(response.status(),200);return response.json();}
async function openSettings(){await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('button',{name:'Worker environment',exact:true}).click();return page.getByRole('form',{name:'Worker environment configuration'});}
async function launch(){
 const env={...process.env,CREW_APP_DATA:path.join(output,'native-profile'),AI_MANAGER_CONFIG:configPath,AI_MANAGER_CODEX_BINARY:binary};
 for(const key of ['ELECTRON_RUN_AS_NODE','AI_MANAGER_PORT','VOICE_PORT'])delete env[key];
 app=await _electron.launch({executablePath:executable,args:['--config',configPath],env,timeout:45000});native=app.process();
 app.context().on('page',newPage=>newPage.on('pageerror',error=>errors.push(error.message)));
 await app.context().addInitScript(()=>{window.__gh74MediaCalls=0;const media=navigator.mediaDevices;if(media)media.getUserMedia=async()=>{window.__gh74MediaCalls++;throw Error('GH74 physical capture prohibited');};});
 page=await app.firstWindow();page.on('pageerror',error=>errors.push(error.message));await page.waitForURL(`http://127.0.0.1:${port}/**`,{timeout:45000});
 // Reload under the capture guard before exercising Settings.
 await page.reload();await page.getByRole('button',{name:'Settings',exact:true}).waitFor();
}
function assertPlan(value,command){for(const phase of nullPhases)assert.equal(value[phase],null,phase+' remains null');assert.equal(value.start.command,command);}
try{
 await writeFile(protocol,'');
 await writeFile(binary,`#!${process.execPath}
import{createInterface}from'node:readline';import{appendFileSync}from'node:fs';import{execFileSync}from'node:child_process';
if(process.argv.includes('--version')){console.log('codex-cli synthetic GH74');process.exit(0);}
const binding=process.argv.find(x=>x.startsWith('mcp_servers.local_orchestration.args='));const bound=binding?JSON.parse(binding.slice(binding.indexOf('=')+1)):[];let thread='gh74-manager',sequence=0;const send=x=>console.log(JSON.stringify(x));
function call(name,args){const output=execFileSync(process.execPath,bound,{encoding:'utf8',input:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})+'\\n'});const value=JSON.parse(output.trim());if(value.error||value.result.isError)throw Error(value.error?.message||value.result.content[0].text);return JSON.parse(value.result.content[0].text);}
for await(const line of createInterface({input:process.stdin})){const m=JSON.parse(line);appendFileSync(${JSON.stringify(protocol)},line+'\\n');if(m.id===undefined)continue;let result={};
if(m.method==='account/read')result={account:{type:'chatgpt',planType:'synthetic'}};if(m.method==='config/read')result={config:{}};
if(m.method==='thread/start'||m.method==='thread/resume'){thread=m.params.threadId||thread;result={thread:{id:thread}};}
if(['thread/timeline/list','thread/turns/list','mcpServerStatus/list'].includes(m.method))result={data:[],nextCursor:null};
if(m.method==='thread/realtime/listVoices')result={voices:{v3:['cove'],defaultV1:'cove'}};
if(m.method==='thread/realtime/start')throw Error('GH74 voice prohibited');
const turn='gh74-preparation-'+(++sequence);if(m.method==='turn/start')result={turn:{id:turn,status:'inProgress'}};if(m.method==='turn/steer')result={turnId:m.params.expectedTurnId};send({id:m.id,result});
if(['turn/start','turn/steer'].includes(m.method)){
 if(!m.params.input?.[0]?.text?.startsWith('Crew preparation request:'))throw Error('GH74 ordinary model work prohibited');
 const preparation=call('get_preparation_request',{});if(!preparation)throw Error('Missing bound preparation request');call('report_preparation',{preparationId:preparation.preparationId,participantId:preparation.participantId,requestId:preparation.requestId,responseId:'gh74-ready-'+preparation.requestId,state:'ready',note:'Only disposable Settings changed; context saved.',continuation:'Retain the GH74 fixture settings.'});
 const finalTurn=m.method==='turn/steer'?m.params.expectedTurnId:turn;send({method:'item/completed',params:{threadId:thread,turnId:finalTurn,item:{id:'gh74-final',type:'agentMessage',text:'Settings fixture ready for normal Quit.'}}});send({method:'turn/completed',params:{threadId:thread,turn:{id:finalTurn,status:'completed'}}});
}}
`,{mode:0o700});
 await run(process.execPath,[path.join(bundled,'cli.mjs'),'init','--template','fixture','--config',configPath]);
 const raw=JSON.parse(await readFile(configPath,'utf8'));raw.runtime.port=port;raw.runtime.codexBinary=binary;raw.project.name='GH74 null phases';
 const source={path:'AGENTS.md',sha256:'a'.repeat(64)},original='printf gh74-not-executed',edited='printf gh74-saved-not-executed';
 raw.project.worker.environment={executionPlan:{schemaVersion:1,sources:[source],...Object.fromEntries(nullPhases.map(phase=>[phase,null])),start:{command:original,source,timeoutMs:1000}}};
 await writeFile(configPath,JSON.stringify(raw,null,2)+'\n');
 const state=path.resolve(path.dirname(configPath),raw.runtime.dataDir);await mkdir(state,{recursive:true});await writeFile(path.join(state,'manager-chat.json'),JSON.stringify({threadId:'gh74-manager'}));
 await launch();let form=await openSettings();assertPlan((await settings()).workerEnvironment.environment.executionPlan,original);
 await form.getByRole('button',{name:'Update',exact:true}).click();
 for(const label of ['Set up','Check readiness','Resume','Stop','Tear down'])assert.equal(await form.locator('section').filter({has:page.getByRole('heading',{name:label,exact:true})}).getByRole('checkbox',{name:'Configured'}).isChecked(),false);
 await form.getByRole('textbox',{name:'Start shell script',exact:true}).fill(edited);await form.getByRole('button',{name:'Save environment',exact:true}).click();await form.getByRole('button',{name:'Update',exact:true}).waitFor();
 const saved=JSON.parse(await readFile(configPath,'utf8'));assertPlan(saved.project.worker.environment.executionPlan,edited);assert.deepEqual(saved.runtime,raw.runtime);assert.deepEqual(saved.project.worker.environment.executionPlan.sources,[source]);
 assertPlan((await settings()).workerEnvironment.environment.executionPlan,edited);await page.screenshot({path:path.join(output,'native-null-phases-saved.png')});
 await page.reload();form=await openSettings();await form.getByRole('button',{name:'Update',exact:true}).click();assert.equal(await form.getByRole('textbox',{name:'Start shell script',exact:true}).inputValue(),edited);await form.getByRole('button',{name:'Cancel changes',exact:true}).click();
 assert.equal(await page.evaluate(()=>window.__gh74MediaCalls),0);await quit();await launch();form=await openSettings();assertPlan((await settings()).workerEnvironment.environment.executionPlan,edited);await form.getByRole('button',{name:'Update',exact:true}).click();assert.equal(await form.getByRole('textbox',{name:'Start shell script',exact:true}).inputValue(),edited);await page.screenshot({path:path.join(output,'native-null-phases-relaunched.png')});
 assert.equal(await page.evaluate(()=>window.__gh74MediaCalls),0);await quit();
 const calls=(await readFile(protocol,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);assert.equal(calls.some(m=>m.method==='thread/realtime/start'),false);assert.equal(calls.some(m=>['turn/start','turn/steer'].includes(m.method)&&!m.params.input?.[0]?.text?.startsWith('Crew preparation request:')),false);assert.deepEqual(errors,[]);
 Object.assign(proof,{pass:true,nullPhases,realBackend:true,realEnvironmentStore:true,openedSavedReloadedRelaunched:true,normalOwnedQuit:true,ordinaryModelTurns:0,rendererErrors:errors});
}catch(error){proof.error=error.message;await page?.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});throw error;}
finally{try{await quit();}finally{await writeFile(path.join(output,'proof.json'),JSON.stringify(proof,null,2)+'\n');console.log(JSON.stringify(proof));}}
