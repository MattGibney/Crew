// GH78 review: genuine compiled setup with controlled asynchronous bridge saves.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';import {once} from 'node:events';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';
const {chromium}=await import(process.env.CREW_PLAYWRIGHT_MODULE||'playwright-core');
const output=await mkdtemp(path.join(tmpdir(),'crew-gh78-async-')),port=Number(process.env.CREW_ACCEPTANCE_PORT||59481),origin=`http://127.0.0.1:${port}`;
let browser;const errors=[];
const fixture=spawn(process.execPath,['tests/browser-fixture.mjs',String(port),path.resolve('runtime/renderer-dist')],{stdio:['ignore','pipe','pipe']});
try{
 await new Promise((resolve,reject)=>{fixture.stdout.once('data',resolve);fixture.once('error',reject);fixture.once('exit',code=>reject(Error('Fixture exited '+code)));});
 browser=await chromium.launch({headless:true,...(process.env.CREW_BROWSER_EXECUTABLE?{executablePath:process.env.CREW_BROWSER_EXECUTABLE}:{})});const context=await browser.newContext({viewport:{width:1200,height:950}});
 const preload=await readFile('tests/fixtures/browser-setup.js','utf8');
 await context.route('**/__setup.js',route=>route.fulfill({contentType:'text/javascript',body:preload+`\nstate.config.project.tracking={providers:['github'],preferred:'github',githubRepository:null};
const saveNow=window.crewSetup.save;window.__asyncSetup={pending:false,release:null};window.crewSetup.save=async input=>{window.__asyncSetup.pending=true;await new Promise(resolve=>window.__asyncSetup.release=resolve);window.__asyncSetup.pending=false;return saveNow(input);};
window.crewSetup.githubOptions=async()=>{await new Promise(resolve=>window.__asyncSetup.release=resolve);state.githubOptions={status:'verified',repositories:[],detail:'Synthetic bounded discovery',truncated:false};return reply();};
navigator.mediaDevices.getUserMedia=async()=>{throw Error('Physical media prohibited');};` }));
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(origin+'/setup.html');await page.locator('#steps button').filter({hasText:'Project'}).click();
 const linear=page.getByRole('checkbox',{name:'Linear',exact:true}),github=page.getByRole('checkbox',{name:'GitHub',exact:true}),query=page.getByRole('textbox',{name:'Find a specific repository',exact:true});
 await query.fill('owner/retained-query');await linear.check();await page.waitForFunction(()=>window.__asyncSetup.pending);
 const box=await github.boundingBox();assert.ok(box);
 if(process.env.GH78_EXPECT_BUG==='1'){
  await page.mouse.click(box.x+box.width/2,box.y+box.height/2);assert.equal(await github.isChecked(),false,'Click changed the unsaved draft');await page.evaluate(()=>window.__asyncSetup.release());await page.locator('#reload-all').waitFor();await page.waitForFunction(()=>!window.__asyncSetup.pending&&window.__crewProof.calls.length===1);await page.waitForTimeout(100);
  assert.equal(await github.isChecked(),true,'The second click was overwritten by first save');console.log(JSON.stringify({output,reproduced:'provider click was silently lost while save pending'}));
 }else{
  assert.equal(await github.isDisabled(),true);assert.equal(await linear.isDisabled(),true);assert.equal(await query.isDisabled(),true);assert.equal(await query.inputValue(),'owner/retained-query');
  await page.mouse.click(box.x+box.width/2,box.y+box.height/2);assert.equal(await github.isChecked(),true,'Busy controls do not accept an unsavable change');await page.evaluate(()=>window.__asyncSetup.release());await github.waitFor();await page.waitForFunction(()=>!document.querySelector('#reload-all').disabled);
  assert.deepEqual(await page.evaluate(()=>window.__crewProof.state.config.project.tracking.providers),['github','linear']);assert.equal(await query.inputValue(),'owner/retained-query');
  // A deliberate second action after confirmation persists, rather than using the first action's stale provider closure.
  await github.uncheck();await page.waitForFunction(()=>window.__asyncSetup.pending);await page.evaluate(()=>window.__asyncSetup.release());await page.waitForFunction(()=>!document.querySelector('#reload-all').disabled);assert.deepEqual(await page.evaluate(()=>window.__crewProof.state.config.project.tracking.providers),['linear']);
  await github.check();await page.waitForFunction(()=>window.__asyncSetup.pending);await page.evaluate(()=>window.__asyncSetup.release());await page.waitForFunction(()=>!document.querySelector('#reload-all').disabled);assert.equal(await query.inputValue(),'owner/retained-query');assert.deepEqual(await page.evaluate(()=>window.__crewProof.state.config.project.tracking.providers),['linear','github']);
  await page.getByRole('button',{name:'Find GitHub repositories',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#reload-all').disabled);assert.equal(await query.isDisabled(),true);assert.equal(await query.inputValue(),'owner/retained-query');await page.evaluate(()=>window.__asyncSetup.release());await page.waitForFunction(()=>!document.querySelector('#reload-all').disabled);assert.equal(await query.inputValue(),'owner/retained-query');
  await page.screenshot({path:path.join(output,'async-confirmed.png')});assert.deepEqual(errors,[]);const proof={pass:true,output,delayedSaves:3,providerIntentPreserved:true,queryPreserved:true,errors};await writeFile(path.join(output,'proof.json'),JSON.stringify(proof,null,2));console.log(JSON.stringify(proof));
 }
}finally{await browser?.close();if(fixture.exitCode===null){fixture.kill('SIGTERM');await once(fixture,'exit');}}
