// #63/#64: actual compiled UI and production schedule/provenance modules.
// Disposable synthetic native events only; no model account or physical audio.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
const {chromium}=await import(process.env.CREW_PLAYWRIGHT_MODULE || 'playwright-core');
const port=Number(process.env.CREW_ACCEPTANCE_PORT||4366),origin=`http://127.0.0.1:${port}`;
const output=await mkdtemp(path.join(tmpdir(),'crew-schedules-browser-'));
const fixture=spawn(process.execPath,['tests/browser-fixture.mjs',String(port)],{stdio:['ignore','pipe','pipe']});
let browser;
try{
 await new Promise((resolve,reject)=>{fixture.stdout.once('data',resolve);fixture.once('error',reject);fixture.once('exit',code=>reject(Error(`Fixture exited ${code}`)));});
 browser=await chromium.launch({headless:true,...(process.env.CREW_BROWSER_EXECUTABLE?{executablePath:process.env.CREW_BROWSER_EXECUTABLE}:{})});
 const context=await browser.newContext({viewport:{width:1400,height:1000}}),page=await context.newPage(),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 const post=async body=>{const res=await context.request.post(`${origin}/__control`,{data:body});assert.equal(res.status(),200);};
 await page.goto(origin);
 await page.getByRole('tab',{name:'Text',exact:true}).click();
 const input=page.getByRole('textbox',{name:'Message your manager',exact:true});await input.fill('Preserve this draft.');
 await post({beginActivity:{requestId:'internal-1',origin:{source:'scheduled-review',operationId:'schedule'}}});
 const native=async(type,id,text)=>post({protocol:{method:'item/completed',params:{turnId:'internal-turn',item:type==='userMessage'?{type,id,content:[{type:'text',text}]}:{type,id,text}}}});
 await native('userMessage','private-input','Check my workers.');await native('agentMessage','private-response','Checking internal records.');await post({acknowledgeActivity:'internal-turn'});
 const rows=()=>page.locator('article[data-message-id]');assert.equal(await rows().count(),0);
 await post({restoreActivity:true,dropEvents:true});await page.reload();await page.getByRole('tab',{name:'Text',exact:true}).click();
 assert.equal(await rows().count(),0);assert.equal(await input.inputValue(),'Preserve this draft.');
 await post({protocol:{method:'item/completed',params:{turnId:'human-turn',item:{type:'userMessage',id:'actual-human',content:[{type:'text',text:'Check my workers.'}]}}}});
 await page.locator('article[data-message-id="actual-human"]').waitFor();
 await post({protocol:{method:'thread/realtime/item/completed',params:{item:{type:'transcriptSegment',id:'voice-user',role:'user',text:'A real spoken request.'}}}});
 await page.locator('article[data-message-id="voice-user"]').waitFor();
 const attention={requestId:'human-question',message:'Please choose the account to check.'};
 await post({protocol:{method:'item/completed',params:{turnId:'internal-turn',item:{id:'meaningful-attention',type:'mcpToolCall',server:'local_orchestration',tool:'request_attention',status:'completed',arguments:attention,result:{structuredContent:{ok:true,attention}}}}}});
 await page.getByText('Please choose the account to check.',{exact:true}).waitFor();
 assert.equal(await page.locator('article[data-message-id="private-input"]').count(),0);
 assert.equal(await page.locator('article[data-message-id="private-response"]').count(),0);
 await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('button',{name:'Manager schedules',exact:true}).click();
 const view=page.getByLabel('Manager schedule settings',{exact:true});await view.getByText('Review commitments',{exact:true}).waitFor();
 await view.getByRole('button',{name:'Add schedule',exact:true}).click();
 await view.getByLabel('Name',{exact:true}).fill('Check email');await view.getByLabel('Instruction',{exact:true}).fill('Check my connected mail account for replies to the agreed thread.');
 await view.getByLabel('Enabled',{exact:true}).check();await view.getByLabel('Interval in minutes',{exact:true}).fill('30');
 // Draft survives navigation and asynchronous Settings refresh.
 await page.getByRole('button',{name:'Sessions',exact:true}).click();await page.getByRole('button',{name:'Manager schedules',exact:true}).click();assert.equal(await view.getByLabel('Name',{exact:true}).inputValue(),'Check email');
 await view.getByRole('button',{name:'Save schedules',exact:true}).click();await page.getByRole('status').filter({hasText:'Manager schedules saved.'}).waitFor();
 await view.getByRole('button',{name:'Add schedule',exact:true}).click();await view.getByLabel('Name',{exact:true}).fill('Daily check');await view.getByLabel('Instruction',{exact:true}).fill('Review the saved daily agenda.');await view.getByLabel('Daily',{exact:true}).check();await view.getByLabel('Local time',{exact:true}).fill('09:15');await view.getByLabel('Time zone',{exact:true}).fill('Europe/London');await view.getByRole('button',{name:'Save schedules',exact:true}).click();
 await page.waitForFunction(()=>[...document.querySelectorAll('button')].find(button=>button.textContent==='Save schedules')?.disabled);
 await page.screenshot({path:path.join(output,'schedules-desktop.png'),fullPage:true});
 await page.reload();await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('button',{name:'Manager schedules',exact:true}).click();await view.getByText('Check email',{exact:true}).waitFor();await view.getByText(/Daily at 09:15 \(Europe\/London\)/).waitFor();
 await page.setViewportSize({width:540,height:850});assert.ok(await view.evaluate(el=>el.scrollWidth<=el.clientWidth+1));await page.screenshot({path:path.join(output,'schedules-narrow.png'),fullPage:true});
 const proof=await(await context.request.get(`${origin}/__proof`)).json();assert.equal(proof.calls.filter(c=>['work','connect'].includes(c.name)).length,0);assert.deepEqual(errors,[]);
 console.log(JSON.stringify({passed:true,output,checks:['background live/restored hidden','same-text human and voice visible','draft retained','attention reachable','interval/daily save/reload','narrow layout','no model or microphone']},null,2));
}finally{await browser?.close();if(fixture.exitCode===null){fixture.kill('SIGTERM');await once(fixture,'exit');}}
