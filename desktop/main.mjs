// AI-007: the main process owns the local backend; windows own only voice/UI.
import { app, BrowserWindow, Tray, Menu, nativeImage, dialog, shell, session, ipcMain, systemPreferences } from 'electron';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, open, access, rename } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readSetupConfig, saveSetupConfig, checkLocalRuntime, probeCodex, probePaths, setupInputsKey, applyDiscoveryDraft, requestMicrophonePermission } from './setup-service.mjs';
import { discoverProject } from '../project-discovery.mjs';
import {discoverRepository,discoverLinearOptions,verifyReference} from './project-options.mjs';
import {composeProjectSetup,assertLinearSelection} from './project-setup.mjs';
import { randomUUID } from 'node:crypto';
import { relative, sep, isAbsolute } from 'node:path';
import { prepareCrewStorage } from './storage.mjs';
import { loadAppConfig } from '../config.mjs';
import { instanceKey, summarizeTasks, isAppURL, isExternalHTTPS, permitsAudio, childEnvironment } from './lifecycle.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(app.isPackaged ? 1 : 2);
const flag = args.indexOf('--config');
if (flag >= 0 && (!args[flag + 1] || args[flag + 1].startsWith('--'))) { console.error('--config requires an existing config path.'); app.exit(1); }
const configOverride=flag>=0?args[flag+1]:process.env.AI_MANAGER_CONFIG||null;
const storage=await prepareCrewStorage({appData:app.getPath('appData'),configOverride});
const configPath=storage.configPath,key=storage.key,desktopData=storage.desktopData;
mkdirSync(desktopData, { recursive:true, mode:0o700 });
app.setPath('userData', desktopData);
app.setPath('sessionData',desktopData);
mkdirSync(join(desktopData,'crash-dumps'),{recursive:true,mode:0o700});
app.setPath('crashDumps',join(desktopData,'crash-dumps'));
app.setAppLogsPath(join(desktopData,'logs'));
app.setName('Crew');
const locked = app.requestSingleInstanceLock({ configPath });
let discoveryController, discoveryRoot, discoveryProposal, discoverySummary, linearOptions, discoveryPhase;
const repositoryOptions=new Map();
let setupWindow, setupChecks = {}, setupRevision, setupInputs, setupOperation = false;
let window, tray, config, origin, backend, pollTimer, starting = false, quitting = false, closing = false;
let counts = { active: null, pending: null }, lastError = null, backendReady = false;
const env = childEnvironment(configPath);
const setupURL = pathToFileURL(join(root, 'desktop/setup.html')).href;
const delay = ms => new Promise(done => setTimeout(done, ms));
const safe = error => String(error?.message || error).replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').replace(/sk-[\w-]+/g, '[redacted]').slice(0, 1400);
const escape = text => String(text).replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
async function statusFile() {
  if (!config) return;
  const target = join(config.dataDir, 'desktop-status.json');
  const value = { pid: process.pid, backendPid: backend?.exitCode === null ? backend.pid : null, configPath, projectId: config.project.id, port: config.port, backendReady, windowOpen: Boolean(window && !window.isDestroyed()), windowCount: window && !window.isDestroyed() ? 1 : 0, isQuitting:quitting, pendingCount:counts.pending, activeCount:counts.active, ...counts, error: lastError, updatedAt: new Date().toISOString() };
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
function trayIcon(pending) {
  // Native monochrome bitmap; nativeImage does not decode SVG reliably.
  const width = 22, height = 22, pixels = Buffer.alloc(width * height * 4);
  const paint = (x, y) => { pixels[(y * width + x) * 4 + 3] = 255; };
  for (let y = 3; y < 15; y++) for (let x = 6; x < 16; x++) paint(x, y);
  for (let y = 15; y < 19; y++) for (let x = 9; x < 13; x++) paint(x, y);
  if (pending) for (let y = 0; y < 7; y++) for (let x = 15; x < 22; x++) if ((x - 18) ** 2 + (y - 3) ** 2 <= 9) paint(x, y);
  const icon = nativeImage.createFromBitmap(pixels, { width, height, scaleFactor:1 });
  icon.setTemplateImage(true); return icon;
}
function updateTray() {
  if (!tray) return;
  const project = config?.project.name || 'Setup';
  const attention = counts.pending === null ? 'Attention unavailable' : `${counts.pending} pending attention item${counts.pending === 1 ? '' : 's'}`;
  tray.setImage(trayIcon(Boolean(counts.pending)));
  tray.setTitle(counts.pending ? `✋ ${counts.pending}` : '');
  tray.setToolTip(`${project} — ${attention}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label:`Open ${project}`, click:() => void openWindow() },
    { label:backendReady ? attention : lastError ? 'Startup needs attention' : 'Starting…', enabled:false },
    { label:counts.active === null ? 'Worker status unavailable' : `${counts.active} active task${counts.active === 1 ? '' : 's'}`, enabled:false },
    { type:'separator' },
    { label:'Set up Crew…', click:() => void openSetup() },
    { label:'Edit project configuration…', click:() => void shell.openPath(configPath) },
    { label:'Open configuration folder', click:() => void shell.openPath(dirname(configPath)) },
    { label:'Open logs folder', enabled:Boolean(config), click:() => void shell.openPath(config.dataDir) },
    { label:'Retry startup', enabled:!backendReady && !starting && !backend, click:() => void startup() },
    { type:'separator' }, { label:'Quit this instance…', click:() => void quitInstance() }
  ]));
}
async function openWindow() {
  if (!backendReady) return openSetup();
  if (window && !window.isDestroyed()) { window.show(); window.focus(); return; }
  const next = new BrowserWindow({ width:1050, height:850, minWidth:540, minHeight:500, title:`${config?.project.name || 'Setup'} — Crew`, show:false,
    webPreferences:{ nodeIntegration:false, contextIsolation:true, sandbox:true, webSecurity:true, allowRunningInsecureContent:false, partition:`persist:instance-${key}` }
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
  else await next.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><meta charset="utf-8"><title>Crew setup</title><style>body{font:17px system-ui;max-width:760px;margin:72px auto;padding:24px;line-height:1.6;background:#f7f8fc;color:#182033}code{overflow-wrap:anywhere}</style><h1>${lastError ? 'Setup needs attention' : 'Starting Crew'}</h1><p>${escape(lastError || 'Starting the local controller. Microphone is off.')}</p><p>Configuration: <code>${escape(configPath)}</code></p><p>Use the menu-bar icon to edit configuration, open logs, or retry startup. Each instance handles one project. No work starts automatically.</p>`)}`);
  next.show(); await statusFile().catch(() => {});
}
async function poll() {
  if (!backendReady || quitting) return;
  try { const view = await api('orchestration'); counts = summarizeTasks(view); lastError = view.error ? safe(view.error) : null; }
  catch (error) { counts = { active:null, pending:null }; lastError = safe(error); }
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
    try { backend = spawn(process.execPath, [join(root, 'server.mjs')], { cwd:root, env, stdio:['ignore', log.fd, log.fd] }); }
    finally { await log.close(); }
    const owned = backend;
    let spawnFailure;
    owned.once('error', error => { spawnFailure = error; });
    owned.once('exit', () => {
      if (backend === owned) backend = undefined;
      backendReady = false;
      if (!quitting) { lastError = 'Local controller stopped. Inspect desktop.log, then retry startup from the menu-bar icon. Already dispatched workers were not canceled.'; updateTray(); void statusFile().catch(() => {}); }
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
    const partition = session.fromPartition(`persist:instance-${key}`);
    partition.setPermissionRequestHandler((contents, permission, callback, details) => callback(contents === window?.webContents && permitsAudio(permission, details, origin)));
    partition.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => contents === window?.webContents && permitsAudio(permission, { ...details, securityOrigin:requestingOrigin }, origin));
    partition.on('will-download', event => event.preventDefault());
    counts = summarizeTasks(await api('orchestration'));
    if (window && !window.isDestroyed()) await window.loadURL(origin); else if (showWindow) await openWindow();
    if (!pollTimer) pollTimer = setInterval(() => void poll(), 1500);
  } catch (error) {
    lastError = safe(error); console.error(lastError);
    if (window && !window.isDestroyed()) window.destroy(); window = undefined;
    await openSetup();
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
async function quitInstance() {
  if (quitting) return;
  await poll();
  const active = counts.active;
  const warning = discoveryController ? 'A setup project analysis is running. Quitting will cancel this analysis without applying its draft.' : active === null ? 'Worker status is unavailable.' : active ? `${active} task${active === 1 ? ' is' : 's are'} still active.` : 'There are no active tasks.';
  const result = await dialog.showMessageBox({ type:active === 0 ? 'question' : 'warning', title:'Quit this instance?', message:'Quit Crew?', detail:`${warning}\n\nClosing the window keeps the controller running. Quitting stops this instance’s controller and voice. Independently launched workers are not canceled; their reports can be reviewed when this instance starts again. No new work starts until you reopen it.`, buttons:['Keep running', 'Quit this instance'], defaultId:0, cancelId:0, noLink:true });
  if (result.response !== 1) return;
  quitting = true; discoveryController?.abort(); clearInterval(pollTimer);
  try {
    await stopOwnedBackend();
    if (window && !window.isDestroyed()) window.destroy();
    if (setupWindow && !setupWindow.isDestroyed()) setupWindow.destroy();
    await statusFile().catch(() => {}); tray?.destroy(); app.quit();
  } catch (error) {
    quitting = false; lastError = safe(error); pollTimer = setInterval(() => void poll(), 1500); updateTray();
    await dialog.showMessageBox({ type:'error', message:'Could not finish quitting', detail:lastError });
  }
}
// Setup uses a separate trusted local page. The manager renderer has no preload.
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
  return { ...value, discoverySummary, linearOptions, repositoryOptions:[...repositoryOptions.values()], discoveryRoot, checks:setupChecks, microphone:microphoneStatus(), controllerRunning:backendReady, error:lastError };
}
async function openSetup() {
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
    if(existing || reviewed) await startup(); else await openSetup();
  } catch(error) {lastError=safe(error);await openSetup();}
}
ipcMain.handle('crew:setup', async (event, action, input) => {
  if (!setupWindow || event.sender !== setupWindow.webContents || event.senderFrame !== setupWindow.webContents.mainFrame || event.senderFrame.url !== setupURL) throw new Error('Setup request rejected.');
  if (typeof action !== 'string') throw new Error('Invalid setup request.');
  // Serialize native checks/mutations. Snapshot is read-only and may run during a check.
  if (action === 'snapshot') return setupSnapshot();
  if (action === 'cancel-discovery') {if(discoveryPhase==='saving')return {notice:'Your validated settings are already saving. Please wait for the result.'};discoveryController?.abort();return {notice:'Canceling project setup. Your saved settings stay unchanged.'};}
  if (setupOperation) throw new Error('Another setup action is still running. Wait for it to finish.');
  setupOperation = true;
  try {
    if(action==='storage-folder'){await shell.openPath(storage.crewRoot);return;}
    if(action==='storage-retry'||action==='storage-use'){
      if(!storage.issue)throw new Error('No storage recovery is pending.');
      let launchArgs=process.argv.slice(1);
      if(action==='storage-use'){const choices=[storage.newConfigPath,...storage.legacyConfigPaths];const selected=Number(input);if(!Number.isInteger(selected)||!choices[selected])throw new Error('Unknown recovery configuration.');await access(choices[selected]);launchArgs=[...(app.isPackaged?[]:[root]),'--config',choices[selected]];}
      quitting=true;app.relaunch({args:launchArgs});app.exit(0);return;
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
        try {await access(join(resolve(dirname(configPath),before.config.runtime.dataDir),'orchestration/instance-project.json'));draft.project.id=before.config.project.id;}catch{}
        try {await access(join(resolve(dirname(configPath),before.config.runtime.dataDir),'manager-chat.json'));draft.project.id=before.config.project.id;}catch{}
        draft.project.prompts={manager:join(promptDirectory,'manager.md'),worker:join(promptDirectory,'worker.md')};
        const inside=relative(repository.path,resolve(dirname(configPath),promptDirectory));
        if(!inside || (inside!=='..'&&!inside.startsWith(`..${sep}`)&&!isAbsolute(inside)))throw Error('Crew settings must be outside the project folder. Choose a separate configuration location.');
        const wasRunning=backendReady;
        if(backend&&!backendReady)throw Error('The manager is still starting. Wait, then try again.');
        if(wasRunning){await poll();const state=await api('state');if(counts.active!==0||state.activeTurnId||state.voiceActive||state.voiceConnecting)throw Error('Finish active work and disconnect voice before updating this project. Your saved settings are unchanged.');await stopOwnedBackend();}
        try {
          if(discoveryController.signal.aborted)throw Error('Project setup canceled. Your saved settings are unchanged.');
          await assertSetupInputs(inputs);discoveryPhase='saving';
          const applied=await applyDiscoveryDraft({root,configPath,env,revision:before.revision,config:draft,managerDraft:proposal.managerDraft,workerDraft:proposal.workerDraft,promptDirectory});
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
      assertLinearSelection(input.config?.project?.linear||{},linearOptions);
      const options={root,configPath,input:input.config,revision:input.revision,env};
      await saveSetupConfig({...options,dryRun:true});
      const wasRunning=backendReady;
      if(wasRunning) {
        await poll();const state=await api('state');
        if(counts.active!==0 || state.activeTurnId || state.voiceActive || state.voiceConnecting)throw new Error('Finish active work and disconnect voice before applying configuration. No controller or files were changed.');
        await stopOwnedBackend();
      }
      try {const saved=await saveSetupConfig(options);setupRevision=saved.revision;setupInputs=await setupInputsKey(configPath);setupChecks={project:projectDraftStatus(saved.issues)};lastError=null;}
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
});
if (!locked) { app.quit(); }
else {
  app.on('second-instance', () => void openWindow());
  app.on('activate', () => { if (setupWindow && !setupWindow.isDestroyed()) { setupWindow.show(); setupWindow.focus(); } else void openWindow(); });
  app.on('window-all-closed', () => { /* Tray and backend intentionally keep running. */ });
  app.on('before-quit', event => { if (!quitting) { event.preventDefault(); void quitInstance(); } });
  // Do not hold ESM entry evaluation open waiting for Electron's ready event.
  // Electron can defer ready until the entry module finishes evaluating.
  void app.whenReady().then(async () => {
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label:'Crew', submenu:[{ label:'About Crew', role:'about' }, { label:'Set up Crew…', click:() => void openSetup() }, { type:'separator' }, { label:'Open window', click:() => void openWindow() }, { label:'Quit this instance…', accelerator:'Command+Q', click:() => void quitInstance() }] }, { label:'Edit', submenu:[{ role:'undo' }, { role:'redo' }, { type:'separator' }, { role:'cut' }, { role:'copy' }, { role:'paste' }, { role:'selectAll' }] }, { label:'Window', submenu:[{ role:'minimize' }, { role:'close' }] }]));
  tray = new Tray(trayIcon(false)); updateTray();
  await bootstrap();
  }).catch(error => { console.error(safe(error)); app.exit(1); });
}
