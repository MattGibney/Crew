import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {trackingPreferences,validateTracking,validateWorkLink,workLinkFromTicket} from '../runtime/shared/tracking.mjs';
import {createTask,readTask,updateTask,currentAssignment,requestWorkerFollowup} from '../runtime/orchestration/store.mjs';
import {discoverGitHubOptions} from '../runtime/desktop/github-options.mjs';
import {parseConfig} from '../runtime/config/shape.mjs';
import {loadAppConfig} from '../runtime/config/index.mjs';
import {composeProjectSetup} from '../runtime/desktop/project-setup.mjs';
import {parseWorkerConfiguration} from '../runtime/workers/worker-protocol.mjs';
const github=(repo='owner/one',number=12)=>({provider:'github',repository:repo,number,url:`https://github.com/${repo}/issues/${number}`});
const linear={provider:'linear',identifier:'TEAM-12',url:'https://linear.app/example/issue/TEAM-12/title'};
test('none/Linear/GitHub/both preferences are data; legacy choices survive and invalid preferred provider is rejected',async()=>{
 assert.deepEqual(trackingPreferences({linear:{teamId:null}}),{providers:[],preferred:'none',githubRepository:null});
 assert.equal(trackingPreferences({linear:{teamId:'saved',teamKey:'TEAM'}}).preferred,'linear');
 for(const providers of [[],['linear'],['github'],['linear','github']]){
  const tracking={providers,preferred:providers.at(-1)||'none',githubRepository:providers.includes('github')?'MattGibney/Crew':null};
  assert.deepEqual(validateTracking({tracking}),tracking);
  const config=JSON.parse(await readFile('config/fixture.example.json','utf8'));config.project.tracking=tracking;
  assert.deepEqual(parseConfig(JSON.stringify(config)).project.tracking,tracking);
 }
 assert.throws(()=>validateTracking({tracking:{providers:[],preferred:'github',githubRepository:null}}),/Preferred/);
});
test('runtime readiness is independent of none or unavailable selected integrations',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'crew-gh78-config-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const config=JSON.parse(await readFile('config/set1.example.json','utf8'));
 config.runtime.dataDir=path.join(root,'state');config.project.repositories=[{id:'crew',name:'Crew',path:process.cwd(),baseRef:'HEAD',components:[]}];
 config.project.prompts={manager:path.resolve('prompts/manager.md'),worker:path.resolve('prompts/worker.md')};
 const file=path.join(root,'project.json');
 for(const providers of [[],['linear'],['github'],['linear','github']]){
  config.project.tracking={providers,preferred:providers.at(-1)||'none',githubRepository:null};await writeFile(file,JSON.stringify(config));
  const loaded=await loadAppConfig({root:process.cwd(),configPath:file,checkRuntime:false});
  assert.equal(loaded.project.readiness.ready,true,providers.join(','));assert.deepEqual(loaded.project.readiness.issues,[]);
 }
});
test('local dispatch has no fabricated ticket; linked identities survive reload/follow-up and cannot mutate original history',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'crew-gh78-store-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const local=await createTask(dir,{requestId:'local-task-one',brief:'Agreed local work'});assert.equal(local.ticket,'');assert.equal(local.workLink,null);
 const identities=[github(),github('owner/two'),linear];
 for(const [i,workLink] of identities.entries()){
  const requestId=`linked-task-${i}`;await createTask(dir,{requestId,brief:'Bounded linked work',workLink});
  await requestWorkerFollowup(dir,{taskId:requestId,requestId:`followup-task-${i}`,brief:'Continue selected issue'});
  const task=await readTask(dir,requestId);assert.deepEqual(task.workLink,workLink);assert.deepEqual(task.assignments[1].workLink,workLink);
  await assert.rejects(updateTask(dir,requestId,task=>{task.workLink=github('wrong/repo');}),/immutable/);
  await assert.rejects(createTask(dir,{requestId,brief:'Bounded linked work',workLink:github('wrong/repo')}),/different/);
 }
 await requestWorkerFollowup(dir,{taskId:'linked-task-0',requestId:'local-followup-1',brief:'Explicit local follow-up',workLink:null});
 await updateTask(dir,'linked-task-0',task=>{task.currentAssignmentId='local-followup-1';});
 await requestWorkerFollowup(dir,{taskId:'linked-task-0',requestId:'local-followup-2',brief:'Continue local work'});
 const retained=await readTask(dir,'linked-task-0');assert.equal(retained.assignments.at(-1).workLink,null);assert.equal(retained.assignments.at(-1).ticket,'');assert.deepEqual(retained.workLink,github());
});
test('canonical links reject mismatch and ambiguity; legacy task bytes remain readable',async t=>{
 assert.deepEqual(workLinkFromTicket(github().url),github());assert.equal(workLinkFromTicket('TEAM-12'),null);
 for(const link of [{...github(),url:github('wrong/repo').url},{...github(),number:0},{...github(),repository:'../repo'},{...linear,url:'https://linear.app.evil/issue/TEAM-12'}])assert.throws(()=>validateWorkLink(link));
 const dir=await mkdtemp(path.join(tmpdir(),'crew-gh78-legacy-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const task=await createTask(dir,{requestId:'legacy-task-1',ticket:'TEAM-12',brief:'Existing linked label'});const file=path.join(dir,'tasks',task.id+'.json');const old=JSON.parse(await readFile(file,'utf8'));delete old.workLink;await writeFile(file,JSON.stringify(old));const before=await readFile(file,'utf8');
 assert.equal(currentAssignment(await readTask(dir,task.id)).ticket,'TEAM-12');assert.equal(await readFile(file,'utf8'),before);
});
function rpcFixture({rows=[{repository_full_name:'MattGibney/Crew'}],fail=false,multiple=false,exact=false}={}){
 const calls=[];return {calls,rpc:async(method,args)=>{calls.push({method,args});if(method==='account/read')return {account:{type:'chatgpt'}};
 if(method==='mcpServerStatus/list')return {data:[{name:'github',tools:{[exact?'get_repo':'list_repositories']:{inputSchema:{type:'object',properties:exact?{repository_full_name:{type:'string'}}:{page_size:{type:'integer'}},required:[]}}}},...(multiple?[{name:'other_github',tools:{list_repositories:{inputSchema:{properties:{}}}}}]:[])]};
 if(method==='thread/start')return {thread:{id:'disposable-thread'}};if(method==='thread/unsubscribe')return {};
 if(method==='mcpServer/tool/call')return fail?{isError:true,content:[]}:{structuredContent:exact?rows[0]:{repositories:rows}};throw Error(method);}};
}
test('GitHub discovery uses only authenticated read tools, explicit selection and bounded truthful access',async()=>{
 const fixture=rpcFixture();const result=await discoverGitHubOptions({root:process.cwd(),rpc:fixture.rpc});assert.equal(result.status,'verified');assert.equal(result.repositories[0].fullName,'MattGibney/Crew');assert.equal(fixture.calls.filter(c=>c.method==='mcpServer/tool/call').length,1);assert.equal(fixture.calls.at(-1).method,'thread/unsubscribe');assert.ok(!fixture.calls.some(c=>c.method==='turn/start'));
 assert.equal((await discoverGitHubOptions({root:process.cwd(),rpc:rpcFixture({fail:true}).rpc})).status,'unavailable');
 const multiple=rpcFixture({multiple:true});assert.equal((await discoverGitHubOptions({root:process.cwd(),rpc:multiple.rpc})).status,'advertised');assert.ok(!multiple.calls.some(c=>c.method==='mcpServer/tool/call'));
 assert.equal((await discoverGitHubOptions({root:process.cwd(),rpc:rpcFixture({rows:[{name:'ambiguous'}]}).rpc})).status,'partial');
 const exact=rpcFixture({exact:true});assert.equal((await discoverGitHubOptions({root:process.cwd(),repository:'MattGibney/Crew',rpc:exact.rpc})).status,'verified');assert.deepEqual(exact.calls.find(c=>c.method==='mcpServer/tool/call').args.arguments,{repository_full_name:'MattGibney/Crew'});
 assert.equal((await discoverGitHubOptions({root:process.cwd(),repository:'wrong/repository',rpc:exact.rpc})).status,'unavailable');
});
test('folder changes clear optional mappings while same-folder reanalysis preserves them',()=>{
 const current={runtime:{},project:{id:'crew',name:'Crew',repositories:[{id:'crew',path:'/old'}],linear:{teamId:'saved',teamKey:'TEAM',projectId:null},tracking:{providers:['linear','github'],preferred:'github',githubRepository:'MattGibney/Crew'}}};
 const compose=folder=>composeProjectSetup({current,proposal:{config:{project:{name:'New',repositories:[{}]}}},repository:{status:'verified',id:'new',name:'New',path:folder,baseRef:'main'},linear:{status:'verified',teams:[{id:'unrelated',key:'OTHER'}],projects:[]}});
 assert.deepEqual(compose('/old').project.tracking,current.project.tracking);assert.deepEqual(compose('/new').project.tracking,{providers:[],preferred:'none',githubRepository:null});assert.equal(compose('/new').project.linear.teamId,null);
});

test('previous shipped defaults migrate exactly while custom and active snapshots remain protected',async()=>{
 const {initialPrompts,migratePromptRecord}=await import('../runtime/manager/instructions/provenance.mjs');
 const previous=JSON.parse(await readFile('tests/fixtures/prompts-v0.17.3.json','utf8'));
 const defaults={manager:await readFile('prompts/manager.md','utf8'),worker:await readFile('prompts/worker.md','utf8')};
 assert.deepEqual(initialPrompts(previous,defaults).texts,defaults);
 const record={schemaVersion:1,projectId:'crew',prompts:previous,promptOrigins:{manager:'custom',worker:'default'},promptUpgradeHistory:[]};
 const migrated=migratePromptRecord(record,'crew',defaults);assert.equal(migrated.retained.texts.manager,previous.manager);assert.equal(migrated.retained.texts.worker,defaults.worker);assert.deepEqual(record.prompts,previous);
});

test('legacy canonical URL create retries preserve bytes and compare link identity semantically',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'crew-gh78-retry-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 for(const [i,link] of [github(),linear].entries()){
  const request={requestId:`legacy-url-${i}`,ticket:link.url,brief:'Retained pre-upgrade task'};
  await createTask(dir,request);const file=path.join(dir,'tasks',request.requestId+'.json'),md=path.join(dir,'tasks',request.requestId+'.md');
  const raw=JSON.parse(await readFile(file,'utf8'));delete raw.workLink;await writeFile(file,JSON.stringify(raw));const before=await readFile(file,'utf8'),markdown=await readFile(md,'utf8');
  assert.equal((await createTask(dir,request)).workLink,undefined);
  await createTask(dir,{...request,workLink:Object.fromEntries(Object.entries(link).reverse())});
  for(const change of [{brief:'Changed brief'},{ticket:github('other/repo').url},{workLink:null},{workLink:link.provider==='github'?linear:github()}])await assert.rejects(createTask(dir,{...request,...change}),/different/);
  assert.equal(await readFile(file,'utf8'),before);assert.equal(await readFile(md,'utf8'),markdown);
  const follow={taskId:request.requestId,requestId:`legacy-follow-${i}`,brief:'Continue exact issue'};
  await requestWorkerFollowup(dir,follow);let task=await readTask(dir,request.requestId);assert.deepEqual(task.assignments.at(-1).workLink,link);
  // Emulate a pre-upgrade assignment with its original request provenance retained.
  const legacy=JSON.parse(await readFile(file,'utf8'));delete legacy.assignments.at(-1).workLink;await writeFile(file,JSON.stringify(legacy));
  await requestWorkerFollowup(dir,follow);task=await readTask(dir,request.requestId);assert.equal(task.assignments.at(-1).workLink,undefined);
  const retriedBytes=await readFile(file,'utf8');await requestWorkerFollowup(dir,follow);assert.equal(await readFile(file,'utf8'),retriedBytes);
  const retained=JSON.parse(retriedBytes),different=link.provider==='github'?linear:github('owner/another');retained.currentAssignmentId=follow.requestId;retained.assignments.at(-1).ticket=different.url;await writeFile(file,JSON.stringify(retained));
  await requestWorkerFollowup(dir,{taskId:request.requestId,requestId:`inherit-current-${i}`,brief:'Use current legacy assignment, not original issue'});
  assert.deepEqual((await readTask(dir,request.requestId)).assignments.at(-1).workLink,different);
 }
 const link=github(),request={requestId:'new-url-linked',ticket:link.url,brief:'New linked task',workLink:link};await createTask(dir,request);
 await createTask(dir,{...request,workLink:Object.fromEntries(Object.entries(link).reverse())});await assert.rejects(createTask(dir,{...request,workLink:null}),/different/);
 const local={requestId:'explicit-null-task',ticket:link.url,brief:'Intentionally unlinked label',workLink:null};await createTask(dir,local);await createTask(dir,local);await assert.rejects(createTask(dir,{...local,workLink:undefined}),/different/);
 const follow={taskId:request.requestId,requestId:'semantic-followup',brief:'Same new link',workLink:link};await requestWorkerFollowup(dir,follow);await requestWorkerFollowup(dir,{...follow,workLink:Object.fromEntries(Object.entries(link).reverse())});await assert.rejects(requestWorkerFollowup(dir,{...follow,workLink:null}),/changed/);
});

