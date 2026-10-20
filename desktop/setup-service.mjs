// Bounded local runtime/account checks. Linear reads live separately in project-options.mjs.
import { readFile, writeFile, rename, unlink, mkdir, access, stat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { loadAppConfig, resolveCodexExecutable } from '../config.mjs';
import { safeError } from '../codex-bridge.mjs';
const run = promisify(execFile);
export const fingerprint = raw => createHash('sha256').update(raw).digest('hex');
export async function readSetupConfig(configPath) {
  const source = await readFile(configPath, 'utf8');
  return { config:JSON.parse(source), revision:fingerprint(source), configPath };
}
export async function saveSetupConfig({ root, configPath, input, revision, env, dryRun = false }) {
  if (!input || JSON.stringify(input).length > 70000) throw new Error('Configuration is too large or missing.');
  const existing = await readSetupConfig(configPath);
  if (existing.revision !== revision) throw new Error('Configuration changed elsewhere. Reload setup before saving; nothing was overwritten.');
  // Draft validation does not depend on Codex already being installed. Prompts must exist.
  const temporary = join(dirname(configPath), `.setup-${randomUUID()}.json`);
  try {
    await writeFile(temporary, `${JSON.stringify(input, null, 2)}\n`, { flag:'wx', mode:0o600 });
    const candidate = await loadAppConfig({ root, configPath:temporary, env, checkRuntime:false });
    const currentData = resolve(dirname(configPath), existing.config.runtime.dataDir);
    let hasState = false;
    for (const name of ['manager-chat.json', 'orchestration/instance-project.json']) { try { await access(join(currentData, name)); hasState = true; } catch {} }
    if (hasState && (input.project.id !== existing.config.project.id || candidate.dataDir !== currentData)) throw new Error('This instance already has durable state. Keep its project ID and state folder; use a separate configured instance for another project.');
    if ((await readSetupConfig(configPath)).revision !== revision) throw new Error('Configuration changed during validation. Reload before saving.');
    if (dryRun) return { issues:candidate.project.readiness.issues };
    await writeFile(`${configPath}.before-setup.json`, `${JSON.stringify(existing.config, null, 2)}\n`, { mode:0o600 });
    await rename(temporary, configPath);
    return { ...await readSetupConfig(configPath), issues:candidate.project.readiness.issues };
  } finally { await unlink(temporary).catch(() => {}); }
}
export async function checkLocalRuntime({ root, configPath, env }) {
  const raw = await readSetupConfig(configPath);
  const checks = {};
  let executable;
  try { const found = await resolveCodexExecutable({ configured:raw.config.runtime.codexBinary, base:dirname(configPath), env }); executable = found.executable; checks.codex = { status:'verified', detail:found.version, path:executable }; }
  catch (error) { checks.codex = { status:'unavailable', detail:safeError(error) }; }
  try { const r = await run('git', ['--version'], { env, timeout:10000, maxBuffer:65536 }); checks.git = { status:'verified', detail:r.stdout.trim() }; }
  catch { checks.git = { status:'unavailable', detail:'Install Git or the macOS Command Line Tools, then retry. Git must be on PATH.' }; }
  try { const loaded = await loadAppConfig({ root, configPath, env, checkRuntime:false }); checks.project = { status:loaded.project.readiness.ready ? 'configured' : 'incomplete', detail:loaded.project.readiness.issues.join(' ') || 'Local project paths, refs and prompt files are configured. External ticket access has not been proven.', mode:loaded.project.mode }; }
  catch (error) { checks.project = { status:'invalid', detail:safeError(error) }; }
  return { checks, executable, revision:raw.revision };
}
// Short-lived protocol client: starts no manager thread/turn and returns only public status.
export async function probeCodex({ executable, root, env, startLogin = false, openLogin = async () => {} }) {
  const child = spawn(executable, ['app-server', '--stdio', '-c', 'forced_login_method="chatgpt"', '-c', 'model_provider="openai"'], { cwd:root, env, stdio:['pipe','pipe','ignore'] });
  let nextId = 0, loginDone;
  const pending = new Map();
  const fail = error => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); } pending.clear(); };
  child.on('error', fail); child.on('exit', () => fail(new Error('Codex setup check stopped. Retry the check.')));
  const lines = createInterface({ input:child.stdout });
  lines.on('line', line => { try { const m=JSON.parse(line); const p=pending.get(m.id); if(p) { pending.delete(m.id);clearTimeout(p.timer); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } else if (m.method==='account/login/completed') loginDone?.(m.params); else if(m.id!==undefined && m.method) child.stdin.write(`${JSON.stringify({id:m.id,error:{code:-32601,message:'Setup does not approve tools or work.'}})}\n`); } catch {} });
  const rpc = (method, params={}, timeout=20000) => new Promise((resolve,reject) => { const id=++nextId; const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`${method} timed out. Retry; no work was started.`));},timeout); pending.set(id,{resolve,reject,timer}); child.stdin.write(`${JSON.stringify({id,method,params})}\n`); });
  try {
    await rpc('initialize', {clientInfo:{name:'crew_setup',version:'0.5.0'},capabilities:{experimentalApi:true}});
    child.stdin.write('{"method":"initialized","params":{}}\n');
    if (startLogin) {
      let timer;
      const completion = new Promise((resolve,reject) => { loginDone=resolve;timer=setTimeout(()=>reject(new Error('Sign-in was not completed within three minutes. Retry when ready.')),180000); });
      completion.catch(()=>{});
      try {
        const login = await rpc('account/login/start', {type:'chatgpt'});
        const url = new URL(login.authUrl);
        if(url.protocol!=='https:' || url.username || url.password || !['auth.openai.com','auth0.openai.com','login.openai.com'].includes(url.hostname)) throw new Error('Codex returned an unexpected sign-in destination. Use the installed Codex app to sign in, then retry.');
        await openLogin(url.href);
        const result = await completion;
        if(!result.success) throw new Error('ChatGPT sign-in did not complete. Use Codex to sign in, then retry.');
      } finally { clearTimeout(timer); loginDone=undefined; }
    }
    const {account} = await rpc('account/read',{refreshToken:false});
    const result = {protocol:{status:'verified',detail:'App-server handshake succeeded. No model work started.'},auth:{status:account?.type==='chatgpt'?'verified':'unavailable',detail:account?.type==='chatgpt'?`ChatGPT sign-in confirmed${account.planType ? ` (${account.planType})` : ''}. Usage limits and voice availability still apply.`:'ChatGPT sign-in required. API-key authentication is not supported.'},voices:{status:'unknown',detail:'Sign in to check the realtime voice catalog.'},tools:{status:'unknown',detail:'Sign in, then check connected tools.'}};
    if(account?.type==='chatgpt') {
      try { const {voices} = await rpc('thread/realtime/listVoices'); if(!Array.isArray(voices?.v3)||!voices.v3.length)throw new Error('No v3 voices returned.'); result.voices={status:'verified',detail:`${voices.v3.length} v3 voices advertised. No audio session started; device audio is checked separately.`}; } catch(error) {result.voices={status:'unavailable',detail:safeError(error)};}
      try { const rows=[];let cursor=null;for(let i=0;i<5;i++){const page=await rpc('mcpServerStatus/list',{cursor,limit:100,detail:'toolsAndAuthOnly'});rows.push(...page.data);cursor=page.nextCursor;if(!cursor)break;} result.tools={status:'discovered',detail:'Tool discovery is not proof of access to a Linear team/project. Verify a real read with the manager before business work.',servers:rows.map(s=>({name:s.name,status:s.runtimeStatus||'unknown',auth:s.authStatus||'unknown',tools:Object.keys(s.tools||{})})),truncated:Boolean(cursor)}; const linearTools=rows.flatMap(s=>Object.keys(s.tools||{}).map(name=>`${s.name}/${name}`)).filter(name=>/linear.*(get_issue|search|fetch|list_teams|get_team|list_projects)/i.test(name));result.tools.linear={status:linearTools.length?'advertised':cursor?'unknown':'unavailable',detail:linearTools.length?`${linearTools.length} possible Linear read tools advertised. Team/project access still needs a real read.`:'No Linear read tool was identified in this discovery. Connect the intended tools in Codex and retry; discovery may not expose every dynamic tool.'}; } catch(error) { result.tools={status:'unavailable',detail:safeError(error)}; }
    }
    return result;
  } finally {
    fail(new Error('Setup check finished.'));
    lines.close(); child.kill('SIGTERM');
    await new Promise(done=>{if(child.exitCode!==null)return done();const timer=setTimeout(()=>{child.kill('SIGKILL');done();},2000);child.once('exit',()=>{clearTimeout(timer);done();});});
  }
}
export async function probePaths({ root, configPath, env }) {
  const c=await loadAppConfig({root,configPath,env,checkRuntime:false});
  const results=[];
  for(const repo of c.project.repositories) {
    if(!repo.path){results.push({name:repo.name,status:'unconfigured',detail:'Choose the local repository folder.'});continue;}
    try {await access(repo.path,constants.R_OK|constants.X_OK);results.push({name:`${repo.name}: folder`,status:'verified',detail:'Readable by this packaged process. This does not prove worker sandbox access.'});}catch(error){results.push({name:`${repo.name}: folder`,status:['EACCES','EPERM'].includes(error.code)?'denied':'unavailable',detail:'This process cannot read the selected folder. Choose the correct folder and review macOS Files and Folders access, then retry.'});continue;}
    if(!repo.baseRef){results.push({name:`${repo.name}: base ref`,status:'unconfigured',detail:'Folder is readable, but a committed base ref has not been selected.'});continue;}
    try {const r=await run('git',['-C',repo.path,'rev-parse','--verify',`${repo.baseRef}^{commit}`],{env,timeout:10000,maxBuffer:65536});results.push({name:`${repo.name}: base ref`,status:'verified',detail:`Ref resolves to ${r.stdout.trim().slice(0,12)}. Worker sandbox access still needs a bounded task.`});}catch{results.push({name:`${repo.name}: base ref`,status:'unavailable',detail:'The committed ref did not resolve. Check the Git repository and ref; this is not proof of an OS permission denial.'});}
  }
  try {await mkdir(c.dataDir,{recursive:true,mode:0o700});const p=join(c.dataDir,`.setup-access-${randomUUID()}`);const fd=await open(p,'wx',0o600);await fd.close();await unlink(p);results.push({name:'Instance state folder',status:'verified',detail:'A temporary write/readiness probe succeeded and was removed.'});}catch{results.push({name:'Instance state folder',status:'denied',detail:'Cannot write instance state. Choose a dedicated writable folder and retry.'});}
  for(const [role,p] of Object.entries(c.promptPaths)) {try {if(!(await stat(p)).isFile())throw Error();await access(p,constants.R_OK);results.push({name:`${role} prompt`,status:'verified',detail:p});}catch{results.push({name:`${role} prompt`,status:'denied',detail:'Prompt file is not readable.'});}}
  return results;
}
// Bind readiness evidence to config and editable prompt bytes; never persist those bytes here.
export async function setupInputsKey(configPath) {
  const saved=await readSetupConfig(configPath), parts=[saved.revision];
  for(const role of ['manager','worker']) {
    try {parts.push(await readFile(resolve(dirname(configPath),saved.config.project.prompts[role]),'utf8'));}
    catch(error){parts.push(`${role}:${error.code||'unreadable'}`);}
  }
  return fingerprint(JSON.stringify(parts));
}
// Automatic analyzed setup apply: new prompt files first, validated atomic config pointer last.
export async function applyDiscoveryDraft({ root, configPath, env, revision, config, managerDraft, workerDraft, promptDirectory }) {
  if(typeof managerDraft!=='string'||typeof workerDraft!=='string'||managerDraft.length>64000||workerDraft.length>64000||!managerDraft.trim()||!workerDraft.trim())throw new Error('Project instructions are missing or too large. Retry project setup.');
  const expected={manager:join(promptDirectory,'manager.md'),worker:join(promptDirectory,'worker.md')};
  if(config?.project?.prompts?.manager!==expected.manager || config?.project?.prompts?.worker!==expected.worker)throw new Error('The generated instruction-file locations changed. Retry project setup; advanced settings can select existing files later.');
  const target=resolve(dirname(configPath),promptDirectory);
  await mkdir(dirname(target),{recursive:true,mode:0o700});
  // New directory only: an existing prompt cannot be silently overwritten.
  await mkdir(target,{mode:0o700});
  let committed=false;
  try {
    await writeFile(join(target,'manager.md'),managerDraft,{flag:'wx',mode:0o600});
    await writeFile(join(target,'worker.md'),workerDraft,{flag:'wx',mode:0o600});
    const result=await saveSetupConfig({root,configPath,env,input:config,revision});committed=true;return result;
  } finally {
    if(!committed){await unlink(join(target,'manager.md')).catch(()=>{});await unlink(join(target,'worker.md')).catch(()=>{});const {rmdir}=await import('node:fs/promises');await rmdir(target).catch(()=>{});}
  }
}
export async function requestMicrophonePermission({ getStatus, ask }) {
  const before=getStatus();
  // Denied/restricted/unknown must go to recovery, never a repeated/blind OS prompt.
  if(before==='not-determined')await ask();
  const after=getStatus();
  return ['granted','denied','restricted','not-determined'].includes(after)?after:'unknown';
}
