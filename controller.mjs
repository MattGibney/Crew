import {applyProjectToolchain} from './project-toolchain.mjs';
// Deterministic local controller. Polls files; never polls a model or starts voice.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat, mkdir, readFile, writeFile, rename, mkdtemp, open, unlink, realpath, lstat } from 'node:fs/promises';
import { runEnvironmentHooks, environmentFile, reconcileEnvironment } from './worker-environment.mjs';
import {stopProjectEnvironment,disposeProjectEnvironment,applyProjectRecovery,reviewProjectRecovery} from './project-environment.mjs';
import {selectWorktreeRoot,ensureWorktreeRoot} from './worktree-paths.mjs';
import {snapshotProcesses} from './process-ownership.mjs';
import { randomUUID, createHash } from 'node:crypto';
import { promptSnapshot, promptVersion } from './prompt-settings.mjs';
import path from 'node:path';
import os from 'node:os';
import { loadTasks, readTask, updateTask, currentAssignment, ensureAssignments, ensureArchiveExecutionStopped, requestWorkerFollowup } from './orchestration-store.mjs';
import { isArchivedTask } from './worker-archive.mjs';
import { createGlobalCapacity } from './global-capacity.mjs';
const exec = promisify(execFile);
const now = () => new Date().toISOString();
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function json(file) { try { return JSON.parse(await readFile(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
async function atomic(file, value) { const temp = `${file}.${process.pid}.tmp`; await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); await rename(temp, file); }
const confirmedExit=(task,exit)=>Boolean(exit&&exit.runId===task.runId&&exit.stopConfirmed===true);
const connectionEnded=(task,exit)=>Boolean(exit&&exit.runId===task.runId&&(exit.connectionClosed===true||exit.stopConfirmed===true));
const attention = (task, id, kind, message) => { if (!task.attention.some(a => a.id === id)) task.attention.push({ id, kind, message, at: now() }); };
export async function createController({ stateDir, sourceDir, executable, project = null, workerPrompt = '', getWorkerPrompt = null, globalCapacity = null, onChange = () => {}, admissionHeld = async () => false }) {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const lockPath = path.join(stateDir, 'controller.lock');
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const prior = await json(lockPath);
    if (!prior || !Number.isInteger(prior.pid) || alive(prior.pid)) throw new Error('Another controller may be running. Refusing duplicate launches.');
    await unlink(lockPath); lock = await open(lockPath, 'wx', 0o600);
  }
  await lock.writeFile(JSON.stringify({ pid: process.pid, at: now() })); await lock.close();
  let busy = false, timer, lastView = '', stopped = false, controllerError = null;
  const launches=new Map(), operations=new Map();
  let processSnapshot=new Map();
  async function ownedRunnerAlive(task){if(!task.runnerPid||!task.runDir)return false;const owner=await json(path.join(task.runDir,'owner.json'));const actual=processSnapshot.get(task.runnerPid),expected=owner?.supervisorIdentity;return Boolean(owner?.runId===task.runId&&owner.supervisorPid===task.runnerPid&&actual&&expected&&actual.start===expected.start&&actual.commandHash===expected.commandHash&&!actual.state?.includes('Z'));}
  let maxConcurrent=Number.isInteger(project?.worker?.maxConcurrent)?Math.max(1,Math.min(8,project.worker.maxConcurrent)):2;
  const capacity = await createGlobalCapacity({ dir: globalCapacity?.dir || path.join(stateDir, 'capacity'), stateDir, ...(globalCapacity?.dir ? {} : {limit:maxConcurrent}) });
  if (globalCapacity?.limit !== undefined) throw new Error('Configure the global worker limit once through configureGlobalCapacity, not per controller.');
  const ownedTask=task=>!project||task.projectId===project.id||(project.mode==='fixture'&&!task.projectId);
  const startupTasks=(await loadTasks(stateDir)).filter(ownedTask);
  for(const task of startupTasks){
    const interrupted=new Set((task.lifecycleRequests||[]).filter(request=>['start','resume','retry_setup'].includes(request.action)&&['pending','processing'].includes(request.status)).map(request=>request.id));
    await updateTask(stateDir,task.id,n=>{
    // Old start/resume intent must never dispatch new work during recovery.
    // Retain its exact request/run history; stop/pause still recover normally.
    for(const request of n.lifecycleRequests||[])if(interrupted.has(request.id)&&['pending','processing'].includes(request.status)){
      request.status='failed';request.handledAt=now();request.error='Controller restarted before start/resume completed; ask the manager to start again.';
    }
    if(['queued','resume_queued'].includes(n.status))n.capacityWait='Waiting for the manager to start after reopening';
    });
  }
  const startupQueued = new Map((await loadTasks(stateDir)).filter(task=>['queued','resume_queued'].includes(task.status)).map(task=>[task.id, JSON.stringify(task.answer||null)]));
  let fixturePromise;
  async function fixture(){if(!fixturePromise)fixturePromise=createFixture().catch(error=>{fixturePromise=null;throw error;});return fixturePromise;}
  async function createFixture() {
    const metaPath = path.join(stateDir, 'fixture.json');
    const meta = await json(metaPath);
    if (meta) { await exec('git', ['-C', meta.repo, 'rev-parse', '--verify', 'HEAD']); return meta; }
    const base = await mkdtemp(path.join(os.tmpdir(), 'crew-fixture-'));
    const repo = path.join(base, 'repo'); await mkdir(path.join(repo, 'src'), { recursive: true });
    await exec('git', ['init', '-b', 'main', repo]);
    await writeFile(path.join(repo, 'README.md'), '# Disposable audit fixture\n\nTicket AI-004. This is not product source. Audit totals without editing files.\n');
    await writeFile(path.join(repo, 'AGENTS.md'), '# Worker scope\nRead-only audit in this disposable fixture only. Do not edit or commit. Use local_orchestration.report for useful progress, questions and final result. Never inspect credentials or access outside the task.\n');
    await writeFile(path.join(repo, 'src/totals.mjs'), 'export function sum(values) { return values.reduce((total, value) => total + value, 1); }\n');
    await exec('git', ['-C', repo, 'add', 'README.md', 'AGENTS.md', 'src/totals.mjs']);
    await exec('git', ['-C', repo, '-c', 'user.name=Codex Fixture', '-c', 'user.email=fixture@localhost.invalid', 'commit', '-m', 'Disposable read-only audit fixture']);
    const { stdout } = await exec('git', ['-C', repo, 'rev-parse', 'HEAD']);
    const created = { repo, base, commit: stdout.trim(), at: now() }; await atomic(metaPath, created); return created;
  }
  async function fail(id, message) {
    await updateTask(stateDir, id, task => { task.status = 'failed'; task.endedAt=now(); task.failure = message; attention(task, `${task.runId || task.id}:failure`, 'failure', message); });
  }
  // Directions are queued transport input, never a Crew permission decision.
  // Wait only for the previous native connection to finish so one conversation
  // cannot acquire duplicate turns. File/configuration history is informational.
  async function nativeConnectionLive(task,{ignoreLaunch=false}={}) {
    if(!ignoreLaunch&&launches.has(task.id))return true;
    if(!task.runDir)return false;
    const terminal=await json(path.join(task.runDir,'exit.json'));
    if(connectionEnded(task,terminal))return false;
    if(await ownedRunnerAlive(task))return true;
    const owner=await json(path.join(task.runDir,'owner.json'));
    const records=(await json(path.join(task.runDir,'ownership.json')))?.records||[];
    const native=records.find(record=>record.pid===owner?.workerPid),actual=native&&processSnapshot.get(native.pid);
    if(actual&&actual.start===native.start&&actual.commandHash===native.commandHash&&!actual.state?.includes('Z'))return true;
    // Spawn acknowledgement precedes the supervisor's ownership journal. Keep
    // directions queued across that transport bootstrap gap; missing identity
    // is not positive evidence that this conversation is available again.
    if(owner?.runId!==task.runId||!owner.supervisorIdentity){
      const started=await json(path.join(task.runDir,'started.json'));
      const intent=Date.parse(task.spawnIntentAt||(started?.runId===task.runId?started.at:null));
      if(Number.isFinite(intent)&&task.harnessStarted){
        if(Date.now()-intent<=15000)return true;
        throw new Error('Native worker startup ownership is unresolved. Direction remains queued; no duplicate connection was launched.');
      }
    }
    return false;
  }
  async function activateFollowup(task) {
    if(isArchivedTask(task)||['disposed','removed','archived'].includes(task.status)||task.archiveRestoration?.requiresRecovery)return task;
    const pending=(task.assignments||[]).find(item=>item.status==='queued'&&item.id!==task.currentAssignmentId);
    if(!pending||!task.threadId||!task.worktree)return task;
    if(operations.has(task.id)||await nativeConnectionLive(task))return task;
    // Terminal publication may land after this tick's reconciliation read. Save
    // the prior execution outcome before selecting another queued direction.
    // This is history settlement, never admission or project workflow inference.
    const terminal=task.runDir?await json(path.join(task.runDir,'exit.json')):null;
    if(terminal?.runId===task.runId&&terminal.connectionClosed===true&&terminal.ownership?.remaining?.length&&!(task.retainedResourceRuns||[]).some(item=>item.runId===task.runId)){
      task=await updateTask(stateDir,task.id,n=>{(n.retainedResourceRuns||=[]).push({runId:n.runId,at:terminal.at});});
    }
    if(connectionEnded(task,terminal)&&terminal.exitCode===0&&terminal.completedTurn&&currentAssignment(task).status!=='completed'){
      const latest=await readTask(stateDir,task.id);
      const result=[...(latest.reports||[])].reverse().find(item=>item.runId===latest.runId&&item.kind==='result');
      if(latest.runId===task.runId&&(result||(!latest.question&&latest.status!=='blocked'))){
        try{await verify(latest,terminal,result||{runId:latest.runId,kind:'result',message:terminal.finalMessage||'Native Codex turn completed.',evidence:[]});}
        catch(error){await fail(latest.id,`Native result history could not be recorded: ${error.message}`);}
        task=await readTask(stateDir,task.id);
      }
    }
    if(task.lifecycleRequests?.some(r=>['pending','processing'].includes(r.status)&&['archive','dispose'].includes(r.action)))return task;
    const started=task.runDir?await json(path.join(task.runDir,'started.json')):null;
    const terminalStart=started?.runId===task.runId?started.at:task.startedAt;
    return updateTask(stateDir,task.id,n=>{
      if(n.runId!==task.runId||n.currentAssignmentId!==task.currentAssignmentId)return;
      ensureAssignments(n);
      const next=n.assignments.find(item=>item.id===pending.id);if(next?.status!=='queued')return;
      if(terminal?.runId===n.runId&&Number.isInteger(terminal.workerPid)&&Number.isFinite(Date.parse(terminalStart))&&Number.isFinite(Date.parse(terminal.at))&&!(n.accountedRuns||[]).includes(n.runId)){
        n.activeMs=(n.activeMs||0)+Math.max(0,Date.parse(terminal.at)-Date.parse(terminalStart));(n.accountedRuns||=[]).push(n.runId);
      }
      const prior=currentAssignment(n);if(prior.status!=='completed'){prior.status='stopped';prior.endedAt=n.endedAt||now();}
      n.currentAssignmentId=next.id;next.status='active';
      n.result=null;n.question=null;n.answer=null;n.progress=null;n.failure=null;n.candidateReportId=null;n.endedAt=null;n.completedAt=null;
      n.status='resume_queued';n.retainedDirection=true;delete n.followupWait;delete n.capacityWait;
    });
  }
  async function launchContinuation(task, runId) {
    if(stopped||await admissionHeld({taskId:task.id,resume:true})||await nativeConnectionLive(task,{ignoreLaunch:true})){await capacity.releasePreparation({taskId:task.id,runId});return;}
    if(isArchivedTask(task)||['disposed','removed','archived'].includes(task.status)||task.archiveRestoration?.requiresRecovery){await fail(task.id,'The selected worker environment is unavailable after archive/disposal.');return;}
    let dispatched=false;
    try{
      if(!task.threadId)throw new Error('This worker has no existing native Codex conversation to receive the direction.');
      if(!task.worktree)throw new Error('This worker has no existing working directory.');
      const cwd=await realpath(task.worktree);if(!(await stat(cwd)).isDirectory())throw new Error('The worker working directory is unavailable.');
      const saved=getWorkerPrompt?await getWorkerPrompt():promptSnapshot(workerPrompt||await readFile(path.join(sourceDir,'prompts','worker.md'),'utf8'));
      const assignment=currentAssignment(task),runDir=path.join(stateDir,'runs',task.id,runId);
      await mkdir(runDir,{recursive:true,mode:0o700});
      const config={project,workerPrompt:saved.text,workerPromptVersion:saved.version,retainedDirection:true,taskId:task.id,assignmentId:assignment.id,runId,ticket:assignment.ticket,brief:assignment.brief,modelSelection:task.modelSelection||null,environment:task.environment||null,answer:task.answer||null,threadId:task.threadId,worktree:cwd,stateDir,executable,mcpScript:path.join(sourceDir,'orchestration-mcp.mjs')};
      await atomic(path.join(runDir,'config.json'),config);
      await updateTask(stateDir,task.id,n=>{if(n.runId!==task.runId||n.currentAssignmentId!==task.currentAssignmentId||!['queued','resume_queued'].includes(n.status))throw new Error('Worker transport selection changed before dispatch.');n.previousRunId=n.runId||null;n.runId=runId;n.runDir=runDir;n.retainedDirection=true;n.workerPromptSnapshot=saved;n.status='running';n.harnessStarted='pending';n.runnerPid=null;n.spawnIntentAt=now();n.startedAt=null;n.endedAt=null;n.execution=null;n.launchAt=now();});
      const beforeSpawn=await readTask(stateDir,task.id);
      const stopping=beforeSpawn.lifecycleRequests?.some(item=>['pending','processing'].includes(item.status)&&['stop','pause'].includes(item.action));
      if(stopped||stopping||await admissionHeld({taskId:task.id,resume:Boolean(task.threadId)})){
        await updateTask(stateDir,task.id,n=>{n.harnessStarted=false;n.spawnIntentAt=null;if(!['stopping','pausing'].includes(n.status))n.status=stopping?'stopping':n.threadId?'resume_queued':'queued';});
        await capacity.releasePreparation({taskId:task.id,runId});return;
      }
      const runner=spawn(process.execPath,[path.join(sourceDir,'worker-runner.mjs'),path.join(runDir,'config.json')],{cwd:sourceDir,detached:true,stdio:'ignore',env:process.env});
      await new Promise((resolve,reject)=>{runner.once('spawn',resolve);runner.once('error',reject);});runner.unref();dispatched=true;
      await updateTask(stateDir,task.id,n=>{if(n.runId===runId){n.runnerPid=runner.pid;n.harnessStarted=true;}});
    }catch(error){await updateTask(stateDir,task.id,n=>{if(!dispatched){n.harnessStarted=false;n.spawnIntentAt=null;}n.status='failed';n.failure=`Worker direction transport failed: ${error.message}`;n.endedAt=now();attention(n,`${n.runId||n.id}:direction-failure`,'failure',n.failure);});}finally{if(!dispatched)await capacity.releasePreparation({taskId:task.id,runId});}
  }
  async function launch(task, resume, runId) {
    if(task.worktree&&task.threadId)return launchContinuation(task,runId);
    if(stopped||await admissionHeld({taskId:task.id,resume})){await capacity.releasePreparation({taskId:task.id,runId});return;}
    let dispatched=false;
    try {
      if(task.archiveRestoration?.requiresRecovery)throw new Error('This worker has history only; its working directory is unavailable.');
      if(task.harnessStarted&&!confirmedExit(task,task.runDir?await json(path.join(task.runDir,'exit.json')):null))throw new Error('The previous native execution has no confirmed exit; preserve its context.');
      if(project&&!ownedTask(task))throw new Error('Task project does not match this controller.');
      await updateTask(stateDir,task.id,n=>{if(n.status!==(resume?'resume_queued':'queued'))throw new Error('Transport selection changed before dispatch.');n.status='launching';n.previousRunId=n.runId||null;n.runId=runId;n.harnessStarted=false;n.runnerPid=null;n.failure=null;n.startedAt=null;n.endedAt=null;n.execution=null;n.spawnIntentAt=null;n.launchAt=now();});
      const repositoryMode=project?.mode==='repository';
      const saved=getWorkerPrompt?await getWorkerPrompt():promptSnapshot(workerPrompt||await readFile(path.join(sourceDir,'prompts','worker.md'),'utf8'));
      if(!saved||promptVersion(saved.text)!==saved.version)throw new Error('Worker prompt snapshot is invalid.');
      let meta;
      if(repositoryMode){
        const repository=project.repositories.find(repo=>repo.id===task.repositoryId);
        if(!repository?.path||!repository.baseRef)throw new Error('Configured repository path and baseRef are required.');
        const repo=await realpath(repository.path);
        const {stdout:top}=await exec('git',['-C',repo,'rev-parse','--show-toplevel']);
        if(await realpath(top.trim())!==repo)throw new Error('Configured repository must be the Git root.');
        if(repository.baseRef.startsWith('-'))throw new Error('Invalid repository baseRef.');
        const {stdout:commit}=await exec('git',['-C',repo,'rev-parse','--verify','--end-of-options',`${repository.baseRef}^{commit}`]);
        meta={repo,commit:commit.trim(),base:await selectWorktreeRoot(stateDir,task)};
      }else meta=await fixture();
      let worktree=task.worktree;
      if(!worktree){
        const worktreeName=task.worktreeName||`crew-${randomUUID().replace(/-/g,'')}`;
        await updateTask(stateDir,task.id,n=>{n.worktreeName=worktreeName;if(repositoryMode)n.worktreeRoot=meta.base;});
        if(repositoryMode)await ensureWorktreeRoot(stateDir,meta.base);
        worktree=path.join(meta.base,worktreeName);
        await exec('git',['-C',meta.repo,'worktree','add','--detach',worktree,meta.commit]);
      }
      worktree=await realpath(worktree);
      if(!(await stat(worktree)).isDirectory())throw new Error('Worker working directory is unavailable.');
      // Configuration is context for the agent, never an automatic command or
      // readiness prerequisite. Native Codex owns command policy and approvals.
      const environment=task.environment||null;
      const runDir=path.join(stateDir,'runs',task.id,runId);
      await mkdir(runDir,{recursive:true,mode:0o700});
      const latest=await readTask(stateDir,task.id);
      if(['stopping','pausing'].includes(latest.status)||latest.lifecycleRequests?.some(item=>['pending','processing'].includes(item.status)&&['stop','pause'].includes(item.action))){
        await updateTask(stateDir,task.id,n=>{n.worktree=worktree;n.repositoryPath=meta.repo;n.baseCommit=task.baseCommit||meta.commit;n.runDir=runDir;n.harnessStarted=false;n.spawnIntentAt=null;});return;
      }
      if(stopped||await admissionHeld({taskId:task.id,resume})){
        await updateTask(stateDir,task.id,n=>{n.worktree=worktree;n.repositoryPath=meta.repo;n.baseCommit=task.baseCommit||meta.commit;n.runDir=runDir;n.status='queued';n.harnessStarted=false;n.spawnIntentAt=null;n.capacityWait='Native execution is held by the manager or application.';});return;
      }
      const assignment=currentAssignment(task);
      const config={project,workerPrompt:saved.text,workerPromptVersion:saved.version,agentOwnedEnvironment:true,taskId:task.id,runId,ticket:assignment.ticket,brief:assignment.brief,assignmentId:assignment.id,modelSelection:task.modelSelection||null,environment,answer:resume?task.answer:null,threadId:task.threadId||null,worktree,stateDir,executable,mcpScript:path.join(sourceDir,'orchestration-mcp.mjs')};
      await atomic(path.join(runDir,'config.json'),config);
      await updateTask(stateDir,task.id,n=>{n.workerPromptSnapshot=saved;n.worktree=worktree;n.repositoryPath=meta.repo;n.baseCommit=task.baseCommit||meta.commit;n.fixtureRepo=repositoryMode?null:meta.repo;n.fixtureCommit=repositoryMode?null:meta.commit;n.runDir=runDir;n.status='running';n.harnessStarted='pending';n.spawnIntentAt=now();n.handledReports=n.handledReports||[];});
      const beforeSpawn=await readTask(stateDir,task.id);
      const stopping=beforeSpawn.lifecycleRequests?.some(item=>['pending','processing'].includes(item.status)&&['stop','pause'].includes(item.action));
      if(stopped||stopping||await admissionHeld({taskId:task.id,resume:Boolean(task.threadId)})){
        await updateTask(stateDir,task.id,n=>{n.harnessStarted=false;n.spawnIntentAt=null;if(!['stopping','pausing'].includes(n.status))n.status=stopping?'stopping':n.threadId?'resume_queued':'queued';});
        await capacity.releasePreparation({taskId:task.id,runId});return;
      }
      const runner=spawn(process.execPath,[path.join(sourceDir,'worker-runner.mjs'),path.join(runDir,'config.json')],{cwd:sourceDir,detached:true,stdio:'ignore',env:process.env});
      await new Promise((resolve,reject)=>{runner.once('spawn',resolve);runner.once('error',reject);});runner.unref();dispatched=true;
      await updateTask(stateDir,task.id,n=>{n.runnerPid=runner.pid;n.harnessStarted=true;});
    }catch(error){if(!dispatched)await updateTask(stateDir,task.id,n=>{n.harnessStarted=false;n.spawnIntentAt=null;});await fail(task.id,`Worker launch failed: ${error.message}`);}
    finally{const latest=await readTask(stateDir,task.id);if(latest.runId!==runId||!latest.harnessStarted)await capacity.releasePreparation({taskId:task.id,runId});}
  }
  async function verify(task, exit, report) {
    if (exit.exitCode !== 0 || !exit.completedTurn || !exit.threadId) throw new Error('Worker did not produce a successful completed Codex turn and session.');
    if(report?.runId!==task.runId||report.kind!=='result'||typeof report.message!=='string'||!report.message.trim())throw new Error('Worker did not provide a non-empty durable result for this run.');
    const successfulCommands = exit.commands.filter(c => c.exitCode === 0);
    if(project?.mode!=='repository'&&!successfulCommands.length)throw new Error('No successful worker command evidence was recorded.');
    if(project?.mode==='repository'){
      const verification={scope:'native-execution-evidence',semanticCorrectnessVerified:false,productionValidated:false,successfulCommands:successfulCommands.length,at:now()};
      // Optional observations are evidence only; Git/config failures never deny direction or completion.
      try{const [{stdout:head},{stdout:changes}]=await Promise.all([exec('git',['-C',task.worktree,'rev-parse','HEAD']),exec('git',['-C',task.worktree,'status','--porcelain'])]);Object.assign(verification,{worktree:task.worktree,commit:head.trim(),clean:!changes.trim(),changedFiles:changes.trim()?changes.trimEnd().split('\n'):[]});}catch{}
      await updateTask(stateDir,task.id,n=>{if(n.runId!==task.runId)return;n.status='completed';n.endedAt=now();n.threadId=exit.threadId;n.result={message:report.message,evidence:report.evidence||[],finalMessage:exit.finalMessage,verification};n.question=null;attention(n,`${n.runId}:completion`,'completion','Native Codex work completed. Result and execution history are available.');});return;
    }
    const { stdout: root } = await exec('git', ['-C', task.worktree, 'rev-parse', '--show-toplevel']);
    const { stdout: changes } = await exec('git', ['-C', task.worktree, 'status', '--porcelain']);
    const { stdout: commit } = await exec('git', ['-C', task.worktree, 'rev-parse', 'HEAD']);
    const repositoryMode = project?.mode === 'repository';
    const repoPath = repositoryMode ? task.repositoryPath : task.fixtureRepo;
    const { stdout: list } = await exec('git', ['-C', repoPath, 'worktree', 'list', '--porcelain']);
    const { stdout: checks } = await exec(process.execPath, ['--input-type=module', '-e', 'import {sum} from "./src/totals.mjs";console.log(JSON.stringify({empty:sum([]),oneTwoThree:sum([1,2,3])}));'], { cwd: task.worktree });
    const actualWorktree = await realpath(task.worktree), actualRepo = await realpath(task.fixtureRepo);
    if (root.trim() !== actualWorktree || actualWorktree === actualRepo || !list.includes(`worktree ${actualWorktree}\n`) || commit.trim() !== task.fixtureCommit || changes.trim()) throw new Error('Worktree isolation, baseline, or read-only verification failed.');
    const verification = { worktree: root.trim(), commit: commit.trim(), clean: true, successfulCommands: successfulCommands.length, checks: JSON.parse(checks), at: now() };
    const observed = verification.checks;
    const structured = report.evidence.map(text => { try { return JSON.parse(text); } catch { return null; } }).find(value => value && typeof value.emptyActual === 'number');
    const answer = task.answer?.text.toLowerCase() || '';
    const baseFee = /\b1\b|\bone\b/.test(answer) && !/\b0\b|\bzero\b/.test(answer) ? 1 : 0;
    const checkedByWorker = successfulCommands.some(c => c.command.includes('totals.mjs') && c.output.split('\n').some(line => { try { const j = JSON.parse(line); return j.emptyActual === observed.empty && j.sumActual === observed.oneTwoThree; } catch { return false; } }));
    if (!checkedByWorker || !structured || structured.emptyActual !== observed.empty || structured.sumActual !== observed.oneTwoThree || structured.emptyExpected !== baseFee || structured.sumExpected !== 6 + baseFee || structured.finding !== 'initial_value_one') throw new Error('Worker result does not match independent audit evidence and the agreed expectation.');
    verification.expected = { empty: baseFee, oneTwoThree: 6 + baseFee }; verification.findingMatched = true;
    await updateTask(stateDir, task.id, next => {
      next.status = 'completed'; next.endedAt=now(); next.threadId = exit.threadId; next.result = { message: report.message, evidence: report.evidence, finalMessage: exit.finalMessage, verification };
      next.question = null;
      attention(next, `${next.runId}:completion`, 'completion', 'Worker finished; isolated read-only execution and check results verified. Review with the manager when ready.');
    });
  }
  async function finishRequest(id,requestId,error=null){await updateTask(stateDir,id,next=>{const r=next.lifecycleRequests?.find(r=>r.id===requestId);if(r){r.status=error?'failed':'completed';r.handledAt=now();if(error)r.error=error;}});}
  async function dispose(task,request){
    if(task.archiveRestoration?.requiresRecovery){
      await ensureArchiveExecutionStopped(stateDir,task);
      if(task.worktree){
        if(project?.mode==='repository'&&task.environment?.kind==='project-execution'){
          const review=await reviewProjectRecovery({stateDir,task,project,mode:'retire_missing'});
          if(!review.allowed)throw new Error(`Restored history cannot be archived while resource ownership is unresolved: ${review.blockers.join('; ')}`);
        }else{
          const repositoryMode=project?.mode==='repository';
          const repository=repositoryMode?project.repositories?.find(item=>item.id===task.repositoryId):null;
          const meta=repositoryMode?{repo:repository?.path,base:await selectWorktreeRoot(stateDir,task)}:await json(path.join(stateDir,'fixture.json'));
          const expected=meta&&path.join(meta.base,task.worktreeName||(repositoryMode?task.id:`worker-${task.id}`));
          if(!meta?.repo||task.worktree!==expected||await realpath(task.repositoryPath||task.fixtureRepo)!==await realpath(meta.repo))throw new Error('Restored worktree identity is unverified; history was retained.');
          const exists=await lstat(task.worktree).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;});
          if(exists)throw new Error('Restored worker worktree path exists; preserve it for explicit review.');
          const canonical=path.join(await realpath(path.dirname(expected)),path.basename(expected));
          const {stdout}=await exec('git',['-C',meta.repo,'worktree','list','--porcelain','-z']);
          if(stdout.split('\0').some(field=>field===`worktree ${expected}`||field===`worktree ${canonical}`))throw new Error('Restored worker worktree remains registered with Git; history was retained.');
        }
      }
      await updateTask(stateDir,task.id,n=>{const at=now();n.status='disposed';n.archivedAt=at;for(const assignment of n.assignments||[])if(assignment.status==='queued'){assignment.status='stopped';assignment.endedAt=at;assignment.stopReason='worker-archived';}n.archiveRestoration={...n.archiveRestoration,rearchivedAt:at};(n.history ||= []).push({id:`archive-restored:${request.id}`,actor:'controller',kind:'lifecycle',at,runId:n.runId||null,message:task.worktree?'Re-archived restored history after verified absent worktree and terminal execution. No environment cleanup was run.':'Re-archived restored history with no recorded worktree path. Resource cleanup remains unverified. No environment cleanup was run.'});const current=n.lifecycleRequests.find(r=>r.id===request.id);current.status='completed';current.handledAt=at;});
      return;
    }
    const environment=await reconcileEnvironment({stateDir,taskId:task.id});if(environment?.pending)throw new Error('An environment command has not confirmed it stopped. Wait for its bounded supervisor before removing this worktree.');
    const previousExit=task.runDir?await json(path.join(task.runDir,'exit.json')):null;if(task.harnessStarted&&!connectionEnded(task,previousExit))throw new Error('This worker has no matching confirmed terminal record. Preserve this environment until its process ownership can be reconciled.');
    if(task.runnerPid&&alive(task.runnerPid)&&!(await json(path.join(task.runDir,'exit.json'))))throw new Error('Wait until the worker has stopped before removing its environment.');
    if(task.worktree){
      const actual=await realpath(task.worktree),repo=await realpath(task.repositoryPath||task.fixtureRepo);
      const expected=project?.mode==='repository'?path.join(await selectWorktreeRoot(stateDir,task),task.worktreeName||task.id):path.join((await fixture()).base,task.worktreeName||`worker-${task.id}`);
      if(actual!==await realpath(expected)||actual===repo)throw new Error('Worktree ownership could not be verified; nothing was removed.');
      const {stdout:changes}=await exec('git',['-C',actual,'status','--porcelain']);if(changes.trim())throw new Error('This worktree contains changes. Review and preserve them before removing it.');
      const existing=await json(environmentFile(stateDir,task.id));if(existing?.preset)throw new Error('Obsolete project-specific state was retained; no cleanup protocol was executed.');
      if(existing?.kind==='project-execution')await disposeProjectEnvironment({plan:project?.worker?.environment?.executionPlan,stateDir,taskId:task.id,worktree:task.worktree,repositoryPath:task.repositoryPath,baseCommit:task.baseCommit,onEvidence:e=>updateTask(stateDir,task.id,n=>{n.environment=e;})});
      else await runEnvironmentHooks({stateDir,taskId:task.id,worktree:task.worktree,hooks:project?.worker?.environment||{},phases:['cleanup'],existing,env:applyProjectToolchain(existing?.toolchain),onEvidence:e=>updateTask(stateDir,task.id,n=>{n.environment=e;})});
      await ensureArchiveExecutionStopped(stateDir,await readTask(stateDir,task.id));
      await exec('git',['-C',repo,'worktree','remove',actual]);
    }
    await updateTask(stateDir,task.id,n=>{n.status='disposed';n.disposedAt=now();n.archivedAt=n.disposedAt;for(const assignment of n.assignments||[])if(assignment.status==='queued'){assignment.status='stopped';assignment.endedAt=n.disposedAt;assignment.stopReason='worker-archived';}n.endedAt=n.endedAt||n.disposedAt;if(n.execution)n.execution={...n.execution,live:false,endedAt:n.endedAt};const current=n.lifecycleRequests?.find(r=>r.id===request.id);if(current){current.status='completed';current.handledAt=n.disposedAt;}});
  }
  async function completeStop(task,request){
    if(task.environment?.kind!=='project-execution')return false;
    if(!operations.has(task.id)){
      const action=request?.action|| (task.status==='pausing'?'pause':'stop'),preserveCompleted=request?.cooperative===true&&task.status==='completed';
      if(!preserveCompleted)await updateTask(stateDir,task.id,n=>{n.status=action==='pause'?'pausing':'stopping';});
      const operation=stopProjectEnvironment({plan:project?.worker?.environment?.executionPlan,stateDir,taskId:task.id,cooperative:request?.cooperative===true,onEvidence:environment=>updateTask(stateDir,task.id,n=>{n.environment=environment;})})
        .then(()=>updateTask(stateDir,task.id,n=>{n.status=preserveCompleted?'completed':action==='pause'?'paused':'stopped';n.endedAt=now();if(n.execution)n.execution={...n.execution,live:false,endedAt:n.endedAt};const current=n.lifecycleRequests?.find(r=>r.id===request?.id);if(current){current.status='completed';current.handledAt=now();}}))
        .catch(async error=>{if(request)await finishRequest(task.id,request.id,error.message);if(preserveCompleted)await updateTask(stateDir,task.id,n=>{n.environmentStopFailure=error.message;attention(n,`${n.runId}:environment-stop-failure`,'blocked',`Completed work was retained, but project environment stop failed: ${error.message}`);});else await fail(task.id,`Project environment stop failed: ${error.message}`);})
        .finally(()=>operations.delete(task.id));operations.set(task.id,operation);
    }return true;
  }
  async function lifecycle(task){
    if(operations.has(task.id))return task;
    const request=(task.lifecycleRequests||[]).find(r=>['pending','processing'].includes(r.status));if(!request)return task;
    try{
      if(request.expectedRunId!==undefined&&request.expectedRunId!==(task.runId||null))throw new Error('Worker run changed. Refresh its status before retrying.');
      if(request.status==='pending')task=await updateTask(stateDir,task.id,n=>{n.lifecycleRequests.find(r=>r.id===request.id).status='processing';});
      if(['pause','stop'].includes(request.action)){
        const exit=task.runDir?await json(path.join(task.runDir,'exit.json')):null;
        if(request.cooperative===true&&confirmedExit(task,exit)&&!launches.has(task.id)){
          const result=task.reports.find(r=>r.runId===task.runId&&r.kind==='result');
          if(task.status!=='completed'&&exit.exitCode===0&&exit.completedTurn&&exit.threadId&&result){
            try{await verify(task,exit,result);task=await readTask(stateDir,task.id);}catch(error){await fail(task.id,`Completion verification failed: ${error.message}`);throw error;}
          }
          if(task.status==='completed'){
            if(await completeStop(task,request))return await readTask(stateDir,task.id);
            await finishRequest(task.id,request.id);return await readTask(stateDir,task.id);
          }
        }
        if(launches.has(task.id)){
          task=await updateTask(stateDir,task.id,n=>{
            const current=n.lifecycleRequests?.find(r=>r.id===request.id);
            // Preparation completes outside this tick. Never overwrite its terminal
            // transition from a request snapshot read before that completion.
            if(current?.status!=='processing')return;
            if(['paused','stopped'].includes(n.status)){current.status='completed';current.handledAt=now();return;}
            n.status=request.action==='pause'?'pausing':'stopping';
          });
          return task;
        }
        const priorEnvironment=await reconcileEnvironment({stateDir,taskId:task.id,stop:request.cooperative!==true});
        if(priorEnvironment?.pending){await updateTask(stateDir,task.id,n=>{n.status=request.action==='pause'?'pausing':'stopping';n.environment=priorEnvironment;});return await readTask(stateDir,task.id);}
        if(exit&&task.harnessStarted&&!confirmedExit(task,exit))throw new Error('Worker commands have no matching confirmed terminal record. No stop completion was claimed.');
        if(!task.harnessStarted||confirmedExit(task,exit)){
          if(await completeStop(task,request))return await readTask(stateDir,task.id);
          await updateTask(stateDir,task.id,n=>{n.status=request.action==='pause'?'paused':'stopped';n.endedAt=exit?.at||now();if(n.execution)n.execution={...n.execution,live:false,endedAt:n.endedAt};const current=n.lifecycleRequests?.find(r=>r.id===request.id);if(current){current.status='completed';current.handledAt=now();}});await finishRequest(task.id,request.id);return await readTask(stateDir,task.id);
        }
        if(!task.runDir)throw new Error('Worker ownership is unknown; no process was stopped.');
        await atomic(path.join(task.runDir,'control.json'),{runId:task.runId,requestId:request.id,action:request.action,cooperative:request.cooperative===true,at:now()});
        task=await updateTask(stateDir,task.id,n=>{n.status=request.action==='pause'?'pausing':'stopping';});
      }else if(['resume','start'].includes(request.action)&&task.threadId&&task.worktree){
        if(task.archiveRestoration?.requiresRecovery)throw new Error('This history-only record has no available worker environment.');
        if(await nativeConnectionLive(task))return task;
        // An explicit resume after an ended assignment repeats its direction;
        // retain the previous result rather than rewriting its immutable record.
        if(currentAssignment(task).status==='completed'&&!(task.assignments||[]).some(item=>item.status==='queued'&&item.id!==task.currentAssignmentId)){
          const requestId=`resume-${createHash('sha256').update(request.id).digest('hex').slice(0,32)}`;
          task=await requestWorkerFollowup(stateDir,{taskId:task.id,requestId,brief:currentAssignment(task).brief,ticket:currentAssignment(task).ticket});
        }
        task=await activateFollowup(task);
        task=await updateTask(stateDir,task.id,n=>{n.status='resume_queued';n.retainedDirection=true;n.failure=null;delete n.capacityWait;startupQueued.delete(n.id);});await finishRequest(task.id,request.id);
      }else if(request.action==='retry_setup'){
        throw new Error('Setup is agent-initiated. Read get_project_environment and execute the existing project command through native tools; Crew does not replay setup.');
      }else if(['resume','start'].includes(request.action)){
        if(task.archiveRestoration?.requiresRecovery)throw new Error('This restored record has history only; its working directory is unavailable.');
        if(await nativeConnectionLive(task))return task;
        if(task.harnessStarted&&!confirmedExit(task,task.runDir?await json(path.join(task.runDir,'exit.json')):null))throw new Error('The previous native connection has no confirmed exit; preserve its context.');
        if(task.worktree&&!task.threadId&&task.harnessStarted)throw new Error('This worker has no saved native conversation to resume. Its working directory and evidence are retained.');
        if(!task.harnessStarted&&task.runId)await capacity.releasePreparation({taskId:task.id,runId:task.runId});
        task=await updateTask(stateDir,task.id,n=>{n.status='queued';n.failure=null;startupQueued.delete(n.id);});await finishRequest(task.id,request.id);
      }else if(['reconcile_plan','retire_missing'].includes(request.action)){
        if(await admissionHeld({taskId:task.id,resume:false}))throw new Error('Recovery is held while the manager or application reserves lifecycle changes. Return to work before recovery.');
        if(launches.has(task.id))throw new Error('Worker preparation is still active. Wait for a safe stopped boundary before recovery.');
        const operation=applyProjectRecovery({stateDir,task,project,mode:request.action,request})
          .then(value=>updateTask(stateDir,task.id,n=>{
            if((n.runId||null)!==request.expectedRunId)throw new Error('Worker run changed during recovery. Preserve its decision evidence.');
            if(request.action==='reconcile_plan')n.environment=value;
            else {
              n.status='disposed';n.disposedAt=now();n.archivedAt=n.disposedAt;for(const assignment of n.assignments||[])if(assignment.status==='queued'){assignment.status='stopped';assignment.endedAt=n.disposedAt;assignment.stopReason='worker-archived';}n.endedAt=n.endedAt||n.disposedAt;
              n.retirement={reason:'worktree-already-missing',cleanupVerified:false,at:n.disposedAt,reviewHash:request.reviewHash,decision:request.decision};
              if(n.execution)n.execution={...n.execution,live:false,endedAt:n.endedAt};
              for(const item of n.attention)if(!item.ackedAt){item.ackedAt=n.disposedAt;item.resolution='Retired missing-worktree record; cleanup unverified';}
            }
            (n.history ||= []).push({id:`recovery:${request.id}`,actor:'controller',kind:'recovery',at:now(),runId:n.runId||null,message:request.action==='reconcile_plan'?'Applied reviewed compatible lifecycle configuration. Setup and worker execution were not started.':'Retired an already missing and unregistered worktree record. Resource cleanup was not independently verified.',evidence:[`Review ${request.reviewHash}`,request.decision]});
            const current=n.lifecycleRequests.find(r=>r.id===request.id);current.status='completed';current.handledAt=now();
          }))
          .catch(error=>finishRequest(task.id,request.id,error.message)).finally(()=>operations.delete(task.id));
        operations.set(task.id,operation);return task;
      }else if(['dispose','archive'].includes(request.action)){
        if(!['paused','stopped','completed','failed','blocked'].includes(task.status))throw new Error('Stop this worker before removing its environment.');
        if(!operations.has(task.id)){const operation=dispose(task,request).catch(error=>finishRequest(task.id,request.id,error.message)).finally(()=>operations.delete(task.id));operations.set(task.id,operation);}return task;
      }else throw new Error('Unknown worker action.');
    }catch(error){await finishRequest(task.id,request.id,error.message);}
    return await readTask(stateDir,task.id);
  }
  async function reconcile(task){
    if (project && task.projectId !== project.id && !(project.mode === 'fixture' && !task.projectId)) throw new Error('Stored task belongs to another project; refusing to process it');
    if(isArchivedTask(task))return;
    // Durable supervisor evidence wins over a controller write interrupted at spawn.
    // A pending spawn intent without an owner/terminal record remains uncertain and
    // cannot be treated as a never-executed preparation or silently relaunched.
    if(task.runDir){
      const started=await json(path.join(task.runDir,'started.json')),owner=await json(path.join(task.runDir,'owner.json')),runtime=await json(path.join(task.runDir,'runtime.json')),exit=await json(path.join(task.runDir,'exit.json'));
      const config=await json(path.join(task.runDir,'config.json'));
      const claim=config?.runId===task.runId&&await readFile(path.join(task.runDir,'runner.claim')).then(()=>true).catch(error=>{if(error.code==='ENOENT')return false;throw error;});
      const matching=[started,owner,runtime,exit].some(record=>record?.runId===task.runId);
      if(matching||claim){const pid=started?.runId===task.runId?started.pid:owner?.runId===task.runId?owner.supervisorPid:null;const threadId=runtime?.runId===task.runId?runtime.threadId:exit?.runId===task.runId?exit.threadId:null;
        if(task.harnessStarted!==true||(pid&&task.runnerPid!==pid)||(threadId&&task.threadId!==threadId))task=await updateTask(stateDir,task.id,n=>{n.harnessStarted=true;if(pid)n.runnerPid=pid;if(threadId)n.threadId=threadId;});
      }
    }
    if(task.runDir){
      const terminal=await json(path.join(task.runDir,'exit.json'));
      const evidence=await json(path.join(task.runDir,'worktree-evidence.json'));
      if(confirmedExit(task,terminal)&&evidence?.taskId===task.id&&evidence.runId===task.runId&&evidence.assignmentId===currentAssignment(task).id&&/^[a-f0-9]{64}$/.test(evidence.fingerprint||'')&&task.retainedWorktreeEvidence?.runId!==task.runId){
        task=await updateTask(stateDir,task.id,n=>{if(n.runId===evidence.runId&&currentAssignment(n).id===evidence.assignmentId)n.retainedWorktreeEvidence={runId:evidence.runId,assignmentId:evidence.assignmentId,fingerprint:evidence.fingerprint,at:evidence.at};});
      }
    }
    task=await lifecycle(task);
    if(task.archiveRestoration?.requiresRecovery)return;
    if(!task.runDir)return;
    const runtime=await json(path.join(task.runDir,'runtime.json')),started=await json(path.join(task.runDir,'started.json')),owner=await json(path.join(task.runDir,'owner.json')),exit=await json(path.join(task.runDir,'exit.json'));
    if(started?.runId===task.runId&&task.runnerPid!==started.pid)task=await updateTask(stateDir,task.id,n=>{n.runnerPid=started.pid;});
    if(runtime?.runId===task.runId&&runtime.threadId&&task.threadId!==runtime.threadId)task=await updateTask(stateDir,task.id,n=>{n.threadId=runtime.threadId;});
    const modelEvidence=await json(path.join(task.runDir,'model-selection.json'));
    if(modelEvidence?.runId===task.runId&&modelEvidence.requestId===task.modelSelection?.id&&JSON.stringify(task.modelSelection.runtime)!==JSON.stringify(modelEvidence)){
      task=await updateTask(stateDir,task.id,n=>{
        if(n.runId!==modelEvidence.runId||n.modelSelection?.id!==modelEvidence.requestId)return;
        n.modelSelection={...n.modelSelection,status:modelEvidence.status,message:modelEvidence.message,runtime:modelEvidence};
        if(['selected','failed','rerouted'].includes(modelEvidence.status)){
          const id=`model:${modelEvidence.requestId}:${modelEvidence.runId}:${modelEvidence.status}`;
          if(!n.history.some(item=>item.id===id))n.history.push({id,actor:'controller',kind:'model_selection',message:modelEvidence.message,at:modelEvidence.at,runId:n.runId});
        }
      });
    }
    const protocolError=await json(path.join(task.runDir,'protocol-error.json'));
    if(protocolError?.runId===task.runId&&!task.attention.some(item=>item.id===`${task.runId}:native-protocol-error`)){
      task=await updateTask(stateDir,task.id,n=>{attention(n,`${n.runId}:native-protocol-error`,'blocked','Worker approval or lifecycle transport needs review. Pending requests and owned process evidence were retained; no automatic response was sent.');});
    }
    const currentExit=exit?.runId===task.runId?exit:null;
    if(currentExit?.connectionClosed===true&&currentExit.ownership?.remaining?.length&&!(task.retainedResourceRuns||[]).some(item=>item.runId===task.runId)){
      task=await updateTask(stateDir,task.id,n=>{(n.retainedResourceRuns||=[]).push({runId:n.runId,at:currentExit.at});});
    }
    const isLive=!currentExit&&await ownedRunnerAlive(task);
    const spawnAgeMs=Date.now()-Date.parse(task.spawnIntentAt||(started?.runId===task.runId?started.at:null)||task.startedAt||task.launchAt);
    const workerStarted=(owner?.runId===task.runId&&Number.isInteger(owner.workerPid))||(currentExit&&Number.isInteger(currentExit.workerPid));
    const startAt=started?.runId===task.runId?started.at:owner?.runId===task.runId?owner.at:currentExit?.at;
    if(workerStarted&&(task.execution?.live!==isLive||(currentExit&&!(task.accountedRuns||[]).includes(task.runId))||(isLive&&Date.now()-Date.parse(task.execution?.observedAt||0)>=1000))){
      task=await updateTask(stateDir,task.id,n=>{
        n.startedAt=startAt;n.accountedRuns=n.accountedRuns||[];
        if(currentExit&&!n.accountedRuns.includes(n.runId)){n.activeMs=(n.activeMs||0)+Math.max(0,Date.parse(currentExit.at)-Date.parse(startAt));n.accountedRuns.push(n.runId);}
        n.execution={...n.execution,runId:n.runId,live:isLive,stopConfirmed:currentExit?.stopConfirmed??null,supervisorPid:n.runnerPid,startedAt:startAt,endedAt:currentExit?.at||null,totalMs:(n.activeMs||0)+(isLive?Math.max(0,Date.now()-Date.parse(startAt)):0),observedAt:now()};
      });
    }
    if(['stopping','pausing'].includes(task.status)){
      if(!task.harnessStarted)return;
      if(confirmedExit(task,exit)){const request=(task.lifecycleRequests||[]).find(r=>r.status==='processing');if(await completeStop(task,request))return;await updateTask(stateDir,task.id,n=>{n.status=n.status==='pausing'?'paused':'stopped';n.endedAt=exit.at;const current=n.lifecycleRequests?.find(r=>r.id===request?.id);if(current){current.status='completed';current.handledAt=now();}});if(request)await finishRequest(task.id,request.id);}
      else if(!isLive&&spawnAgeMs>15000){const request=(task.lifecycleRequests||[]).find(r=>r.status==='processing');if(request)await finishRequest(task.id,request.id,'Supervisor disappeared without a stop confirmation. No unrelated process was killed.');await fail(task.id,'Supervisor disappeared without a stop confirmation.');}
      return;
    }
    if(!['running','awaiting_answer','resume_queued','verifying','blocked'].includes(task.status))return;
    for(const report of task.reports.filter(r=>r.runId===task.runId&&!(task.handledReports||[]).includes(`${r.runId}:${r.reportId}`))){
      task=await updateTask(stateDir,task.id,n=>{
        n.handledReports=n.handledReports||[];n.handledReports.push(`${report.runId}:${report.reportId}`);
        if(report.kind==='progress')n.progress=report.message;
        if(report.kind==='question'){n.answer=null;n.question={id:report.reportId,message:report.message,runId:report.runId};n.status='awaiting_answer';attention(n,`${report.runId}:${report.reportId}`,'question',report.message);}
        if(report.kind==='blocked'){n.status='blocked';attention(n,`${report.runId}:${report.reportId}`,'blocked',report.message);}
        if(report.kind==='result'){n.status='verifying';n.candidateReportId=report.reportId;}
      });
    }
    if(exit?.runId===task.runId){
      if(exit.threadId&&task.threadId!==exit.threadId)task=await updateTask(stateDir,task.id,n=>{n.threadId=exit.threadId;});
      // A queued native continuation uses fresh connection liveness. A saved
      // descendant-exit flag is historical evidence, never direction admission.
      if(task.status==='resume_queued')return;
      if(!connectionEnded(task,exit)){await fail(task.id,'Native worker connection has no confirmed terminal record; preserve its context.');return;}
      if(exit.stopped&&task.status!=='resume_queued'){await updateTask(stateDir,task.id,n=>{n.status=exit.stopAction==='pause'?'paused':'stopped';n.endedAt=exit.at;});return;}
      if(task.status==='resume_queued')return;
      if(exit.nativeTurnStatus==='interrupted'&&!exit.error){await updateTask(stateDir,task.id,n=>{n.status='stopped';n.endedAt=exit.at;n.nativeTurnStatus='interrupted';attention(n,`${n.runId}:native-interrupted`,'blocked','Codex ended this worker turn after an interruption or canceled approval. Its worktree and history are retained; no successful result is claimed. Discuss explicit resume with the manager.');});return;}
      if(exit.exitCode!==0||!exit.completedTurn){await fail(task.id,`Worker exited without successful turn: ${exit.error||`exit ${exit.exitCode}`}.`);return;}
      if(['resume_queued','awaiting_answer','blocked'].includes(task.status))return;
      if(task.status==='verifying'){const report=task.reports.find(r=>r.runId===task.runId&&r.reportId===task.candidateReportId);if(!report)throw new Error('Missing candidate result report.');try{await verify(task,exit,report);}catch(error){await fail(task.id,`Completion verification failed: ${error.message}`);}}
      else if(project?.mode==='repository'||task.retainedDirection)await verify(task,exit,{runId:task.runId,kind:'result',message:exit.finalMessage||'Native Codex turn completed.',evidence:[]});
      else await fail(task.id,'Worker exited without a durable question or result.');
    }else if(!isLive&&spawnAgeMs>15000)await fail(task.id,'Worker supervisor disappeared without a terminal record. Not relaunched automatically.');
  }
  async function tick(){
    if(busy||stopped)return;busy=true;
    try{
      processSnapshot=await snapshotProcesses();
      const foreign=task=>project&&task.projectId!==project.id&&!(project.mode==='fixture'&&!task.projectId);
      controllerError=null;
      for(const task of await loadTasks(stateDir)){if(foreign(task)){controllerError='Stored task belongs to another project; refusing to process it';continue;}try{await reconcile(task);}catch(error){await fail(task.id,`Worker controller error: ${error.message}`).catch(()=>{});}}
      for(const retained of await loadTasks(stateDir)){if(foreign(retained))continue;try{await activateFollowup(retained);}catch(error){await updateTask(stateDir,retained.id,n=>{const pending=(n.assignments||[]).find(a=>a.status==='queued'&&a.id!==n.currentAssignmentId);if(pending)n.followupWait=error.message;});}}
      const tasks=await loadTasks(stateDir);
      for(const task of tasks){
        if(stopped)break;
        if(foreign(task)||launches.has(task.id)||!['queued','resume_queued'].includes(task.status)||!task.threadId||!task.worktree)continue;
        if(await admissionHeld({taskId:task.id,resume:true}))continue;
        try{if(await nativeConnectionLive(task))continue;}
        catch(error){await updateTask(stateDir,task.id,n=>{n.capacityWait=error.message;});continue;}
        const runId=randomUUID(),admission=await capacity.acquire({taskId:task.id,runId,replaceConnection:true,previousRunId:task.runId});
        if(!admission.admitted){await updateTask(stateDir,task.id,n=>{if(n.runId===task.runId)n.capacityWait=admission.admissionPaused?'Native execution is held for an update.':'Waiting for shared native execution capacity.';});continue;}
        const job=launchContinuation(task,runId);launches.set(task.id,job);
        // Publish the reserved native run before considering new-worker slots.
        // Preparation here is local context I/O; no project command is run.
        try{await job;}catch(error){controllerError=error.message;}finally{launches.delete(task.id);}
      }
      const shared = await capacity.view(); maxConcurrent = shared.limit;
      for(const task of tasks){
        if(stopped)break;
        if(await admissionHeld({taskId:task.id,resume:task.status==='resume_queued'}))continue;
        if(foreign(task)||launches.has(task.id)||task.threadId&&task.worktree)continue;
        if(task.status==='launching'&&Date.now()-Date.parse(task.launchAt)>=15000)await fail(task.id,'Launch interrupted; inspect its environment before restarting.');
        if(!['queued','resume_queued'].includes(task.status))continue;
        if(task.archiveRestoration?.requiresRecovery){await fail(task.id,'This restored worker is history only and requires explicit recovery before lifecycle execution.');continue;}
        // Restart reconciles running work but never dispatches a stored backlog.
        if(startupQueued.has(task.id)){
          // Lifecycle start/resume explicitly removes this hold. Otherwise only
          // a changed durable answer can authorize dispatch; timestamps and
          // unrelated render/attention updates never replay old authorization.
          if(JSON.stringify(task.answer||null)===startupQueued.get(task.id))continue;
          startupQueued.delete(task.id);
        }
        if(task.harnessStarted&&!confirmedExit(task,task.runDir?await json(path.join(task.runDir,'exit.json')):null))continue;
        const runId=randomUUID();const admission=await capacity.acquire({taskId:task.id,runId});maxConcurrent=admission.limit;
        if(!admission.admitted){await updateTask(stateDir,task.id,n=>{if(n.status!==task.status||n.runId!==task.runId||!['queued','resume_queued'].includes(n.status))return;n.capacityWait=admission.admissionPaused?'Waiting while Crew prepares an update':'Waiting for shared worker capacity';});continue;}
        await updateTask(stateDir,task.id,n=>{delete n.capacityWait;});
        const job=launch(task,task.status==='resume_queued',runId);launches.set(task.id,job);void job.catch(error=>{controllerError=error.message;}).finally(()=>{launches.delete(task.id);void tick();});
      }
    }catch(error){controllerError=error.message;}
    finally{const view={tasks:await loadTasks(stateDir).catch(()=>[]),error:controllerError,maxConcurrent};const serialized=JSON.stringify(view);if(serialized!==lastView){lastView=serialized;onChange(view);}busy=false;}
  }
  timer=setInterval(()=>void tick(),250);await tick();
  return{view:async()=>({tasks:await loadTasks(stateDir),error:controllerError,maxConcurrent}),tick,stop:async()=>{if(stopped)return;stopped=true;clearInterval(timer);while(busy)await new Promise(r=>setTimeout(r,20));await Promise.allSettled([...launches.values(),...operations.values()]);await unlink(lockPath);}};
}
