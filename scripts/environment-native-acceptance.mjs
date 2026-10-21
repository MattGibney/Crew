// GH45: isolated native Electron persistence; synthetic provider, no physical media.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const run=promisify(execFile),root=process.cwd(),output=await mkdtemp(path.join(tmpdir(),'crew-environment-native-'));
const {_electron}=await import(process.env.CREW_PLAYWRIGHT_MODULE || 'playwright-core');
const configPath=path.join(output,'project','config.json'),binary=path.join(output,'synthetic-codex.mjs'),calls=path.join(output,'calls.jsonl');
await writeFile(calls,'');
await writeFile(binary,`#!${process.execPath}\nimport {createInterface} from 'node:readline';import {appendFileSync} from 'node:fs';\nif(process.argv.includes('--version')){console.log('codex-cli synthetic');process.exit(0);}\nfor await(const line of createInterface({input:process.stdin})){const m=JSON.parse(line);appendFileSync(${JSON.stringify(calls)},line+'\\n');if(m.id===undefined)continue;let result={};if(m.method==='account/read')result={account:{type:'chatgpt',planType:'synthetic'}};if(m.method==='config/read')result={config:{}};if(m.method==='thread/start'||m.method==='thread/resume')result={thread:{id:'synthetic-manager'}};if(m.method==='thread/timeline/list'||m.method==='thread/turns/list'||m.method==='mcpServerStatus/list')result={data:[],nextCursor:null};console.log(JSON.stringify({id:m.id,result}));}\n`,{mode:0o700});
await run(process.execPath,[path.join(root,'cli.mjs'),'init','--template','fixture','--config',configPath]);
const raw=JSON.parse(await readFile(configPath,'utf8'));raw.runtime.codexBinary=binary;raw.runtime.port=59453;raw.project.name='Environment acceptance';await writeFile(configPath,JSON.stringify(raw,null,2)+'\n');
await mkdir(path.join(output,'project','.data'),{recursive:true});await writeFile(path.join(output,'project','.data','manager-chat.json'),JSON.stringify({threadId:'synthetic-manager'}));
const env={...process.env,CREW_APP_DATA:path.join(output,'native-profile'),AI_MANAGER_CONFIG:configPath,AI_MANAGER_CODEX_BINARY:binary};delete env.ELECTRON_RUN_AS_NODE;
let app;
async function launch(){app=await _electron.launch({executablePath:process.env.CREW_ACCEPTANCE_EXECUTABLE || path.join(root,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),args:[root],env,timeout:30000});const page=await app.firstWindow();await page.waitForURL('http://127.0.0.1:59453/**',{timeout:30000});await page.addInitScript(()=>{navigator.mediaDevices.getUserMedia=async()=>{throw Error('Physical capture forbidden during acceptance');};});await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('button',{name:'Worker environment',exact:true}).click();return page;}
async function quit(){if(!app)return;await app.evaluate(({dialog,Menu})=>{dialog.showMessageBox=async()=>({response:1});Menu.getApplicationMenu().items[0].submenu.items.find(item=>item.label==='Quit Crew…').click();});const native=app.process();if(native.exitCode===null)await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Native Quit did not finish')),15000);native.once('exit',()=>{clearTimeout(timer);resolve();});});await app.close().catch(()=>{});app=null;}
try{
 let page=await launch();const form=page.getByRole('form',{name:'Worker environment configuration'});await form.getByRole('button',{name:'Update',exact:true}).click();
 const section=form.locator('section').filter({has:page.getByRole('heading',{name:'Start',exact:true})});await section.getByRole('checkbox',{name:'Configured'}).check();await section.getByRole('textbox',{name:'Start executable',exact:true}).fill('/never execute/fixture');await section.getByRole('button',{name:'Add argument',exact:true}).click();await section.getByRole('textbox',{name:'Start argument 1',exact:true}).fill('native exact "argument"');await form.getByRole('button',{name:'Save environment',exact:true}).click();await form.getByRole('button',{name:'Update',exact:true}).waitFor();await page.screenshot({path:path.join(output,'native-saved.png')});
 const saved=JSON.parse(await readFile(configPath,'utf8'));assert.deepEqual(saved.project.worker.environment.start.args,['native exact "argument"']);assert.deepEqual(saved.runtime,raw.runtime);await quit();
 page=await launch();await page.getByRole('form',{name:'Worker environment configuration'}).getByText('/never execute/fixture',{exact:true}).waitFor();await page.screenshot({path:path.join(output,'native-restarted.png')});const protocol=(await readFile(calls,'utf8')).split('\n').filter(Boolean).map(JSON.parse);assert.equal(protocol.some(m=>['turn/start','thread/realtime/start'].includes(m.method)),false);console.log(JSON.stringify({output,passed:'native save + quit + relaunch persistence; no task/voice turn'}));
}finally{await quit();}
