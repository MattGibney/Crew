// Issue #2: one native identity, one selected surface, isolated project controllers.
import {app,Tray,Menu,nativeImage,dialog,ipcMain,shell} from 'electron';
import {mkdir,readFile,writeFile,rename,access,realpath} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {prepareCrewStorage} from './storage.mjs';
import {instanceKey,childEnvironment} from './lifecycle.mjs';
import {createProjectHost} from './project-host.mjs';
import {workspaceUpdateActivity,createWorkspaceUpdateReservation} from './workspace-update.mjs';
import {assertWorkspaceIsolation} from './workspace-isolation.mjs';
import {openWorkspaceRegistry} from './workspace-registry.mjs';
import {configureGlobalCapacity} from '../global-capacity.mjs';
import {loadAppConfig} from '../config.mjs';
import {createUpdateCoordinator,createNativeUpdateGate,createInstallLease,createRestartHandoff,signedUpdateSupport,otherNativeInstances} from './updater.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const args=process.argv.slice(app.isPackaged?1:2),flag=args.indexOf('--config');
if(flag>=0&&(!args[flag+1]||args[flag+1].startsWith('--')))throw Error('--config requires a config path.');
// Isolated acceptance/portable profiles opt in explicitly; no user files are copied.
const appData=process.env.CREW_APP_DATA||app.getPath('appData');
const crewRoot=join(appData,'Crew'),updatesDirectory=join(crewRoot,'updates');
const restartHandoff=createRestartHandoff({directory:updatesDirectory});
const explicit=args[flag+1]&&flag>=0?args[flag+1]:process.env.AI_MANAGER_CONFIG||null;
const restarted=await restartHandoff.consume(app.getVersion(),explicit);
const storage=await prepareCrewStorage({appData,configOverride:explicit||restarted});
// The common private root also lets Chromium's network sandbox access each
// explicitly retained project partition beneath desktop/<identity>.
const nativeData=crewRoot;
await mkdir(nativeData,{recursive:true,mode:0o700});
app.setPath('userData',nativeData);app.setPath('sessionData',nativeData);app.setName('Crew');
const locked=app.requestSingleInstanceLock({configPath:explicit||restarted?storage.configPath:null});
let registry,tray,updater,quitting=false,transition=false,changedTimer;
const hosts=new Map(),capacityDirectory=join(crewRoot,'capacity');
const safe=error=>String(error?.message||error).replace(/Bearer\s+\S+/gi,'Bearer [redacted]').replace(/sk-[\w-]+/g,'[redacted]').slice(0,1400);
const selected=()=>hosts.get(registry?.snapshot().selectedId);
const gate=createNativeUpdateGate({busy:()=>Boolean(transition||quitting||[...hosts.values()].some(h=>h.busy()))});
const lease=createInstallLease({directory:updatesDirectory});
let cancelHandoff,updateReservation,updateRecoveryError;
const reservationPath=join(updatesDirectory,'workspace-reservation.json');
async function reservationPending(){try{await access(reservationPath);return true;}catch(error){return error.code!=='ENOENT';}}
async function assertRegistrationAllowed(){if(updateRecoveryError||await reservationPending())throw Error('Resolve the interrupted update before adding another project. Existing project setup remains available.');}
async function recordReservationFailure(error){if(await reservationPending()){updateRecoveryError=safe(error);changed();}}
async function configuredProjects(){const projects=[];for(const p of registry.snapshot().projects){try{await access(p.configPath);projects.push(p);}catch(error){if(error.code!=='ENOENT')throw error;}}return projects;}
async function validateWorkspaces(candidate){const projects=await configuredProjects();if(candidate&&!projects.some(p=>p.id===candidate.id))projects.push({id:candidate.id,configPath:candidate.configPath});return projects.length?assertWorkspaceIsolation({projects,candidate}):[];}
const projectHosts=()=>registry.snapshot().projects.map(p=>({...p,host:hosts.get(p.id)}));
function snapshot(){
  const value=registry.snapshot();
  return {...value,projects:value.projects.map(project=>{const state=hosts.get(project.id)?.snapshot();return {id:project.id,name:project.name,pending:state?.pending??null,active:state?.active??null,ready:Boolean(state?.ready),error:state?.error||null};})};
}
function changed(){
  if(!registry)return;
  // Polls from multiple controllers coalesce into one native/UI notification.
  if(changedTimer)return;
  changedTimer=setTimeout(()=>{changedTimer=undefined;updateTray();for(const host of hosts.values())host.notify(snapshot());},30);
}
function trayIcon(pending){
  const width=22,height=22,pixels=Buffer.alloc(width*height*4);
  const paint=(x,y)=>{pixels[(y*width+x)*4+3]=255;};
  for(let y=3;y<15;y++)for(let x=6;x<16;x++)paint(x,y);
  for(let y=15;y<19;y++)for(let x=9;x<13;x++)paint(x,y);
  if(pending)for(let y=0;y<7;y++)for(let x=15;x<22;x++)if((x-18)**2+(y-3)**2<=9)paint(x,y);
  const icon=nativeImage.createFromBitmap(pixels,{width,height,scaleFactor:1});icon.setTemplateImage(true);return icon;
}
const attempt=fn=>void Promise.resolve().then(fn).catch(error=>dialog.showMessageBox({type:'warning',message:'Crew needs attention',detail:safe(error)}));
function updateTray(){
  if(!tray||!registry)return;
  const view=snapshot(),pending=view.projects.reduce((sum,p)=>sum+(p.pending||0),0);
  tray.setImage(trayIcon(pending));tray.setTitle(pending?`✋ ${pending}`:'');tray.setToolTip(`Crew — ${pending} pending attention item${pending===1?'':'s'}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    {label:'Open Crew',click:()=>attempt(()=>selected().openWindow())},
    {label:pending?'Projects needing attention':'No pending attention',enabled:false},
    ...view.projects.filter(p=>p.pending||p.error).map(p=>({label:`${p.name} — ${p.pending?`${p.pending} need attention`:'Needs setup'}`,click:()=>attempt(()=>selectProject(p.id))})),
    {type:'separator'},
    ...view.projects.map(p=>({label:p.name,type:'radio',checked:p.id===view.selectedId,click:()=>attempt(()=>selectProject(p.id))})),
    {label:'Add project…',click:()=>attempt(addProject)},
    {label:'Project setup…',click:()=>attempt(()=>selected().openSetup())},
    {label:'Edit project configuration…',click:()=>attempt(()=>shell.openPath(selected().configPath))},
    {label:'Open configuration folder',click:()=>attempt(()=>shell.openPath(dirname(selected().configPath)))},
    {label:'Open logs folder',enabled:Boolean(selected()?.logsDirectory()),click:()=>attempt(()=>shell.openPath(selected().logsDirectory()))},
    {label:'Retry project startup',enabled:!selected()?.snapshot().ready&&!selected()?.busy(),click:()=>attempt(()=>selected().startup())},
    {type:'separator'},
    {label:'Check for updates…',enabled:Boolean(updater),click:()=>attempt(()=>updater.request('check'))},
    {label:'Download update',enabled:updater?.getStatus().phase==='available',click:()=>attempt(()=>updater.request('download'))},
    {label:'Resolve interrupted update…',visible:Boolean(updateRecoveryError),click:()=>attempt(resolveUpdateRecovery)},
    {label:'Restart to update…',enabled:updater?.getStatus().phase==='downloaded',click:()=>attempt(()=>updater.request('restart'))},
    {type:'separator'},{label:'Quit Crew…',click:()=>attempt(quitCrew)}
  ]));
}
function register(project){
  const runtime=createProjectHost({root,storage:{...storage,...project,issue:project.configPath===storage.configPath?storage.issue:null},host:{
    capacityDirectory,gate,configured:async(id,previousName,name)=>{const project=registry.snapshot().projects.find(p=>p.id===id);if(project&&(project.name===previousName||project.name==='Your project')&&project.name!==name){await registry.rename(id,name);changed();}},validateAll:()=>configureCapacity(),validateCandidate:(id,configPath,config)=>validateWorkspaces({id,configPath,config}),relaunch:async launchArgs=>{quitting=true;for(const h of hosts.values())await h.quit();app.relaunch({args:launchArgs});app.exit(0);},get updater(){return updater;},changed,isSelected:id=>registry.snapshot().selectedId===id
  }});
  hosts.set(project.id,runtime);return runtime;
}
async function configureCapacity(limit=registry.snapshot().workerLimit){
  await validateWorkspaces();
  const stateDirs=[];const identities=new Map(),ports=new Map();
  for(const project of registry.snapshot().projects){
    try{
      const env=childEnvironment(project.configPath);delete env.AI_MANAGER_PORT;delete env.VOICE_PORT;
      const config=await loadAppConfig({root,configPath:project.configPath,env,checkRuntime:false});
      for(const [map,key,label] of [[identities,config.projectStateDir,'state folder'],[ports,config.port,'port']]){
        if(map.has(key))throw Error(`Projects ${map.get(key)} and ${project.name} share a ${label}. Correct configuration before starting Crew.`);map.set(key,project.name);
      }
      stateDirs.push(config.projectStateDir);
    }catch(error){if(!String(error.message).startsWith('Configuration:'))throw error;}
  }
  return configureGlobalCapacity({dir:capacityDirectory,limit,stateDirs});
}
async function selectProject(id){
  gate.assertSetupAllowed();
  if(transition)throw Error('Another project change is still running.');
  const next=hosts.get(id);if(!next)throw Error('Unknown project.');
  if(id===registry.snapshot().selectedId)return next.openWindow();
  transition=true;
  try{await selected()?.hide();await registry.select(id);await next.bootstrap();changed();}finally{transition=false;}
}
async function initializeConfig(configPath){
  await new Promise((done,reject)=>{const child=spawn(process.execPath,[join(root,'cli.mjs'),'init','--template','set1','--config',configPath],{cwd:root,env:childEnvironment(configPath),stdio:'ignore'});child.once('error',reject);child.once('exit',code=>code===0?done():reject(Error('Could not create the new project configuration. No existing file was overwritten.')));});
}
async function addProject(){
  gate.assertSetupAllowed();await assertRegistrationAllowed();if(transition)throw Error('Another project change is still running.');
  transition=true;
  try{
    const id=`p-${randomUUID()}`,configPath=join(crewRoot,'instances',id,'project.json'),key=instanceKey(configPath);
    await initializeConfig(configPath);
    const raw=JSON.parse(await readFile(configPath,'utf8'));
    const used=new Set();for(const p of registry.snapshot().projects){try{used.add(JSON.parse(await readFile(p.configPath,'utf8')).runtime.port);}catch{}}
    let port=4320;while(used.has(port)&&port<65535)port++;if(port===65535)throw Error('No project port is available.');
    raw.runtime.port=port;raw.project.id=id;raw.project.name='New project';
    await writeFile(configPath,JSON.stringify(raw,null,2)+'\n',{mode:0o600});
    await selected()?.hide();
    await registry.add({configPath,key,desktopData:join(crewRoot,'desktop',key),name:'New project'});
    register(registry.snapshot().projects.find(p=>p.configPath===configPath));
    await configureCapacity();await selected().openSetup();changed();return snapshot();
  }finally{transition=false;}
}
async function quitCrew(){
  if(quitting)return;if(gate.isReserved())throw Error('An update is preparing. Wait for it to finish.');
  await Promise.all([...hosts.values()].map(h=>h.poll()));
  const view=snapshot(),unknown=view.projects.some(p=>p.active===null),active=view.projects.reduce((sum,p)=>sum+(p.active||0),0);
  const result=await dialog.showMessageBox({type:unknown||active?'warning':'question',message:'Quit Crew for all projects?',detail:`${unknown?'Some project activity is unavailable.':`${active} tasks are active across ${view.projects.length} projects.`}\nClosing the window keeps project controllers running. Quit disconnects voice and stops every owned controller. Detached workers and their evidence remain available when you reopen Crew.`,buttons:['Keep running','Quit Crew'],defaultId:0,cancelId:0,noLink:true});
  if(result.response!==1)return;
  quitting=true;
  try{for(const host of hosts.values())await host.quit();tray?.destroy();app.quit();}catch(error){quitting=false;throw error;}
}
async function resolveUpdateRecovery(){
  const result=await dialog.showMessageBox({type:'warning',message:'Cancel the interrupted idle-update reservation?',detail:`${updateRecoveryError}\n\nCrew will confirm cancellation with every project before releasing worker admissions. Paused workers and retained worktrees stay in place.`,buttons:['Keep paused','Return to work'],defaultId:0,cancelId:0,noLink:true});
  if(result.response!==1)return;
  await updateReservation.cancel();gate.cancel();updateRecoveryError=undefined;changed();
}
async function initializeUpdates(){
  const support=await signedUpdateSupport({packaged:app.isPackaged});let nativeUpdater;
  try{nativeUpdater=createRequire(import.meta.url)('electron-updater').autoUpdater;}catch{nativeUpdater={on(){},autoDownload:false};support.supported=false;support.error='The updater is unavailable in this build.';}
  updateReservation=createWorkspaceUpdateReservation({path:reservationPath,currentVersion:app.getVersion(),projects:projectHosts,setAdmissionPaused:admissionPaused=>configureGlobalCapacity({dir:capacityDirectory,admissionPaused})});
  updater=createUpdateCoordinator({updater:nativeUpdater,currentVersion:app.getVersion(),support,lease,
    activity:async()=>{
      if(transition||quitting||[...hosts.values()].some(h=>h.busy()))return {safe:false,reasons:['Crew setup, switching or shutdown is in progress.']};
      if(updateRecoveryError)return {safe:false,reasons:[updateRecoveryError]};
      return workspaceUpdateActivity(projectHosts());
    },prepare:()=>gate.reserve(async()=>{try{return await updateReservation.prepare(updater.getStatus().availableVersion);}catch(error){await recordReservationFailure(error);throw error;}}),cancel:async()=>{
      try{
      gate.cancel();await cancelHandoff?.();cancelHandoff=undefined;quitting=false;
      for(const host of hosts.values())await host.cancelUpdate();
      await updateReservation.cancel();updateRecoveryError=undefined;
      }catch(error){await recordReservationFailure(error);throw error;}
    },
    stopBackend:async()=>{cancelHandoff=await restartHandoff.write({configPath:selected().configPath,version:updater.getStatus().availableVersion});quitting=true;for(const host of hosts.values())await host.stopForUpdate();},
    install:()=>new Promise((done,reject)=>{
      const timer=setTimeout(()=>finish(Error('The native installer did not restart Crew.')),60000);
      const fail=()=>finish(Error('The native installer could not install the update.'));const exiting=()=>finish();
      const finish=error=>{clearTimeout(timer);nativeUpdater.removeListener('error',fail);app.removeListener('before-quit',exiting);error?reject(error):done();};
      nativeUpdater.once('error',fail);app.once('before-quit',exiting);try{nativeUpdater.quitAndInstall(false,true);}catch{fail();}
    }),otherInstances:async()=>{
      // Existing ownership verifier checks each controller tree. Intersecting only
      // excludes roots whose parent relationship was confirmed in the same snapshots.
      const snapshots=await Promise.all([...hosts.values()].map(h=>otherNativeInstances({backendPid:h.backendPid()})));
      return snapshots.length?snapshots[0].filter(pid=>snapshots.every(list=>list.includes(pid))):otherNativeInstances();
    },onState:status=>{for(const host of hosts.values())host.broadcastUpdate(status);changed();}
  });
  if(support.supported){const timer=setTimeout(()=>attempt(()=>updater.request('check')),30000);timer.unref();const repeat=setInterval(()=>attempt(()=>updater.request('check')),6*60*60*1000);repeat.unref();}
}
ipcMain.handle('crew:setup',(event,action,input)=>{
  const host=selected();if(!host?.acceptsSetup(event.sender))throw Error('Setup request rejected.');return host.handleSetup(event,action,input);
});
ipcMain.handle('crew:workspaces',async(event,action,input)=>{
  if(!selected()?.acceptsWorkspace(event))throw Error('Workspace request rejected.');
  if(action==='snapshot')return snapshot();
  gate.assertSetupAllowed();
  if(action==='select'){await selectProject(input);return snapshot();}
  if(action==='add')return addProject();
  if(action==='rename'){await registry.rename(input?.id,input?.name);changed();return snapshot();}
  if(action==='capacity'){await configureCapacity(input);await registry.setWorkerLimit(input);changed();return snapshot();}
  throw Error('Unknown workspace action.');
});
if(!locked)app.quit();else{
  app.on('second-instance',(_event,_argv,_cwd,data)=>attempt(async()=>{
    if(!data?.configPath)return selected().openWindow();
    const incomingIdentity=await realpath(data.configPath);
    for(const project of registry.snapshot().projects){if(await realpath(project.configPath).catch(()=>null)===incomingIdentity)return selectProject(project.id);}
    gate.assertSetupAllowed();await assertRegistrationAllowed();if(transition)throw Error('Another project change is still running.');
    transition=true;try{const additional=await prepareCrewStorage({appData,configOverride:data.configPath});if(additional.issue)throw Error(additional.issue);
      const candidate={id:'incoming',configPath:additional.configPath,config:JSON.parse(await readFile(additional.configPath,'utf8'))};await assertWorkspaceIsolation({projects:[...registry.snapshot().projects,{id:candidate.id,configPath:candidate.configPath}],candidate});
      await selected().hide();await registry.add({configPath:additional.configPath,key:additional.key,desktopData:additional.desktopData});register(registry.snapshot().projects.find(p=>p.configPath===additional.configPath));await configureCapacity();await selected().bootstrap();changed();
    }finally{transition=false;}
  }));
  app.on('activate',()=>attempt(()=>selected()?.openWindow()));
  app.on('window-all-closed',()=>{});
  app.on('before-quit',event=>{if(!quitting){event.preventDefault();attempt(quitCrew);}});
  void app.whenReady().then(async()=>{
    const release=await lease.acquire();await release();
    if(!storage.issue){try{await access(storage.configPath);}catch(error){if(error.code!=='ENOENT')throw error;if(!explicit)await initializeConfig(storage.configPath);}}
    registry=await openWorkspaceRegistry({crewRoot,initial:{configPath:storage.configPath,key:storage.key,desktopData:storage.desktopData},explicitConfig:Boolean(explicit||restarted)});
    for(const project of registry.snapshot().projects)register(project);
    let restoreIssue;try{await configureCapacity();}catch(error){restoreIssue=safe(error);}
    await initializeUpdates();
    Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'Crew',submenu:[{label:'About Crew',role:'about'},{label:'Project setup…',click:()=>attempt(()=>selected().openSetup())},{label:'Add project…',click:()=>attempt(addProject)},{type:'separator'},{label:'Open window',click:()=>attempt(()=>selected().openWindow())},{label:'Quit Crew…',accelerator:'Command+Q',click:()=>attempt(quitCrew)}]},{label:'Edit',submenu:[{role:'undo'},{role:'redo'},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'}]},{label:'Window',submenu:[{role:'minimize'},{role:'close'}]}]));
    tray=new Tray(trayIcon(false));updateTray();
    // Register capacity evidence for every project before recovering any controller.
    if(restoreIssue){selected().setError(restoreIssue);await selected().openSetup();}
    else{for(const host of hosts.values())if(host!==selected())await host.bootstrap();await selected().bootstrap();}
    const recovery=await updateReservation.recover();updateRecoveryError=recovery.blocked?recovery.error:undefined;changed();
    const updatePoll=setInterval(()=>void updater.refresh().catch(()=>{}),1500);updatePoll.unref();
  }).catch(async error=>{quitting=true;await dialog.showMessageBox({type:'error',message:'Crew could not restore its projects',detail:safe(error)});app.exit(1);});
}