test('worker reference uses actual legacy/canonical identity, keeps number first and preserves explicit local semantics',async()=>{
 const {workReference}=await import('../runtime/shared/tracking.mjs');
 const legacy={ticket:'https://github.com/MattGibney/Crew/issues/78'};const before=JSON.stringify(legacy);const reference=workReference(legacy,'retained-worker');
 assert.equal(reference.label,'#78');assert.equal(reference.repository,'MattGibney/Crew');assert.equal(reference.context,'GitHub issue MattGibney/Crew#78');assert.equal(JSON.stringify(legacy),before);
 assert.equal(workReference({workLink:github('owner/'+ 'r'.repeat(100),78)},'new-worker').label,'#78');
 assert.notEqual(workReference({workLink:github('owner/one',12)},'one').context,workReference({workLink:github('owner/two',12)},'two').context);
 assert.equal(workReference({...legacy,workLink:null},'local-worker').label,'local-worker');assert.equal(workReference({...legacy,workLink:null},'local-worker').link,null);
 assert.equal(workReference({ticket:'TEAM-78'},'linear-worker').label,'TEAM-78');assert.equal(workReference({ticket:linear.url},'linear-worker').label,'TEAM-12');
 for(const ticket of ['repo#78','#78','GitHub issue 78','https://example.com/owner/repo/issues/78','https://github.com/owner/repo/pull/78','https://github.com/owner/repo/issues/99999999999999999999999'])assert.equal(workReference({ticket},'worker').link,null);
 assert.equal(workReference({},'local-worker').label,'local-worker');
});
