// AI-007: the main process owns the local backend; windows own only voice/UI.
import { app, BrowserWindow, dialog, shell, session, systemPreferences } from 'electron';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, open, access, rename } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readSetupConfig, saveSetupConfig, checkLocalRuntime, probeCodex, probePaths, setupInputsKey, applyDiscoveryDraft, requestMicrophonePermission } from './setup-service.mjs';
import { discoverProject } from '../project-discovery.mjs';
import {discoverRepository,discoverLinearOptions,verifyReference} from './project-options.mjs';
import {composeProjectSetup,assertLinearSelection} from './project-setup.mjs';
import {discoverWorkerEnvironment,assertWorkerEnvironmentSelection} from './environment-options.mjs';
import {selectExecutionPlan} from './execution-selection.mjs';
import { randomUUID } from 'node:crypto';
import {UPDATE_ACTIONS} from './updater.mjs';
import { relative, sep, isAbsolute } from 'node:path';
import { loadAppConfig } from '../config.mjs';
import { summarizeTasks, isAppURL, isExternalHTTPS, permitsAudio, childEnvironment } from './lifecycle.mjs';
export function createProjectHost({root,storage,host}) {
const {configPath,key,desktopData,id}=storage;
mkdirSync(join(desktopData,'Partitions',`instance-${key}`),{recursive:true,mode:0o700});
const flag=0; // Registered configurations are never silently reinitialized.
let discoveryController, discoveryRoot, discoveryProposal, discoverySummary, linearOptions, discoveryPhase;
const repositoryOptions=new Map();
let setupWindow, setupChecks = {}, setupRevision, setupInputs, setupOperation = false;
let window, config, origin, backend, pollTimer, starting = false, quitting = false, closing = false;



let stoppedForUpdate=false;
let counts = { active: null, pending: null }, lastError = null, backendReady = false;
const env = {...childEnvironment(configPath), CREW_GLOBAL_CAPACITY_DIR:host.capacityDirectory};
  delete env.AI_MANAGER_PORT; delete env.VOICE_PORT;
const setupURL = pathToFileURL(join(root, 'renderer-dist/setup.html')).href;
const delay = ms => new Promise(done => setTimeout(done, ms));
const safe = error => String(error?.message || error).replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').replace(/sk-[\w-]+/g, '[redacted]').slice(0, 1400);
const escape = text => String(text).replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
async function statusFile() {
  if (!config) return;
  const target = join(config.dataDir, 'desktop-status.json');
  const value = { pid: process.pid, backendPid: backend?.exitCode === null ? backend.pid : null, configPath, projectId: config.project.id, port: config.port, backendReady, windowOpen: Boolean(window && !window.isDestroyed()), windowCount: window && !window.isDestroyed() ? 1 : 0, isQuitting:quitting, pendingCount:counts.pending, activeCount:counts.active, ...counts, error: lastError, update:host.updater?.getStatus(), updatedAt: new Date().toISOString() };
  const temporary = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, target);
}
async function api(route, input = {}, timeout = 6000) {
  const response = await fetch(`${origin}/api/${route}`, { method:'POST', headers:{ Origin:origin, 'Content-Type':'application/json' }, body:JSON.stringify(input), signal:AbortSignal.timeout(timeout) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || `Local request failed (${response.status}).`);
  return value;
}
function updateTray() { host.changed(); }
async function openWindow() {
  if (!host.isSelected(id)) return;
  if (!backendReady) return openSetup();
  if (window && !window.isDestroyed()) { window.show(); window.focus(); return; }
  const next = new BrowserWindow({ width:1050, height:850, minWidth:540, minHeight:500, title:`${config?.project.name || 'Setup'} — Crew`, show:false,
    webPreferences:{ nodeIntegration:false, contextIsolation:true, sandbox:true, webSecurity:true, allowRunningInsecureContent:false, preload:join(root, 'desktop/workspace-preload.cjs'), session:session.fromPath(join(desktopData,'Partitions',`instance-${key}`)) }
  });
  window = next;
  next.webContents.setWindowOpenHandler(details => {
    // Only the trusted local UI may send an HTTPS connector/login link to the OS browser.
    if (origin && isAppURL(next.webContents.getURL(), origin) && isExternalHTTPS(details.url)) void shell.openExternal(details.url).catch(error => console.error(safe(error)));
    return { action:'deny' };
  });
  next.webContents.on('will-navigate', (event, url) => { if (!origin || !isAppURL(url, origin)) event.preventDefault(); });
  next.webContents.on('will-attach-webview', event => event.preventDefault());
  next.on('close', event => {
    if (quitting || closing) return;
    event.preventDefault(); closing = true;
    void (async () => {
      // Stop server voice before destroying Chromium, which releases mic tracks/SSE.
      if (backendReady) await api('disconnect', {}, 4000).catch(() => {});
      if (!next.isDestroyed()) next.destroy();
      if (window === next) window = undefined;
      closing = false; await statusFile().catch(() => {});
    })();
  });
  next.on('closed', () => { if (window === next) window = undefined; void statusFile().catch(() => {}); });
  if (backendReady) await next.loadURL(origin);
  else await next.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><meta charset="utf-8"><title>Crew setup</title><style>body{font:17px system-ui;max-width:760px;margin:72px auto;padding:24px;line-height:1.6;background:#f7f8fc;color:#182033}code{overflow-wrap:anywhere}</style><h1>${lastError ? 'Setup needs attention' : 'Starting Crew'}</h1><p>${escape(lastError || 'Starting the local controller. Microphone is off.')}</p><p>Configuration: <code>${escape(configPath)}</code></p><p>Use the menu-bar icon to edit configuration, open logs, or retry startup. Each workspace handles one project. No work starts automatically.</p>`)}`);
  next.show(); await statusFile().catch(() => {});
}
async function poll() {
  if (!backendReady || quitting) return;
  try { const view = await api('orchestration'); counts = summarizeTasks(view); lastError = view.error ? safe(view.error) : null; }
  catch (error) { counts = { active:null, pending:null }; lastError = safe(error); }
  // Parent polls all controllers; update refresh is shared.
  updateTray(); await statusFile().catch(() => {});
}
async function startup({ showWindow = true } = {}) {
  if (starting || backend) return;
  starting = true; lastError = null; updateTray();
  try {
    try { await access(configPath); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (flag >= 0 || process.env.AI_MANAGER_CONFIG) throw new Error(`Configuration file not found: ${configPath}. Initialize it with the documented local configuration command before launching this instance.`);
      await new Promise((done, reject) => {
        const init = spawn(process.execPath, [join(root, 'cli.mjs'), 'init', '--template', 'set1', '--config', configPath], { cwd:root, env, stdio:'ignore' });
        init.once('error', reject); init.once('exit', code => code === 0 ? done() : reject(new Error('Could not create first-launch project configuration. No existing file was overwritten.')));
      });
    }
    await host.validateAll();
    config = await loadAppConfig({ root, configPath, env });
    origin = `http://127.0.0.1:${config.port}`;
    await mkdir(config.dataDir, { recursive:true, mode:0o700 });
    // Never attach to or stop a server started by another owner.
    try {
      const marker = JSON.parse(await readFile(config.serverStatePath, 'utf8'));
      let alive = true; try { process.kill(marker.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; else throw error; }
      if (alive) throw new Error(`This configuration already has a local server (PID ${marker.pid}). Stop it with its existing local stop command before opening this instance in the desktop app. No process was changed.`);
    } catch (error) { if (error.code !== 'ENOENT' && !error.message?.startsWith('Unexpected')) throw error; if (error instanceof SyntaxError) throw new Error('Instance server marker is malformed. Inspect it before restarting.'); }
    const log = await open(join(config.dataDir, 'desktop.log'), 'a', 0o600);
    try { backend = spawn(process.execPath, [join(root, 'server.mjs')], { cwd:root, env, stdio:['ignore', log.fd, log.fd, 'ipc'] }); }
    finally { await log.close(); }
    const owned = backend;
    owned.on('message',message=>{
      if(backend!==owned||message?.type!=='crew:update:request'||typeof message.id!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(message.id)||!UPDATE_ACTIONS.has(message.action))return;
      void (async()=>{try{const status=await host.updater.request(message.action);sendUpdate(owned,{type:'crew:update:response',id:message.id,status});}catch(error){sendUpdate(owned,{type:'crew:update:response',id:message.id,status:host.updater?.getStatus(),error:safe(error)});}})();
    });
    sendUpdate(owned,{type:'crew:update:status',status:host.updater?.getStatus()});
    let spawnFailure;
    owned.once('error', error => { spawnFailure = error; });
    owned.once('exit', () => {
      if (backend === owned) backend = undefined;
      backendReady = false;
      if (!quitting) { lastError = 'Local controller stopped. Inspect desktop.log, then reopen the project from the project switcher. Already dispatched workers were not canceled.'; updateTray(); void statusFile().catch(() => {}); }
    });
    for (let attempt = 0; attempt < 200; attempt++) {
      if (spawnFailure) throw spawnFailure;
      if (owned.exitCode !== null) throw new Error('Local controller could not start. Inspect desktop.log for the configuration or port error. No other server was stopped.');
      try {
        const marker = JSON.parse(await readFile(config.serverStatePath, 'utf8'));
        if (marker.pid === owned.pid && marker.configPath === config.configPath && marker.projectId === config.project.id && marker.port === config.port) {
          await api('config'); backendReady = true; break;
        }
      } catch {}
      await delay(100);
    }
    if (!backendReady) throw new Error('Local controller startup was not confirmed within 20 seconds. Inspect desktop.log before retrying.');
    const partition = session.fromPath(join(desktopData,'Partitions',`instance-${key}`));
    partition.setPermissionRequestHandler((contents, permission, callback, details) => callback(contents === window?.webContents && permitsAudio(permission, details, origin)));
    partition.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => contents === window?.webContents && permitsAudio(permission, { ...details, securityOrigin:requestingOrigin }, origin));
    partition.on('will-download', event => event.preventDefault());
    counts = summarizeTasks(await api('orchestration'));
    if (window && !window.isDestroyed()) await window.loadURL(origin); else if (showWindow && host.isSelected(id)) await openWindow();
    if (!pollTimer) pollTimer = setInterval(() => void poll(), 1500);
  } catch (error) {
    lastError = safe(error); console.error(lastError);
    if (window && !window.isDestroyed()) window.destroy(); window = undefined;
    if(host.isSelected(id)) await openSetup();
  } finally { starting = false; updateTray(); await statusFile().catch(() => {}); }
}
async function stopOwnedBackend() {
  if (!backend) return;
  const owned = backend;
  const marker = JSON.parse(await readFile(config.serverStatePath, 'utf8'));
  if (marker.pid !== owned.pid || marker.configPath !== config.configPath || marker.projectId !== config.project.id) throw new Error('Controller ownership changed. Quit was stopped; no unrelated process was signaled.');
  await api('disconnect', {}, 4000).catch(() => {});
  await api('shutdown', { token:marker.token });
  for (let attempt = 0; attempt < 150 && owned.exitCode === null; attempt++) await delay(100);
  if (owned.exitCode === null) throw new Error('Controller shutdown is still pending. Inspect desktop.log; this window will remain available.');
  backend = undefined; backendReady = false;
}
function sendUpdate(child,message){
  if(!child?.connected)return;
  try{child.send(message,error=>{if(error)console.error('Update status delivery failed.');});}catch{console.error('Update status delivery failed.');}
}
async function updateAction(action){
  try{
    if(action==='restart'){
      const result=await dialog.showMessageBox({type:'question',message:'Restart Crew to install the downloaded update?',detail:'Crew checks that this project is idle and other Crew instances are closed. Your local configuration, authentication, history and retained worktrees stay in place.',buttons:['Keep running','Restart to update'],defaultId:0,cancelId:0,noLink:true});
      if(result.response!==1)return;
    }
    await host.updater.request(action);
  }catch(error){await dialog.showMessageBox({type:'warning',message:'Crew update needs attention',detail:safe(error)});}
}
async function updateToken(route){
  if(!backendReady||!backend)throw new Error('Local controller is unavailable.');
  const marker=JSON.parse(await readFile(config.serverStatePath,'utf8'));
  if(marker.pid!==backend.pid||marker.configPath!==config.configPath||marker.projectId!==config.project.id)throw new Error('Controller ownership could not be verified.');
  return api(route,{token:marker.token});
}
// Setup and workspace surfaces expose separate bounded native bridges.
function projectDraftStatus(issues=[]) {const detail=issues.map(issue=>/teamId|teamKey/.test(issue)?'Choose your Linear team, or connect it later before assigning ticketed work.':/baseRef/.test(issue)?'Choose a starting branch for each project folder.':/path/.test(issue)?'Choose your local project folder.':issue);return {status:issues.length?'incomplete':'configured',detail:[...new Set(detail)].join(' ')||'Project settings are saved. Ticket access is checked when you ask for work.'};}
function microphoneStatus() {
  try { const status = systemPreferences.getMediaAccessStatus('microphone'); return ['granted','denied','restricted','not-determined'].includes(status) ? status : 'unknown'; }
  catch { return 'unknown'; }
}
async function setupSnapshot() {
  if(storage.issue)return {configPath,config:null,checks:{},microphone:microphoneStatus(),migration:storage,error:storage.issue};
  let value;
  try { value = await readSetupConfig(configPath); }
  catch (error) { return { configPath, config:null, missingConfig:error.code==='ENOENT', checks:{}, microphone:microphoneStatus(), controllerRunning:backendReady, error:`Cannot read configuration: ${safe(error)}. Open its JSON file to repair it, then reload setup.` }; }
  const currentInputs=await setupInputsKey(configPath);
  if ((setupRevision && setupRevision !== value.revision) || (setupInputs && setupInputs!==currentInputs)) {setupChecks = {};discoveryProposal=undefined;}
  setupRevision = value.revision;setupInputs=currentInputs;
  if(!discoveryRoot)discoveryRoot=value.config.project.repositories.find(r=>r.path)?.path;
  for(const repo of value.config.project.repositories.filter(r=>r.path))if(!repositoryOptions.has(repo.path)){let choice;try{choice=await discoverRepository({path:resolve(dirname(configPath),repo.path),env});}catch{choice={path:repo.path,name:repo.name,status:'unavailable',branches:[],detail:'This folder is unavailable. Choose its current location to reconnect it.'};}repositoryOptions.set(repo.path,choice);}
  const workerEnvironmentOptions=await Promise.all(value.config.project.repositories.map(async repo=>({...await discoverWorkerEnvironment({path:repo.path?resolve(dirname(configPath),repo.path):null,baseRef:repo.baseRef,env}),repositoryId:repo.id,path:repo.path,baseRef:repo.baseRef})));
  return { ...value, workerEnvironmentOptions, discoverySummary, linearOptions, repositoryOptions:[...repositoryOptions.values()], discoveryRoot, checks:setupChecks, microphone:microphoneStatus(), controllerRunning:backendReady, error:lastError };
}
async function openSetup() {
  if(!host.isSelected(id))return;
  if (setupWindow && !setupWindow.isDestroyed()) { setupWindow.show(); setupWindow.focus(); return; }
  const next = new BrowserWindow({width:1000,height:850,minWidth:560,minHeight:550,title:'Set up Crew',show:false,webPreferences:{preload:join(root,'desktop/setup-preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,partition:`setup-${key}`}});
  setupWindow = next;
  next.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  next.webContents.on('will-navigate',(event,url)=>{if(url!==setupURL)event.preventDefault();});
  next.webContents.on('will-attach-webview',event=>event.preventDefault());
  next.webContents.session.setPermissionRequestHandler((_c,_p,callback)=>callback(false));
  next.webContents.session.setPermissionCheckHandler(()=>false);
  next.webContents.session.on('will-download',event=>event.preventDefault());
  next.on('closed',()=>{discoveryController?.abort();if(setupWindow===next)setupWindow=undefined;});
  await next.loadURL(setupURL);next.show();
}
async function assertSetupInputs(inputs) {
  if(await setupInputsKey(configPath)!==inputs) {setupChecks={};throw new Error('Configuration or prompts changed during this check. Reload and retry; stale evidence was discarded.');}
}
async function checkRuntimeForSetup() {
  await setupSnapshot();
  const inputs=await setupInputsKey(configPath);
  const value = await checkLocalRuntime({root,configPath,env});
  await assertSetupInputs(inputs);
  if (setupRevision && setupRevision !== value.revision) setupChecks = {};
  setupRevision = value.revision; Object.assign(setupChecks,value.checks);lastError=null;
  return value;
}
async function checkAccountForSetup(startLogin=false) {
  const runtime = await checkRuntimeForSetup();
  if (!runtime.executable) throw new Error(runtime.checks.codex.detail);
  const inputs=await setupInputsKey(configPath);
  for(const key of ['protocol','auth','voices','tools'])delete setupChecks[key];
  const result = await probeCodex({executable:runtime.executable,root,env,startLogin,openLogin:url=>shell.openExternal(url)});
  await assertSetupInputs(inputs);Object.assign(setupChecks,result);return result;
}
async function bootstrap() {
  if(backendReady){if(host.isSelected(id))await openWindow();return;}
  try {
    if(storage.issue)throw new Error(storage.issue);
    try { await access(configPath); }
    catch(error) {
      if(error.code!=='ENOENT')throw error;
      if(flag>=0 || process.env.AI_MANAGER_CONFIG)throw new Error(`Configuration file not found: ${configPath}. Initialize this instance using the documented bundled CLI command.`);
      await new Promise((done,reject)=>{const init=spawn(process.execPath,[join(root,'cli.mjs'),'init','--template','set1','--config',configPath],{cwd:root,env,stdio:'ignore'});init.once('error',reject);init.once('exit',code=>code===0?done():reject(new Error('Could not create the editable template.')));});
    }
    const saved = await readSetupConfig(configPath);
    let existing = false;
    try { await access(join(resolve(dirname(configPath),saved.config.runtime.dataDir),'manager-chat.json'));existing=true; } catch {}
    let reviewed = false;
    try {const r=JSON.parse(await readFile(join(desktopData,'setup-review.json'),'utf8'));reviewed=r.revision===saved.revision;}catch{}
    if(existing || reviewed) await startup({showWindow:host.isSelected(id)}); else if(host.isSelected(id)) await openSetup();
  } catch(error) {lastError=safe(error);await openSetup();}
}
const handleSetup = async (event, action, input) => {
  if (!setupWindow || event.sender !== setupWindow.webContents || event.senderFrame !== setupWindow.webContents.mainFrame || event.senderFrame.url !== setupURL) throw new Error('Setup request rejected.');
  if (typeof action !== 'string') throw new Error('Invalid setup request.');
  // Serialize native checks/mutations. Snapshot is read-only and may run during a check.
  if (action === 'snapshot') return setupSnapshot();
  host.gate.assertSetupAllowed();
  if (action === 'cancel-discovery') {if(discoveryPhase==='saving')return {notice:'Your validated settings are already saving. Please wait for the result.'};discoveryController?.abort();return {notice:'Canceling project setup. Your saved settings stay unchanged.'};}
  if (setupOperation) throw new Error('Another setup action is still running. Wait for it to finish.');
  setupOperation = true;
  try {
    if(action==='storage-folder'){await shell.openPath(storage.crewRoot);return;}
    if(action==='storage-retry'||action==='storage-use'){
      if(!storage.issue)throw new Error('No storage recovery is pending.');
      let launchArgs=process.argv.slice(1);
      if(action==='storage-use'){const choices=[storage.newConfigPath,...storage.legacyConfigPaths];const selected=Number(input);if(!Number.isInteger(selected)||!choices[selected])throw new Error('Unknown recovery configuration.');await access(choices[selected]);launchArgs=[...(app.isPackaged?[]:[root]),'--config',choices[selected]];}
      await host.relaunch(launchArgs);return;
    }
    if(storage.issue)throw new Error(storage.issue);
    if(action==='initialize') {
      try {await access(configPath);throw new Error('Configuration already exists; reload or edit it. Nothing was overwritten.');}catch(error){if(error.code!=='ENOENT')throw error;}
      await new Promise((done,reject)=>{const init=spawn(process.execPath,[join(root,'cli.mjs'),'init','--template','set1','--config',configPath],{cwd:root,env,stdio:'ignore'});init.once('error',reject);init.once('exit',code=>code===0?done():reject(new Error('Could not create editable template; inspect the selected configuration folder.')));});
      lastError=null;return setupSnapshot();
    }
    if(action==='choose-discovery') {
      const selected=await dialog.showOpenDialog(setupWindow,{title:'Choose a project to analyze (read-only)',defaultPath:discoveryRoot||app.getPath('home'),properties:['openDirectory']});
      if(!selected.canceled){const choice=await discoverRepository({path:selected.filePaths[0],env});if(choice.status!=='verified')throw Error(choice.detail);discoveryRoot=choice.path;repositoryOptions.set(choice.path,choice);discoveryProposal=undefined;discoverySummary=undefined;}
      return setupSnapshot();
    }
    if(action==='discover') {
      if(!discoveryRoot)throw new Error('Choose a local project folder first.');
      const before=await readSetupConfig(configPath), inputs=await setupInputsKey(configPath);
      discoveryController=new AbortController();discoveryPhase='analyzing';
      try {
      const runtime=await checkRuntimeForSetup();
      if(!runtime.executable)throw new Error(runtime.checks.codex.detail);
      await checkAccountForSetup();
      if(setupChecks.auth?.status!=='verified')throw new Error('ChatGPT sign-in is required for optional project analysis.');
      if(discoveryController.signal.aborted)throw new Error('Project analysis canceled. Active configuration is unchanged.');
        const [proposal,repository,linear]=await Promise.all([
          discoverProject({repositoryRoot:discoveryRoot,codexBinary:runtime.executable,env,signal:discoveryController.signal}),
          discoverRepository({path:discoveryRoot,env}),
          discoverLinearOptions({executable:runtime.executable,root,env,signal:discoveryController.signal}).catch(error=>({status:'unavailable',detail:safe(error),teams:[],projects:[]}))
        ]);
        await assertSetupInputs(inputs);
        if(discoveryController.signal.aborted)throw Error('Project setup canceled. Your saved settings are unchanged.');
        linearOptions=linear;repositoryOptions.set(repository.path,repository);
        const token=randomUUID(),promptDirectory=join('prompts',`discovery-${token}`);
        const currentRepository=before.config.project.repositories.find(r=>r.path===repository.path);
        if(currentRepository?.baseRef){try{await verifyReference({path:repository.path,ref:currentRepository.baseRef,env});repository.verifiedExistingRef=currentRepository.baseRef;}catch{}}
        const draft=composeProjectSetup({proposal,current:before.config,repository,linear});
        {const execution=await discoverWorkerEnvironment({path:repository.path,baseRef:draft.project.repositories[0]?.baseRef,env}),saved=draft.project.worker?.environment?.executionPlan;if(saved&&execution.plan){const action=execution.actions.find(item=>item.command===saved.start?.command);draft.project.worker.environment={executionPlan:selectExecutionPlan({discovered:execution.plan,saved,action})};}else if(!Object.keys(draft.project.worker?.environment||{}).length&&execution.plan&&(execution.plan.setup||execution.plan.start))draft.project.worker.environment={executionPlan:execution.plan};}
        if(draft.project.worker?.environment?.executionPlan){const options=await Promise.all(draft.project.repositories.map(async repo=>({...await discoverWorkerEnvironment({path:repo.path,baseRef:repo.baseRef,env}),repositoryId:repo.id,path:repo.path,baseRef:repo.baseRef})));assertWorkerEnvironmentSelection(draft,options);}
        try {await access(join(resolve(dirname(configPath),before.config.runtime.dataDir),'orchestration/instance-project.json'));draft.project.id=before.config.project.id;}catch{}
        try {await access(join(resolve(dirname(configPath),before.config.runtime.dataDir),'manager-chat.json'));draft.project.id=before.config.project.id;}catch{}
        draft.project.prompts={manager:join(promptDirectory,'manager.md'),worker:join(promptDirectory,'worker.md')};
        const inside=relative(repository.path,resolve(dirname(configPath),promptDirectory));
        if(!inside || (inside!=='..'&&!inside.startsWith(`..${sep}`)&&!isAbsolute(inside)))throw Error('Crew settings must be outside the project folder. Choose a separate configuration location.');
        await host.validateCandidate(id,configPath,draft);
        const wasRunning=backendReady;
        if(backend&&!backendReady)throw Error('The manager is still starting. Wait, then try again.');
        if(wasRunning){await poll();const state=await api('state');if(counts.active!==0||state.activeTurnId||state.voiceActive||state.voiceConnecting)throw Error('Finish active work and disconnect voice before updating this project. Your saved settings are unchanged.');await stopOwnedBackend();}
        try {
          if(discoveryController.signal.aborted)throw Error('Project setup canceled. Your saved settings are unchanged.');
          await assertSetupInputs(inputs);discoveryPhase='saving';
          const applied=await applyDiscoveryDraft({root,configPath,env,revision:before.revision,config:draft,managerDraft:proposal.managerDraft,workerDraft:proposal.workerDraft,promptDirectory});
          await host.configured(id,before.config.project.name,applied.config.project.name);
          setupRevision=applied.revision;setupInputs=await setupInputsKey(configPath);setupChecks={project:projectDraftStatus(applied.issues)};lastError=null;
          discoveryRoot=repository.path;
          discoverySummary={name:draft.project.name,path:repository.path,branch:draft.project.repositories[0].baseRef,sources:proposal.evidence.sources,truncated:proposal.evidence.truncated,findings:proposal.findings,questions:proposal.confirmations};
        } finally {if(wasRunning)await startup({showWindow:false});}
        return setupSnapshot();
      } finally {discoveryController=undefined;discoveryPhase=undefined;}
    }
    if(action==='linear-options') {
      const runtime=await checkRuntimeForSetup();if(!runtime.executable)throw Error(runtime.checks.codex.detail);
      const inputs=await setupInputsKey(configPath);
      const next=await discoverLinearOptions({executable:runtime.executable,root,env,teamId:typeof input==='string'?input:undefined});
      await assertSetupInputs(inputs);linearOptions=next;return setupSnapshot();
    }
    if(action==='repository-options') {
      if(typeof input!=='string'||input.length>4096)throw Error('Choose a local folder first.');
      const choice=await discoverRepository({path:input,env});if(choice.status!=='verified')throw Error(choice.detail);repositoryOptions.set(choice.path,choice);return choice;
    }
    if(action==='runtime') {await checkRuntimeForSetup();return setupSnapshot();}
    if(action==='account' || action==='login') {await checkAccountForSetup(action==='login');return setupSnapshot();}
    if(action==='save') {
      if(backend && !backendReady)throw new Error('Controller startup/shutdown is still pending. Quit this instance safely before editing configuration.');
      if(!input || typeof input.revision!=='string')throw new Error('Reload configuration before saving.');
      for(const repo of input.config?.project?.repositories||[])if(repo.path&&repo.baseRef)await verifyReference({path:repo.path,ref:repo.baseRef,env});
      if(input.config?.project?.worker?.environment?.executionPlan){const options=await Promise.all(input.config.project.repositories.map(async repo=>({...await discoverWorkerEnvironment({path:repo.path,baseRef:repo.baseRef,env}),repositoryId:repo.id,path:repo.path,baseRef:repo.baseRef})));assertWorkerEnvironmentSelection(input.config,options);}
      assertLinearSelection(input.config?.project?.linear||{},linearOptions);
      await host.validateCandidate(id,configPath,input.config);
      const options={root,configPath,input:input.config,revision:input.revision,env};
      await saveSetupConfig({...options,dryRun:true});
      const wasRunning=backendReady;
      if(wasRunning) {
        await poll();const state=await api('state');
        if(counts.active!==0 || state.activeTurnId || state.voiceActive || state.voiceConnecting)throw new Error('Finish active work and disconnect voice before applying configuration. No controller or files were changed.');
        await stopOwnedBackend();
      }
      try {const previousName=(await readSetupConfig(configPath)).config.project.name;const saved=await saveSetupConfig(options);await host.configured(id,previousName,saved.config.project.name);setupRevision=saved.revision;setupInputs=await setupInputsKey(configPath);setupChecks={project:projectDraftStatus(saved.issues)};lastError=null;}
      finally {if(wasRunning)await startup({showWindow:false});}
      return setupSnapshot();
    }
    if(action==='paths') {const inputs=await setupInputsKey(configPath);delete setupChecks.paths;const result=await probePaths({root,configPath,env});await assertSetupInputs(inputs);setupChecks.paths=result;return setupSnapshot();}
    if(action==='microphone') {
      if(process.platform!=='darwin')throw new Error('Use your operating system microphone settings. Status is unknown on this platform.');
      await requestMicrophonePermission({getStatus:microphoneStatus,ask:()=>systemPreferences.askForMediaAccess('microphone')});
      return setupSnapshot();
    }
    if(action==='choose-repository' || action==='choose-codex') {
      const result=await dialog.showOpenDialog(setupWindow,{title:action==='choose-repository'?'Choose this project’s repository folder':'Choose the Codex executable',properties:action==='choose-repository'?['openDirectory']:['openFile','showHiddenFiles']});
      return result.canceled?null:result.filePaths[0];
    }
    if(action==='settings') {
      const panes={microphone:'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',files:'x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders',network:'x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork'};
      if(!Object.hasOwn(panes,input))throw new Error('Unknown privacy settings page.');await shell.openExternal(panes[input]);return {notice:'Opened macOS privacy settings. Availability depends on your macOS version. Retry the relevant check after changing access; a restart may be needed.'};
    }
    if(action==='open-config'){await shell.openPath(configPath);return;}
    if(action==='open-prompts'){await shell.openPath(dirname(configPath));return;}
    if(action==='help'){await shell.openExternal('https://developers.openai.com/codex/quickstart');return;}
    if(action==='launch') {
      if(backendReady) {await openWindow();setupWindow?.close();return;}
      const runtime=await checkRuntimeForSetup();
      if(runtime.checks.codex.status!=='verified'||runtime.checks.git.status!=='verified')throw new Error('Install or configure Codex and Git, then retry.');
      await checkAccountForSetup();
      if(setupChecks.auth?.status!=='verified')throw new Error('ChatGPT sign-in is required before opening the manager.');
      // Project/voice/tool/permission gaps stay visible and do not become a false complete flag.
      await startup();
      if(!backendReady)throw new Error(lastError||'Controller startup was not confirmed.');
      await writeFile(join(desktopData,'setup-review.json'),JSON.stringify({revision:runtime.revision,reviewedAt:new Date().toISOString(),projectConfigured:setupChecks.project?.status==='configured',voiceCatalogVerified:setupChecks.voices?.status==='verified',microphone:microphoneStatus(),businessAccessVerified:false})+'\n',{mode:0o600});
      setupWindow?.close();return;
    }
    throw new Error('Unknown setup action.');
  } catch(error) {
    if(action==='discover' && /cancel(?:ed|led)/i.test(String(error.message)))return {...await setupSnapshot(),notice:'Project analysis canceled. Active configuration is unchanged.'};
    throw new Error(safe(error));
  }
  finally {setupOperation=false;}
};

  return {
    id, configPath, bootstrap, startup, openWindow, openSetup, poll, handleSetup, updateToken,
    setError:message=>{lastError=message;},
    api, stop:stopOwnedBackend,
    acceptsSetup:sender=>Boolean(setupWindow && sender===setupWindow.webContents),
    acceptsWorkspace:(event)=>Boolean(window && event.sender===window.webContents && event.senderFrame===window.webContents.mainFrame && isAppURL(event.senderFrame.url,origin)),
    snapshot:()=>({id, name:config?.project.name, ready:backendReady, error:lastError, ...counts}),
    busy:()=>Boolean(discoveryController||setupOperation||starting||closing),
    backendPid:()=>backend?.pid,
    logsDirectory:()=>config?.dataDir,
    notify:value=>{if(window&&!window.isDestroyed())window.webContents.send('crew:workspaces:changed',value);},
    broadcastUpdate:status=>sendUpdate(backend,{type:'crew:update:status',status}),
    async hide(){
      if(discoveryController||setupOperation||starting||closing)throw Error('Finish the current project setup or window action before switching projects.');
      if(backendReady)await api('disconnect',{},4000);
      // Destroying this renderer releases physical tracks, SSE, and project-local drafts.
      if(window&&!window.isDestroyed()){closing=true;window.destroy();window=undefined;closing=false;}
      if(setupWindow&&!setupWindow.isDestroyed())setupWindow.destroy();
      await statusFile().catch(()=>{});
    },
    async quit(){quitting=true;discoveryController?.abort();clearInterval(pollTimer);await stopOwnedBackend();window?.destroy();setupWindow?.destroy();await statusFile().catch(()=>{});},
    async cancelUpdate(){quitting=false;if(backendReady)await updateToken('update-cancel');else if(stoppedForUpdate&&!backend)await startup({showWindow:host.isSelected(id)});stoppedForUpdate=false;},
    async stopForUpdate(){stoppedForUpdate=backendReady;quitting=true;clearInterval(pollTimer);pollTimer=undefined;await stopOwnedBackend();}
  };
}
