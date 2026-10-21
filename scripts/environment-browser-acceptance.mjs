// GH45: actual compiled React UI, synthetic backend only; no media or project commands.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
const {chromium}=await import(process.env.CREW_PLAYWRIGHT_MODULE || 'playwright-core');
const port=Number(process.env.CREW_ACCEPTANCE_PORT || 4355),origin=`http://127.0.0.1:${port}`;
const output=await mkdtemp(path.join(tmpdir(),'crew-environment-ui-'));
let browser;
const child=spawn(process.execPath,['tests/browser-fixture.mjs',String(port)],{stdio:['ignore','pipe','pipe']});
async function cleanup(){await browser?.close();if(child.exitCode===null){child.kill('SIGTERM');await once(child,'exit');}}
try{
 await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);child.once('exit',code=>reject(Error(`fixture exit ${code}`)));});
 browser=await chromium.launch({headless:true,...(process.env.CREW_BROWSER_EXECUTABLE?{executablePath:process.env.CREW_BROWSER_EXECUTABLE}:{})});
 const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),errors=[];
 page.on('pageerror',error=>errors.push(String(error)));
 await page.goto(origin);await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('button',{name:'Worker environment',exact:true}).click();
 const form=page.getByRole('form',{name:'Worker environment configuration'});
 await form.getByRole('button',{name:'Update',exact:true}).click();
 for(const label of ['Set up','Start','Check readiness','Resume','Clean up']){
  const section=form.locator('section').filter({has:page.getByRole('heading',{name:label,exact:true})});
  await section.getByRole('checkbox',{name:'Configured'}).check();
  await section.getByRole('textbox',{name:`${label} executable`,exact:true}).fill('/exact path/tool');
  await section.getByRole('button',{name:'Add argument',exact:true}).click();
  await section.getByRole('textbox',{name:`${label} argument 1`,exact:true}).fill('one argument "quoted"\nnext line');
  await section.getByRole('button',{name:'Add argument',exact:true}).click();
  await section.getByRole('spinbutton').fill('12345');
 }
 await page.getByRole('button',{name:'Worker profile',exact:true}).click();await page.getByRole('button',{name:'Worker environment',exact:true}).click();
 assert.equal(await form.getByRole('textbox',{name:'Start executable',exact:true}).inputValue(),'/exact path/tool');
 await form.getByRole('button',{name:'Save environment',exact:true}).click();await form.getByRole('button',{name:'Update',exact:true}).waitFor();
 const result=await (await context.request.get(origin+'/api/settings')).json();
 for(const phase of ['bootstrap','start','ready','resume','cleanup']){assert.equal(result.workerEnvironment.environment[phase].command,'/exact path/tool');assert.deepEqual(result.workerEnvironment.environment[phase].args,['one argument "quoted"\nnext line','']);assert.equal(result.workerEnvironment.environment[phase].timeoutMs,12345);}
 await page.screenshot({path:path.join(output,'direct-commands.png'),fullPage:true});
 await form.getByRole('button',{name:'Update',exact:true}).click();await form.getByRole('textbox',{name:'Start executable',exact:true}).fill('discard');await form.getByRole('button',{name:'Cancel changes',exact:true}).click();
 await page.reload();await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('button',{name:'Worker environment',exact:true}).click();await form.getByRole('button',{name:'Update',exact:true}).click();
 assert.equal(await form.getByRole('textbox',{name:'Start executable',exact:true}).inputValue(),'/exact path/tool');
 await form.getByRole('spinbutton',{name:'Start timeout (milliseconds)',exact:true}).fill('999');await form.getByRole('button',{name:'Save environment',exact:true}).click();assert.equal(await form.getByRole('spinbutton',{name:'Start timeout (milliseconds)',exact:true}).evaluate(el=>el.validity.rangeUnderflow),true);
 await form.getByRole('button',{name:'Cancel changes',exact:true}).click();
 const source={path:'.codex/environments/environment.toml',sha256:'a'.repeat(64)};
 const plan={schemaVersion:1,sources:[source],env:{PATH:'/exact/tools:/usr/bin'},networkAccess:false};
 for(const phase of ['setup','start','resume','ready','stop','teardown'])plan[phase]={command:`echo '${phase} script'`,source,timeoutMs:600000};
 await context.request.post(origin+'/__control',{data:{workerEnvironment:{executionPlan:plan}}});await page.reload();await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('button',{name:'Worker environment',exact:true}).click();await form.getByRole('button',{name:'Update',exact:true}).click();
 for(const label of ['Set up','Start','Resume','Check readiness','Stop','Tear down']){await form.getByRole('textbox',{name:`${label} shell script`,exact:true}).fill(`printf '%s\\n' '${label}'\n# exact multiline`);await form.getByRole('spinbutton',{name:`${label} timeout (milliseconds)`,exact:true}).fill('45678');}
 await page.getByRole('region',{name:'Settings',exact:true}).evaluate(el=>el.scrollTop=0);
 await page.screenshot({path:path.join(output,'project-plan-editor.png'),fullPage:true});
 await form.getByRole('button',{name:'Save environment',exact:true}).click();await form.getByRole('button',{name:'Update',exact:true}).waitFor();
 const saved=await (await context.request.get(origin+'/api/settings')).json();assert.deepEqual(saved.workerEnvironment.environment.executionPlan.sources,[source]);assert.equal(saved.workerEnvironment.environment.executionPlan.stop.timeoutMs,45678);
 await form.getByRole('button',{name:'Update',exact:true}).click();
 await form.getByRole('textbox',{name:'Stop shell script',exact:true}).fill('unsaved stale draft');
 await context.request.post(origin+'/__control',{data:{workerEnvironment:saved.workerEnvironment.environment}});
 await form.getByRole('button',{name:'Save environment',exact:true}).click();
 await form.getByRole('alert').getByText(/changed elsewhere/).waitFor();
 assert.equal(await form.getByRole('textbox',{name:'Stop shell script',exact:true}).inputValue(),'unsaved stale draft');
 await form.getByRole('button',{name:'Reload saved settings',exact:true}).click();
 await form.getByText(/Configuration changed while/).waitFor();
 assert.equal(await form.getByRole('textbox',{name:'Stop shell script',exact:true}).inputValue(),'unsaved stale draft');
 await form.getByRole('button',{name:'Cancel changes',exact:true}).click();
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(output,'mobile.png'),fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 const proof=await (await context.request.get(origin+'/__proof')).json();assert.equal(proof.calls.some(c=>['connect','work','manager/lifecycle'].includes(c.name)),false);assert.equal(await page.evaluate(()=>window.__crewMedia?.calls || 0),0);assert.deepEqual(errors,[]);
 console.log(JSON.stringify({output,passed:'all direct hooks + project phases, argv, timeout, draft navigation, cancel, reload, invalid, mobile, no command/media activity'}));
}finally{await cleanup();}
