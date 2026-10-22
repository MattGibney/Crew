// GH78: actual compiled worker cards/details and persisted legacy/canonical records.
import assert from 'node:assert/strict';import {spawn} from 'node:child_process';import {once} from 'node:events';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';
import {createTask} from '../runtime/orchestration/store.mjs';import {readWorkerDetail} from '../runtime/workers/detail.mjs';
const {chromium}=await import(process.env.CREW_PLAYWRIGHT_MODULE||'playwright-core');
const output=await mkdtemp(path.join(tmpdir(),'crew-gh78-references-')),port=Number(process.env.CREW_ACCEPTANCE_PORT||59479),origin=`http://127.0.0.1:${port}`,id='crew-issue78-implementation-20261022',errors=[];
let browser,detail;const fixture=spawn(process.execPath,['tests/browser-fixture.mjs',String(port),path.resolve('runtime/renderer-dist')],{stdio:['ignore','pipe','pipe']});
const gh=(repository,number=78)=>({provider:'github',repository,number,url:`https://github.com/${repository}/issues/${number}`});
const longRepo='a'.repeat(39)+'/'+'r'.repeat(100);
try{
 await new Promise((resolve,reject)=>{fixture.stdout.once('data',resolve);fixture.once('error',reject);fixture.once('exit',code=>reject(Error('Fixture exited '+code)));});
 browser=await chromium.launch({headless:true,...(process.env.CREW_BROWSER_EXECUTABLE?{executablePath:process.env.CREW_BROWSER_EXECUTABLE}:{})});const context=await browser.newContext({viewport:{width:1400,height:950}}),page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
 await context.route('**/api/workers/*',route=>route.fulfill({json:detail}));await page.goto(origin);const orchestration=(await(await context.request.get(origin+'/__state')).json()).orchestration;
 const cases=[
  {name:'retained-78-url',ticket:gh('MattGibney/Crew').url,legacy:true,label:'#78',repository:'MattGibney/Crew'},
  {name:'canonical-78',workLink:gh('MattGibney/Crew'),label:'#78',repository:'MattGibney/Crew'},
  {name:'other-repository-78',workLink:gh('other/repository'),label:'#78',repository:'other/repository'},
  {name:'long-repository',ticket:gh(longRepo).url,legacy:true,label:'#78',repository:longRepo},
  {name:'linear-label',ticket:'TEAM-78',legacy:true,label:'TEAM-78'},
  {name:'linear-url',ticket:'https://linear.app/example/issue/TEAM-78/title',legacy:true,label:'TEAM-78'},
  {name:'local',label:id},
  {name:'explicit-local-url',ticket:gh('MattGibney/Crew').url,workLink:null,label:id},
  {name:'arbitrary-label',ticket:'Investigate repo#78',label:'Investigate repo#78'},
 ];
 const proof=[];
 for(const item of cases){
  const dir=path.join(output,item.name),task=await createTask(dir,{requestId:id,brief:'Agreed '+item.name+' assignment',ticket:item.ticket,workLink:item.workLink});const file=path.join(dir,'tasks',id+'.json'),md=path.join(dir,'tasks',id+'.md');
  if(item.legacy){delete task.workLink;await writeFile(file,JSON.stringify(task));}
  const original=await readFile(file,'utf8'),markdown=await readFile(md,'utf8');detail=await readWorkerDetail(dir,id,null);orchestration.tasks=[task];await context.request.post(origin+'/__control',{data:{orchestration}});
  for(const width of [1400,390]){
   await page.setViewportSize({width,height:950});await page.reload();if(width===390)await page.getByRole('button',{name:/Workers/}).first().click();else {await page.getByRole('button',{name:'Conversation',exact:true}).click();await page.getByRole('separator',{name:'Resize worker panel'}).press('Home');}
   const card=page.locator(`[data-worker-id="${id}"]`),reference=card.locator('[data-worker-reference]');await reference.getByText(item.label,{exact:true}).waitFor();
   if(item.repository){assert.match(await card.getByRole('button').getAttribute('aria-label'),new RegExp(item.repository.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));assert.equal(await reference.getAttribute('title'),`GitHub issue ${item.repository}#78`);
    const number=reference.getByText('#78',{exact:true});const bounds=await number.boundingBox(),parent=await reference.boundingBox();assert.ok(bounds&&parent);assert.ok(bounds.x>=parent.x&&bounds.x+bounds.width<=parent.x+parent.width+1,'Issue number remains inside reference');assert.ok(await number.evaluate(el=>el.scrollWidth<=el.clientWidth),'Issue number is not truncated');
    const title=card.locator('h3');assert.ok(bounds.y<(await title.boundingBox()).y,'Reference is above task title');assert.ok(bounds.x<(await card.boundingBox()).x+50,'Reference is top-left');
   }else assert.ok(!(await card.getByRole('button').getAttribute('aria-label')).includes('GitHub issue'));
   await page.screenshot({path:path.join(output,item.name+'-'+width+'-card.png')});await card.click();await page.getByRole('tab',{name:'Overview',exact:true}).click();await page.getByRole('region',{name:'Worker detail'}).locator('[data-worker-reference]').first().getByText(item.label,{exact:true}).waitFor();
   if(item.repository)assert.equal(await page.getByRole('link',{name:new RegExp('GitHub issue:')}).getAttribute('href'),`https://github.com/${item.repository}/issues/78`);
   if(item.name==='explicit-local-url'||item.name==='local')await page.getByText('Local task · No external tracker',{exact:true}).waitFor();
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'No page overflow');await page.getByRole('button',{name:'Back to manager',exact:true}).click();
  }
  assert.equal(await readFile(file,'utf8'),original,'JSON identity remains unchanged');assert.equal(await readFile(md,'utf8'),markdown,'Markdown projection remains unchanged');proof.push(item.name);
 }
 assert.equal(await page.evaluate(()=>window.__crewMedia.calls),0);assert.deepEqual(errors,[]);const result={pass:true,output,cases:proof,widths:[1400,390],immutableRecords:true,mediaCalls:0,errors};await writeFile(path.join(output,'proof.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await browser?.close();if(fixture.exitCode===null){fixture.kill('SIGTERM');await once(fixture,'exit');}}
