// GH78: compiled setup and actual native config persistence; synthetic tools, disposable profile only.
// CREW_ACCEPTANCE_EXECUTABLE=/absolute/Crew.app/Contents/MacOS/Crew node scripts/tracking-packaged-acceptance.mjs
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile, realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const {_electron}=await import(process.env.CREW_PLAYWRIGHT_MODULE||'playwright-core');
const executable=process.env.CREW_ACCEPTANCE_EXECUTABLE;
assert.ok(executable&&path.isAbsolute(executable)&&executable.includes('.app/Contents/MacOS/'),'Supply the packaged Crew executable explicitly.');
const bundled=path.resolve(path.dirname(executable),'../Resources/app/runtime');
const version=JSON.parse(await readFile(path.join(bundled,'package.json'),'utf8')).version;
if(process.env.CREW_ACCEPTANCE_EXPECTED_VERSION)assert.equal(version,process.env.CREW_ACCEPTANCE_EXPECTED_VERSION);
const output=await mkdtemp(path.join(tmpdir(),'crew-gh78-settings-')),configPath=path.join(output,'project','project.json'),binary=path.join(output,'synthetic-codex'),protocol=path.join(output,'protocol.jsonl');
const port=Number(process.env.CREW_ACCEPTANCE_PORT||59478),run=promisify(execFile),nullPhases=['setup','ready','resume','stop','teardown'];
const errors=[],proof={ticket:'GH78',output,executable,version,syntheticProvider:true,physicalMicrophoneCalls:0,explicitQuitReturns:[]};
let app,native,page;
console.log(JSON.stringify({event:'optional-tracking-fixture',output,executable,version}));
async function until(fn,label){const end=Date.now()+45000;while(Date.now()<end){if(await fn())return;await new Promise(resolve=>setTimeout(resolve,100));}throw Error('Timed out '+label);}
async function returnFromOwnedQuit(){
 if(page?.url().startsWith(`http://127.0.0.1:${port}/`)){
  const action=async value=>page.evaluate(async action=>{const response=await fetch('/api/updates',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action})});if(!response.ok)throw Error('Disposable Quit recovery request failed');return response.json();},value);
  const before=(await action('status')).workspacePlan;
  if(before?.purpose==='quit'&&before.phase==='canceled'){
   const registry=JSON.parse(await readFile(path.join(output,'native-profile','Crew','workspaces.json'),'utf8'));
   assert.equal(registry.projects.length,1);assert.equal(await realpath(registry.projects[0].configPath),await realpath(configPath));
   assert.deepEqual(before.projects.map(project=>project.id),[registry.projects[0].id],'Only the exact disposable project Quit hold may be released.');
   await action('return-to-work');const after=(await action('status')).workspacePlan;assert.equal(after.id,before.id);assert.equal(after.phase,'complete');
   proof.explicitQuitReturns.push({planId:before.id,purpose:before.purpose,beforePhase:before.phase,action:'return-to-work',afterPhase:after.phase});
  }
 }
}
async function quit(){
 if(!native||native.exitCode!==null||native.signalCode!==null)return;
 await returnFromOwnedQuit();
 await app.evaluate(({dialog,Menu})=>{dialog.showMessageBox=async()=>({response:1});Menu.getApplicationMenu().items[0].submenu.items.find(item=>item.label==='Quit Crew…').click();});
 await until(()=>native.exitCode!==null||native.signalCode!==null,'normal owned native Quit');
 await app.close().catch(()=>{});
}
async function launch(){
 const env={...process.env,CREW_APP_DATA:path.join(output,'native-profile'),AI_MANAGER_CONFIG:configPath,AI_MANAGER_CODEX_BINARY:binary};
 for(const key of ['ELECTRON_RUN_AS_NODE','AI_MANAGER_PORT','VOICE_PORT'])delete env[key];
 app=await _electron.launch({executablePath:executable,args:['--config',configPath],env,timeout:45000});native=app.process();
 app.context().on('page',newPage=>newPage.on('pageerror',error=>errors.push(error.message)));
 await app.context().addInitScript(()=>{window.__gh78MediaCalls=0;const media=navigator.mediaDevices;if(media)media.getUserMedia=async()=>{window.__gh78MediaCalls++;throw Error('GH78 physical capture prohibited');};});
 page=await app.firstWindow();page.on('pageerror',error=>errors.push(error.message));await page.waitForURL(`http://127.0.0.1:${port}/**`,{timeout:45000});
 // Reload under the capture guard before exercising Settings.
 await page.reload();await page.getByRole('button',{name:'Settings',exact:true}).waitFor();
 await returnFromOwnedQuit();
 // Clear the prior held Prepare notice only after the explicit owned Return.
 if(proof.explicitQuitReturns.length)await page.reload();
}
try{
 await writeFile(protocol,'');
 await writeFile(binary,`#!${process.execPath}
import{createInterface}from'node:readline';import{appendFileSync}from'node:fs';import{execFileSync}from'node:child_process';
if(process.argv.includes('--version')){console.log('codex-cli synthetic GH78');process.exit(0);}
const binding=process.argv.find(x=>x.startsWith('mcp_servers.local_orchestration.args='));const bound=binding?JSON.parse(binding.slice(binding.indexOf('=')+1)):[];let thread='gh78-manager',sequence=0;const send=x=>console.log(JSON.stringify(x));
function call(name,args){const output=execFileSync(process.execPath,bound,{encoding:'utf8',input:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})+'\\n'});const value=JSON.parse(output.trim());if(value.error||value.result.isError)throw Error(value.error?.message||value.result.content[0].text);return JSON.parse(value.result.content[0].text);}
for await(const line of createInterface({input:process.stdin})){const m=JSON.parse(line);appendFileSync(${JSON.stringify(protocol)},line+'\\n');if(m.id===undefined)continue;let result={};
if(m.method==='account/read')result={account:{type:'chatgpt',planType:'synthetic'}};if(m.method==='config/read')result={config:{}};
if(m.method==='thread/start'||m.method==='thread/resume'){thread=m.params.threadId||thread;result={thread:{id:thread}};}
if(['thread/timeline/list','thread/turns/list'].includes(m.method))result={data:[],nextCursor:null};
if(m.method==='mcpServerStatus/list')result={data:[{name:'github',tools:{list_repositories:{inputSchema:{properties:{page_size:{type:'integer'}},required:[]}},get_repo:{inputSchema:{properties:{repository_full_name:{type:'string'}},required:[]}}}},{name:'linear',tools:{list_teams:{inputSchema:{properties:{},required:[]}},list_projects:{inputSchema:{properties:{},required:[]}}}}],nextCursor:null};
if(m.method==='mcpServer/tool/call'){const tool=m.params.tool;if(tool==='list_repositories')result={structuredContent:{repositories:[{repository_full_name:'MattGibney/Crew'}]}};else if(tool==='get_repo')result={structuredContent:{repository_full_name:m.params.arguments.repository_full_name}};else if(tool==='list_teams')result={structuredContent:{teams:[{id:'synthetic-team',name:'Fixture team',key:'FIX'}]}};else if(tool==='list_projects')result={structuredContent:{projects:[]}};else throw Error('Unexpected fixture tool '+tool);}

if(m.method==='thread/realtime/listVoices')result={voices:{v3:['cove'],defaultV1:'cove'}};
if(m.method==='thread/realtime/start')throw Error('GH78 voice prohibited');
const turn='gh78-preparation-'+(++sequence);if(m.method==='turn/start')result={turn:{id:turn,status:'inProgress'}};if(m.method==='turn/steer')result={turnId:m.params.expectedTurnId};send({id:m.id,result});
if(['turn/start','turn/steer'].includes(m.method)){
 if(!m.params.input?.[0]?.text?.startsWith('Crew preparation request:'))throw Error('GH78 ordinary model work prohibited');
 const preparation=call('get_preparation_request',{});if(!preparation)throw Error('Missing bound preparation request');call('report_preparation',{preparationId:preparation.preparationId,participantId:preparation.participantId,requestId:preparation.requestId,responseId:'gh78-ready-'+preparation.requestId,state:'ready',note:'Only disposable Settings changed; context saved.',continuation:'Retain the GH78 fixture settings.'});
 const finalTurn=m.method==='turn/steer'?m.params.expectedTurnId:turn;send({method:'item/completed',params:{threadId:thread,turnId:finalTurn,item:{id:'gh78-final',type:'agentMessage',text:'Settings fixture ready for normal Quit.'}}});send({method:'turn/completed',params:{threadId:thread,turn:{id:finalTurn,status:'completed'}}});
}}
`,{mode:0o700});
 await run(process.execPath,[path.join(bundled,'cli.mjs'),'init','--template','fixture','--config',configPath]);
 const repository=path.join(output,'repository');await mkdir(repository);
 await run('git',['init','-b','main',repository]);await writeFile(path.join(repository,'AGENTS.md'),'GH78 disposable settings fixture. No project commands authorized.\n');
 await run('git',['-C',repository,'add','AGENTS.md']);await run('git',['-C',repository,'-c','user.name=GH78 Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','commit','-m','Initialize disposable settings fixture']);
 const raw=JSON.parse(await readFile(configPath,'utf8'));raw.runtime.port=port;raw.runtime.codexBinary=binary;raw.project.name='GH78 null phases';raw.project.mode='repository';raw.project.repositories=[{id:'gh78-fixture',name:'GH78 disposable fixture',path:repository,baseRef:'main',components:[]}];raw.project.linear={teamId:'gh78-synthetic-team',teamKey:'FIX',projectId:null};

 raw.project.tracking={providers:[],preferred:'none',githubRepository:null};
 raw.project.linear={teamId:null,teamKey:null,projectId:null};
 await writeFile(configPath,JSON.stringify(raw,null,2)+'\n');
 const state=path.resolve(path.dirname(configPath),raw.runtime.dataDir);await mkdir(state,{recursive:true});await writeFile(path.join(state,'manager-chat.json'),JSON.stringify({threadId:'gh78-manager'}));
 async function openTracking(){
  const previous=new Set(app.windows());
  await app.evaluate(({Menu})=>Menu.getApplicationMenu().items[0].submenu.items.find(item=>item.label==='Project setup…').click());
  let setup;await until(()=>{setup=app.windows().find(value=>!previous.has(value));return setup;},'setup window');
  await setup.waitForURL('**/setup.html');await setup.locator('#steps button').filter({hasText:'Project'}).click();
  await setup.getByRole('region',{name:'External tracking',exact:true}).waitFor();return setup;
 }
 async function settled(setup){await setup.locator('#reload-all').waitFor();await until(()=>setup.locator('#reload-all').isEnabled(),'saved setup');const alerts=await setup.getByRole('alert').allTextContents();assert.deepEqual(alerts,[]);}
 async function saved(){return JSON.parse(await readFile(configPath,'utf8'));}
 await launch();let setup=await openTracking();
 assert.equal(await setup.getByRole('checkbox',{name:'Linear',exact:true}).isChecked(),false);assert.equal(await setup.getByRole('checkbox',{name:'GitHub',exact:true}).isChecked(),false);
 assert.match(await setup.getByRole('region',{name:'External tracking',exact:true}).innerText(),/No external issue or account is required/);
 await setup.screenshot({path:path.join(output,'none.png')});
 await setup.getByRole('checkbox',{name:'Linear',exact:true}).check();
 assert.equal(await setup.getByRole('checkbox',{name:'GitHub',exact:true}).isDisabled(),true,'Native save disables competing provider changes');
 await settled(setup);
 await setup.getByRole('button',{name:'Find my Linear teams',exact:true}).click();await settled(setup);
 await setup.locator('#linear-team-choice').selectOption('synthetic-team');await settled(setup);
 assert.equal((await saved()).project.linear.teamId,'synthetic-team');
 await setup.screenshot({path:path.join(output,'linear.png')});
 await setup.getByRole('checkbox',{name:'GitHub',exact:true}).check();await settled(setup);
 await setup.getByRole('button',{name:'Find GitHub repositories',exact:true}).click();await settled(setup);
 await setup.locator('#github-repository').selectOption('MattGibney/Crew');await settled(setup);
 await setup.locator('#preferred-tracker').selectOption('github');await settled(setup);
 assert.deepEqual((await saved()).project.tracking,{providers:['linear','github'],preferred:'github',githubRepository:'MattGibney/Crew'});
 await setup.screenshot({path:path.join(output,'both.png')});
 await setup.getByRole('checkbox',{name:'Linear',exact:true}).uncheck();await settled(setup);
 assert.equal((await saved()).project.linear.teamId,'synthetic-team','Disabling provider retains mapping');
 await setup.screenshot({path:path.join(output,'github.png')});
 await setup.locator('#github-repository-query').fill('MattGibney/Crew');await setup.getByRole('button',{name:'Verify repository',exact:true}).click();await settled(setup);
 await setup.getByRole('button',{name:'Reload setup',exact:true}).click();await settled(setup);
 assert.equal(await setup.locator('#preferred-tracker').inputValue(),'github');
 assert.equal(await setup.locator('#github-repository').inputValue(),'MattGibney/Crew');
 const stored=await saved();await setup.close();await quit();await launch();setup=await openTracking();
 assert.equal(await setup.locator('#preferred-tracker').inputValue(),'github');assert.equal(await setup.locator('#github-repository').inputValue(),'MattGibney/Crew');
 assert.deepEqual((await saved()).project.tracking,stored.project.tracking);await setup.screenshot({path:path.join(output,'relaunch.png')});
 await setup.getByRole('button',{name:'No external tracker',exact:true}).click();await settled(setup);assert.deepEqual((await saved()).project.tracking,{providers:[],preferred:'none',githubRepository:'MattGibney/Crew'});
 assert.equal((await saved()).project.linear.teamId,'synthetic-team');await setup.close();assert.equal(await page.evaluate(()=>window.__gh78MediaCalls),0);await quit();
 const calls=(await readFile(protocol,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);assert.equal(calls.some(m=>m.method==='thread/realtime/start'),false);assert.deepEqual(errors,[]);
 const toolCalls=calls.filter(m=>m.method==='mcpServer/tool/call').map(m=>m.params.tool);assert.deepEqual([...new Set(toolCalls)].sort(),['get_repo','list_projects','list_repositories','list_teams']);
 Object.assign(proof,{pass:true,choices:['none','linear','github','both'],syntheticConnectedTools:toolCalls,realConfigStore:true,savedReloadedRelaunched:true,normalOwnedQuit:true,rendererErrors:errors});
}catch(error){proof.error=error.message;await page?.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});throw error;}
finally{try{await quit();}finally{await writeFile(path.join(output,'proof.json'),JSON.stringify(proof,null,2)+'\n');console.log(JSON.stringify(proof));}}
