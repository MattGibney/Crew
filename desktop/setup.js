/* AI-008: trusted local setup renderer; bounded preload API only. */
const api=window.crewSetup, $=id=>document.getElementById(id);
const labels=['Welcome','Local tools','ChatGPT & tools','Project','Permissions','Summary'];
let snapshot, step=0, busy=false, analyzing=false, micSkipped=false;
function message(text,error=false){$('notice').textContent=error?'':text;$('error').hidden=!error;$('error').textContent=error?text:'';}
function status(container,name,value={status:'unknown',detail:'Not checked.'}){const box=document.createElement('div');box.className='status';box.dataset.status=value.status;const title=document.createElement('strong');title.textContent=`${name} · ${value.status}`;const body=document.createElement('p');body.textContent=(value.detail||'').replace(/Confirm and set project\.linear\.teamId[^.]*\./g,'Choose your Linear team, or connect it later.').replace(/Confirm and set project\.linear\.teamKey[^.]*\./g,'Choose your Linear team.').replace(/Set an explicit baseRef for repository "([^"]+)"\./g,'Choose a starting branch for $1.');box.append(title,body);container.append(box);}
function display(){
  document.querySelectorAll('[data-step]').forEach(el=>{el.hidden=Number(el.dataset.step)!==step;});
  document.querySelectorAll('#steps button').forEach((el,i)=>{if(i===step)el.setAttribute('aria-current','step');else el.removeAttribute('aria-current');});
  $('back').disabled=busy||step===0;$('next').disabled=busy||step===5;$('position').textContent=`Step ${step+1} of 6`;
  $('cancel-discovery').hidden=!analyzing;$('cancel-discovery').disabled=!analyzing;$('discover').disabled=busy||!snapshot?.discoveryRoot;
  $('linear-project-choice').disabled=busy||!$('team-id').value;
  if(step===5)summary();
}
function move(index){step=Math.max(0,Math.min(5,index));display();window.scrollTo(0,0);}
labels.forEach((label,i)=>{const button=document.createElement('button');button.textContent=label;button.onclick=()=>move(i);$('steps').append(button);});
$('back').onclick=()=>move(step-1);$('next').onclick=()=>move(step+1);document.querySelector('[data-next]').onclick=()=>move(1);
async function action(label,fn){if(busy)return;busy=true;document.querySelectorAll('button,input,textarea,select').forEach(b=>b.disabled=true);message(`${label}…`);try{const value=await fn();message(value?.notice||`${label} finished.`);}catch(error){try{snapshot=await api.snapshot();renderChecks();}catch{}if(analyzing)$('discovery-progress').textContent='Setup did not finish. Your saved settings are unchanged; try again.';message(error.message||String(error),true);}finally{busy=false;document.querySelectorAll('button,input,textarea,select').forEach(b=>b.disabled=false);display();}}
function renderChecks(){const c=snapshot?.checks||{};$('runtime-result').replaceChildren();for(const key of ['codex','git'])status($('runtime-result'),key==='codex'?'Codex':'Git',c[key]);$('account-result').replaceChildren();for(const [key,label] of [['protocol','Protocol'],['auth','ChatGPT'],['voices','Voice catalog']])status($('account-result'),label,c[key]);$('project-result').replaceChildren();status($('project-result'),'Project',c.project);$('tools-result').replaceChildren();status($('tools-result'),'Connected tools',c.tools);if(c.tools?.linear)status($('tools-result'),'Linear read tools',c.tools.linear);if(c.tools?.servers?.length){const details=document.createElement('details');const label=document.createElement('summary');label.textContent=`Inspect ${c.tools.servers.length} connected-tool entries`;details.append(label);for(const server of c.tools.servers){const auth={unsupported:'No standard auth status reported',notLoggedIn:'Sign-in not reported',bearerToken:'Authentication managed by Codex',oAuth:'Authentication managed by Codex'}[server.auth]||server.auth;status(details,server.name,{status:server.tools.length?'advertised':server.status,detail:`${auth}; ${server.tools.length} tools advertised. Access is not yet verified.`});}$('tools-result').append(details);}$('microphone-result').replaceChildren();status($('microphone-result'),'Microphone',{status:snapshot?.microphone||'unknown',detail:'macOS permission status; no recording or voice call has started.'});$('paths-result').replaceChildren();for(const path of c.paths||[])status($('paths-result'),path.name,path);}
function summary(){const target=$('summary');target.replaceChildren();const c=snapshot?.checks||{};for(const [key,label] of [['codex','Codex'],['git','Git'],['protocol','App-server protocol'],['auth','ChatGPT'],['voices','Voice catalog'],['project','Project configuration'],['tools','Connected tools']])status(target,label,c[key]);if(c.tools?.linear)status(target,'Linear access',c.tools.linear);status(target,'Microphone',{status:micSkipped?'skipped':snapshot?.microphone||'unknown',detail:`Optional until you choose voice. macOS status: ${snapshot?.microphone||'unknown'}. A granted OS permission does not prove audible conversation.`});status(target,'File access',{status:c.paths?.length?(c.paths.every(p=>p.status==='verified')?'verified':'incomplete'):'unknown',detail:c.paths?.length?'Scope: configured paths in this packaged process; worker sandbox access still needs a bounded task.':'Not checked in this setup.'});$('launch').textContent=snapshot?.controllerRunning?'Return to running manager':'Check readiness and open manager';if(snapshot?.controllerRunning)status(target,'Existing controller',{status:'running',detail:'Setup does not stop or replace this controller. Config changes require a safe restart.'});}
function repositoryRow(repo, choice=(snapshot?.repositoryOptions||[]).find(c=>c.path===repo.path)) {
 const row=document.createElement('div');row.className='repository';row.repository={...repo};
 const title=document.createElement('h4');title.textContent=repo.name;
 const path=document.createElement('p');path.textContent=repo.path||'Choose a folder';
 const label=document.createElement('label');label.textContent='Starting branch';const select=document.createElement('select');select.setAttribute('aria-label',`Starting branch for ${repo.name}`);
 const branches=choice?.branches||[];const add=(value,text)=>{const option=document.createElement('option');option.value=value;option.textContent=text;select.append(option);};
 add('','Choose a branch');for(const branch of branches)add(branch.ref||branch.value,branch.kind==='remote'?`${branch.label.replace(/^origin\//,'')} (remote)`:branch.label);
 if(repo.baseRef&&!branches.some(b=>(b.ref||b.value)===repo.baseRef))add(repo.baseRef,`${repo.baseRef} (refresh folder to check)`);
 select.value=repo.baseRef||'';label.append(select);select.onchange=()=>{row.repository.baseRef=select.value||null;void saveProject('Save starting branch');};
 const pick=document.createElement('button');pick.textContent='Change folder…';pick.onclick=()=>action('Choose folder',async()=>{const selected=await api.chooseRepository();if(!selected)return {notice:'Folder selection canceled.'};const c=await api.repositoryOptions(selected);const next={...row.repository,id:c.id,name:c.name,path:c.path,baseRef:c.baseRef};repositoryRow(next,c);row.remove();snapshot=await api.save({config:collect(),revision:snapshot.revision});fill();return {notice:'Project folder and starting branch saved.'};});
 const remove=document.createElement('button');remove.textContent='Remove folder';remove.onclick=()=>{row.remove();};
 row.append(title,path,label,pick,remove);if(choice?.status!=='verified'){const note=document.createElement('p');note.className='hint';note.textContent=choice?.detail||'Choose this folder to find its branches.';row.append(note);}$('repositories').append(row);
}
function renderLinear(){
 const catalog=snapshot?.linearOptions,raw=snapshot?.config?.project.linear||{},teamSelect=$('linear-team-choice'),projectSelect=$('linear-project-choice');
 const teamId=$('team-id').value||raw.teamId,projectId=$('linear-project').value||raw.projectId;
 const option=(target,value,text)=>{const node=document.createElement('option');node.value=value;node.textContent=text;target.append(node);};
 teamSelect.replaceChildren();option(teamSelect,'','Connect later');for(const team of catalog?.teams||[])option(teamSelect,team.id,`${team.name} (${team.key})`);
 if(teamId && !(catalog?.teams||[]).some(t=>t.id===teamId))option(teamSelect,teamId,'Saved team — refresh to check its name');teamSelect.value=teamId||'';
 projectSelect.replaceChildren();option(projectSelect,'','All team tickets (no project filter)');const projects=(catalog?.projects||[]).filter(p=>p.teamIds?.includes(teamId));for(const project of projects)option(projectSelect,project.id,project.name);
 if(projectId&&!projects.some(p=>p.id===projectId))option(projectSelect,projectId,'Saved project — refresh to check its name');projectSelect.value=projectId||'';projectSelect.disabled=busy||!teamId;
 $('linear-status').textContent=catalog?.detail||'Find your teams through your connected Linear account. You can also connect later.';
 $('refresh-linear').textContent=catalog?'Refresh Linear teams':'Find my Linear teams';
}
function renderDiscovery(){
 $('discovery-folder').textContent=snapshot?.discoveryRoot||'No project folder selected.';
 const info=snapshot?.discoverySummary,target=$('proposal-evidence');target.replaceChildren();
 $('understanding-text').textContent=snapshot?.config?.project.context||'';
 if(info){const summary=document.createElement('p');summary.textContent=`Based on ${info.sources.length} selected files${info.truncated?' from part of this repository':''}.`;target.append(summary);for(const finding of info.findings||[]){const p=document.createElement('p');p.textContent=`${finding.statement} (${finding.sources.join(', ')||'Not established by the selected files'})`;target.append(p);}}
 const saved=snapshot?.config?.project.repositories?.find(r=>r.path)?.path;
 $('project-settings').hidden=!snapshot?.config||Boolean(snapshot.discoveryRoot&&snapshot.discoveryRoot!==saved);
}
function fill(){renderStorage();$('initialize').hidden=!snapshot?.missingConfig;$('repair-config').hidden=Boolean(snapshot?.config);const raw=snapshot?.config;if(!raw){renderDiscovery();return;}$('instance').textContent='Your settings stay on this Mac and can be changed later.';
 for(const [id,value] of Object.entries({codex:raw.runtime.codexBinary||'',name:raw.project.name,id:raw.project.id,context:raw.project.context,mode:raw.project.mode,port:raw.runtime.port,'max-workers':raw.project.worker.maxConcurrent||2,'team-key':raw.project.linear.teamKey||'','team-id':raw.project.linear.teamId||'','linear-project':raw.project.linear.projectId||'','data-dir':raw.runtime.dataDir,'manager-prompt':raw.project.prompts.manager,'worker-prompt':raw.project.prompts.worker}))$(id).value=value;
 $('repositories').replaceChildren();raw.project.repositories.forEach(repo=>repositoryRow(repo));$('business-fields').hidden=raw.project.mode==='fixture';renderDiscovery();renderLinear();renderChecks();
}
function collect(){if(!snapshot?.config)throw Error('Reload your saved settings before making changes.');const raw=structuredClone(snapshot.config);raw.runtime.codexBinary=$('codex').value.trim()||null;raw.runtime.port=Number($('port').value);raw.runtime.dataDir=$('data-dir').value.trim();Object.assign(raw.project,{id:$('id').value.trim(),name:$('name').value.trim(),context:$('context').value.trim(),mode:$('mode').value});raw.project.worker.maxConcurrent=Number($('max-workers').value);raw.project.prompts={manager:$('manager-prompt').value.trim(),worker:$('worker-prompt').value.trim()};raw.project.linear={teamKey:$('team-key').value.trim()||null,teamId:$('team-id').value.trim()||null,projectId:$('linear-project').value.trim()||null};raw.project.repositories=raw.project.mode==='fixture'?[]:[...$('repositories').children].map(row=>({...row.repository}));return raw;}
async function saveProject(label='Save project settings'){return action(label,async()=>{snapshot=await api.save({config:collect(),revision:snapshot.revision});fill();return{notice:'Project settings saved. No worker started.'};});}
async function refresh(){snapshot=await api.snapshot();fill();renderChecks();if(snapshot.error)throw new Error(snapshot.error);}
for(const id of ['save-project','save-runtime'])$(id).onclick=()=>saveProject();
$('runtime').onclick=()=>action('Check local tools',async()=>{snapshot=await api.runtime();renderChecks();});
$('account').onclick=()=>action('Check sign-in and capabilities',async()=>{snapshot=await api.account();renderChecks();});
$('login').onclick=()=>action('Sign in with ChatGPT in your browser',async()=>{snapshot=await api.login();renderChecks();});
$('paths').onclick=()=>action('Check configured file access',async()=>{snapshot=await api.paths();renderChecks();});
$('skip-microphone').onclick=()=>{micSkipped=true;message('Microphone check skipped. No permission request, recording or voice call started.');move(5);};
$('microphone').onclick=()=>action('Request microphone permission',async()=>{micSkipped=false;snapshot=await api.microphone();renderChecks();});
for(const [id,name] of [['microphone-settings','microphone'],['files-settings','files'],['network-settings','network']])$(id).onclick=()=>action('Open macOS privacy settings',()=>api.settings(name));
$('pick-codex').onclick=()=>action('Choose Codex executable',async()=>{const p=await api.chooseCodex();if(p)$('codex').value=p;return{notice:p?'Executable selected; save the choice before checking.':'Selection canceled.'};});
$('mode').onchange=()=>{$('business-fields').hidden=$('mode').value==='fixture';};$('add-repo').onclick=()=>action('Choose another project folder',async()=>{const path=await api.chooseRepository();if(path){const c=await api.repositoryOptions(path);repositoryRow({id:c.id,name:c.name,path:c.path,baseRef:c.baseRef,components:[]},c);}});
$('initialize').onclick=()=>action('Create editable project template',async()=>{snapshot=await api.initialize();fill();});
$('repair-config').onclick=()=>action('Open configuration',()=>api.openConfig());$('reload-all').onclick=()=>action('Reload setup',refresh);
$('reload').onclick=()=>action('Reload setup',refresh);$('open-config').onclick=()=>action('Open configuration',()=>api.openConfig());$('open-prompts').onclick=()=>action('Open configuration folder',()=>api.openPrompts());$('help').onclick=()=>action('Open official Codex guide',()=>api.help());
$('launch').onclick=()=>action('Check readiness',async()=>{await api.launch();});


$('pick-discovery').onclick=()=>action('Choose project folder',async()=>{snapshot=await api.chooseDiscovery();renderDiscovery();return{notice:'Folder selected. Choose Set up this project to save its details automatically.'};});
$('discover').onclick=()=>action('Set up project',async()=>{analyzing=true;display();$('discovery-progress').textContent='Reading project files and finding branches and Linear teams. Your saved setup stays available until the new settings are validated.';try{snapshot=await api.discover();fill();if(snapshot.notice){$('discovery-progress').textContent=snapshot.notice;return{notice:snapshot.notice};}$('discovery-progress').textContent='Project set up and saved. You can change any setting here.';return{notice:'Your project settings are saved. Continue when ready.'};}finally{analyzing=false;display();}});
$('cancel-discovery').onclick=async()=>{try{const result=await api.cancelDiscovery();$('discovery-progress').textContent=result.notice;}catch(error){message(error.message,true);}};
$('refresh-linear').onclick=()=>action('Find Linear teams',async()=>{snapshot=await api.linearOptions();renderLinear();});
$('linear-team-choice').onchange=()=>{const team=snapshot?.linearOptions?.teams.find(t=>t.id===$('linear-team-choice').value);$('team-id').value=team?.id||'';$('team-key').value=team?.key||'';$('linear-project').value='';void saveProject('Save Linear team');};
$('linear-project-choice').onchange=()=>{$('linear-project').value=$('linear-project-choice').value;void saveProject('Save Linear project');};
$('defer-linear').onclick=()=>{$('team-id').value='';$('team-key').value='';$('linear-project').value='';void saveProject('Connect Linear later');};

action('Load local setup',refresh);display();

function renderStorage(){const target=$('storage-recovery');target.replaceChildren();target.hidden=!snapshot?.migration;if(!snapshot?.migration)return;const m=snapshot.migration;const title=document.createElement('h2');title.textContent='Previous storage needs review';target.append(title);const info=document.createElement('p');info.textContent=m.issue+' No configuration, history or authentication was reset. Quit a previous app before retrying. Choosing a previous configuration keeps its explicit path for recovery.';target.append(info);const add=(label,fn)=>{const b=document.createElement('button');b.textContent=label;b.onclick=()=>action(label,fn);target.append(b);};add('Retry migration',()=>api.storageRetry());add('Open Crew storage folder',()=>api.storageFolder());[m.newConfigPath,...m.legacyConfigPaths].forEach((p,i)=>add(`Use ${p}`,()=>api.storageUse(i)));}
