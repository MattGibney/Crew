import {discoverProjectExecutionPlan} from './project-execution-plan.mjs';
import {resolveProjectToolchain,applyProjectToolchain} from './project-toolchain.mjs';
// Deterministic local controller. Polls files; never polls a model or starts voice.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, rename, mkdtemp, open, unlink, realpath } from 'node:fs/promises';
import { runEnvironmentHooks, environmentFile, reconcileEnvironment } from './worker-environment.mjs';
import {prepareProjectEnvironment,stopProjectEnvironment,disposeProjectEnvironment,inspectProjectEnvironment} from './project-environment.mjs';
import {selectWorktreeRoot,ensureWorktreeRoot} from './worktree-paths.mjs';
import {snapshotProcesses} from './process-ownership.mjs';
import { randomUUID } from 'node:crypto';
import { promptSnapshot, promptVersion } from './prompt-settings.mjs';
import path from 'node:path';
import os from 'node:os';
import { loadTasks, readTask, updateTask } from './orchestration-store.mjs';
import { createGlobalCapacity } from './global-capacity.mjs';
const exec = promisify(execFile);
const now = () => new Date().toISOString();
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function json(file) { try { return JSON.parse(await readFile(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
async function atomic(file, value) { const temp = `${file}.${process.pid}.tmp`; await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); await rename(temp, file); }
const confirmedExit=(task,exit)=>Boolean(exit&&exit.runId===task.runId&&exit.stopConfirmed===true);
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
  const launches=new Map(), launchAbort=new Map(), operations=new Map();
  let processSnapshot=new Map();
  async function ownedRunnerAlive(task){if(!task.runnerPid||!task.runDir)return false;const owner=await json(path.join(task.runDir,'owner.json'));const actual=processSnapshot.get(task.runnerPid),expected=owner?.supervisorIdentity;return Boolean(owner?.runId===task.runId&&owner.supervisorPid===task.runnerPid&&actual&&expected&&actual.start===expected.start&&actual.commandHash===expected.commandHash&&!actual.state?.includes('Z'));}
  let maxConcurrent=Number.isInteger(project?.worker?.maxConcurrent)?Math.max(1,Math.min(8,project.worker.maxConcurrent)):2;
  const capacity = await createGlobalCapacity({ dir: globalCapacity?.dir || path.join(stateDir, 'capacity'), stateDir, ...(globalCapacity?.dir ? {} : {limit:maxConcurrent}) });
  if (globalCapacity?.limit !== undefined) throw new Error('Configure the global worker limit once through configureGlobalCapacity, not per controller.');
  const ownedTask=task=>!project||task.projectId===project.id||(project.mode==='fixture'&&!task.projectId);
  const startupTasks=(await loadTasks(stateDir)).filter(ownedTask);
  for(const task of startupTasks){
    const interrupted=new Set((task.lifecycleRequests||[]).filter(request=>['start','resume'].includes(request.action)&&['pending','processing'].includes(request.status)).map(request=>request.id));
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
  async function launch(task, resume, runId) {
    if(stopped||await admissionHeld({taskId:task.id,resume})){await capacity.releasePreparation({taskId:task.id,runId});return;}
    if(task.harnessStarted&&!confirmedExit(task,task.runDir?await json(path.join(task.runDir,'exit.json')):null)){await fail(task.id,'The previous worker run has no matching confirmed terminal record. Preserve its environment until ownership is reconciled.');await capacity.releasePreparation({taskId:task.id,runId});return;}
    if (resume && project?.mode === 'repository' && task.workerSandbox !== project.worker?.sandbox) {
      await fail(task.id, 'Worker sandbox configuration changed since this task started; refusing resume or permission escalation.');
      await capacity.releasePreparation({taskId:task.id,runId});return;
    }
    const abort=new AbortController();launchAbort.set(task.id,abort);
    let workerDispatched=false;
    try {
    await updateTask(stateDir, task.id, next => {
      if (next.status !== (resume ? 'resume_queued' : 'queued')) throw new Error('Task status changed before launch.');
      next.status = 'launching'; next.harnessStarted=false; next.runnerPid=null; next.failure=null; next.startedAt=null; next.endedAt=null; next.execution=null; next.spawnIntentAt=null; next.previousRunId = next.runId || null; next.runId = runId; next.launchAt = now();
      if (resume) for (const item of next.attention) if (item.kind === 'question' && !item.ackedAt) item.ackedAt = now();
    });
    const pauseBoundary=async()=>{for(;;){if(stopped){const error=new Error('Controller stopped at a safe preparation boundary. Existing environment evidence was retained.');error.controllerShutdown=true;throw error;}const latest=await readTask(stateDir,task.id);const request=latest.lifecycleRequests?.find(r=>['pending','processing'].includes(r.status)&&r.action==='pause'&&r.cooperative===true);if(request){await updateTask(stateDir,task.id,n=>{n.status='pausing';const r=n.lifecycleRequests.find(r=>r.id===request.id);r.status='processing';});const error=new Error('Cooperative update pause reached a safe preparation boundary.');error.cooperative=true;throw error;}if(!await admissionHeld({taskId:task.id,resume}))return;await new Promise(r=>setTimeout(r,50));}};
      await pauseBoundary();
      if (project && task.projectId !== project.id && !(project.mode === 'fixture' && !task.projectId)) throw new Error('Task project does not match this controller');
      const repositoryMode = project?.mode === 'repository';
      // Capture at the first actual launch, before provisioning. Retained workers
      // keep the same behavior across answers, pause/resume and controller restart.
      let workerPromptSnapshot = task.workerPromptSnapshot;
      if (!workerPromptSnapshot && (resume || task.threadId)) {
        const previous = task.runDir ? await json(path.join(task.runDir, 'config.json')) : null;
        if (!previous || typeof previous.workerPrompt !== 'string' || !previous.workerPrompt.trim()) throw new Error('Original worker prompt is unavailable; refusing to resume with changed behavior.');
        workerPromptSnapshot = promptSnapshot(previous.workerPrompt);
      }
      if (!workerPromptSnapshot) workerPromptSnapshot = getWorkerPrompt ? await getWorkerPrompt() : promptSnapshot(workerPrompt || await readFile(path.join(sourceDir, 'prompts', 'worker.md'), 'utf8'));
      if (!workerPromptSnapshot || promptVersion(workerPromptSnapshot.text) !== workerPromptSnapshot.version) throw new Error('Worker prompt snapshot version is invalid.');
      await updateTask(stateDir, task.id, next => { next.workerPromptSnapshot = workerPromptSnapshot; });

      if (project && !project.readiness?.ready) throw new Error('Project configuration is incomplete; no worktree was created');
      if (project && !['read-only', 'workspace-write'].includes(project.worker?.sandbox)) throw new Error('Invalid worker sandbox configuration');
      let meta;
      if (repositoryMode) {
        const repository = project.repositories.find(repo => repo.id === task.repositoryId);
        if (!repository?.path || !repository.baseRef) throw new Error('Configured repository path and baseRef are required');
        const repo = await realpath(repository.path);
        const { stdout: top } = await exec('git', ['-C', repo, 'rev-parse', '--show-toplevel']);
        if (await realpath(top.trim()) !== repo) throw new Error('Configured repository path must be the Git root');
        if (repository.baseRef.startsWith('-')) throw new Error('Invalid configured baseRef');
        const { stdout: commit } = await exec('git', ['-C', repo, 'rev-parse', '--verify', '--end-of-options', `${repository.baseRef}^{commit}`]);
        meta = { repo, commit: commit.trim(), base: await selectWorktreeRoot(stateDir,task), repositoryId: repository.id };
      } else meta = await fixture();
      let worktree = task.worktree;
      if (!resume && !worktree) {
        const worktreeName=task.worktreeName||`crew-${randomUUID().replace(/-/g,'')}`;
        await updateTask(stateDir,task.id,next=>{next.worktreeName=worktreeName;if(repositoryMode)next.worktreeRoot=meta.base;});
        if(repositoryMode)await ensureWorktreeRoot(stateDir,meta.base);
        task.worktreeName=worktreeName;
        worktree = path.join(meta.base, worktreeName);
        await exec('git', ['-C', meta.repo, 'worktree', 'add', '--detach', worktree, meta.commit]);
      }
      if ((resume||task.worktree) && task.repositoryPath !== meta.repo) throw new Error('Repository changed since this task started; review before resuming');
      if(resume||task.worktree){const {stdout}=await exec('git',['-C',worktree,'rev-parse','HEAD']);if(stdout.trim()!==task.baseCommit)throw new Error('Worker baseline changed; refusing resume.');}
      if(task.worktree){const actual=await realpath(worktree),expected=await realpath(path.join(meta.base,task.worktreeName||(repositoryMode?task.id:`worker-${task.id}`)));const {stdout:list}=await exec('git',['-C',meta.repo,'worktree','list','--porcelain']);if(actual!==expected||actual===meta.repo||!list.includes(`worktree ${actual}\n`))throw new Error('Retained worktree ownership could not be verified.');}
      const runDir = path.join(stateDir, 'runs', task.id, runId); await mkdir(runDir, { recursive: true, mode: 0o700 });
      await updateTask(stateDir,task.id,next=>{next.worktree=worktree;next.repositoryPath=meta.repo;next.baseCommit=task.worktree?task.baseCommit:meta.commit;next.runDir=runDir;next.harnessStarted=false;next.fixtureRepo=repositoryMode?null:meta.repo;next.fixtureCommit=repositoryMode?null:meta.commit;});
      const existingEnvironment=await json(environmentFile(stateDir,task.id));
      if(existingEnvironment?.preset)throw new Error('An obsolete project-specific environment is retained. No project protocol was executed; preserve its state and recover it with its original project tooling.');
      await pauseBoundary();
      const plainDiscovery=repositoryMode&&!project?.worker?.environment?.executionPlan?await discoverProjectExecutionPlan({path:meta.repo,ref:task.worktree?task.baseCommit:meta.commit}):null;
      const plainToolchain=repositoryMode&&!project?.worker?.environment?.executionPlan
        ?await resolveProjectToolchain({worktree,baseCommit:task.worktree?task.baseCommit:meta.commit,plan:{sources:plainDiscovery?.sources||[]},retained:existingEnvironment?.toolchain}):null;
      await pauseBoundary();
      const environment=project?.worker?.environment?.executionPlan
        ?await prepareProjectEnvironment({plan:project.worker.environment.executionPlan,stateDir,taskId:task.id,worktree,repositoryPath:meta.repo,baseCommit:task.worktree?task.baseCommit:meta.commit,resume,signal:abort.signal,pauseBoundary,onEvidence:environment=>updateTask(stateDir,task.id,next=>{next.environment=environment;})})
        :await runEnvironmentHooks({stateDir,taskId:task.id,worktree,hooks:project?.worker?.environment||{},phases:resume?['resume','ready']:['bootstrap','start','ready'],existing:existingEnvironment|| (plainToolchain?{id:`crew-${randomUUID().replace(/-/g,'')}`,taskId:task.id,worktree,hooks:[],toolchain:plainToolchain}:null),toolchain:plainToolchain,env:plainToolchain?applyProjectToolchain(plainToolchain):process.env,signal:abort.signal,pauseBoundary,onEvidence:environment=>updateTask(stateDir,task.id,next=>{next.environment=environment;})});
      if(abort.signal.aborted)throw new Error('Worker environment preparation canceled.');

      await pauseBoundary();
      const config = { project, workerPrompt: workerPromptSnapshot.text, workerPromptVersion: workerPromptSnapshot.version, sandbox: repositoryMode ? project.worker.sandbox : 'read-only', timeoutMs: project?.worker?.timeoutMs || 300000, taskId: task.id, runId, ticket: task.ticket, brief: task.brief, environment, answer: resume ? task.answer : null, threadId: resume ? task.threadId : null, worktree, stateDir, executable, mcpScript: path.join(sourceDir, 'orchestration-mcp.mjs') };
      if (resume && !config.threadId) throw new Error('Cannot resume: no recorded worker Codex session.');
      await atomic(path.join(runDir, 'config.json'), config);
      await updateTask(stateDir, task.id, next => { next.worktree = worktree; next.fixtureRepo = repositoryMode ? null : meta.repo; next.fixtureCommit = repositoryMode ? null : meta.commit; next.repositoryPath = meta.repo; next.baseCommit = task.worktree ? task.baseCommit : meta.commit; next.workerSandbox = config.sandbox; next.runDir = runDir; next.runId = runId; next.status = 'running'; next.harnessStarted='pending'; next.spawnIntentAt=now(); next.startedAt=null; next.endedAt=null; next.execution=null; next.handledReports = next.handledReports || []; });
      await pauseBoundary();
      const runner = spawn(process.execPath, [path.join(sourceDir, 'worker-runner.mjs'), path.join(runDir, 'config.json')], { cwd: sourceDir, detached: true, stdio: 'ignore', env:applyProjectToolchain(environment.toolchain) });workerDispatched=true;
      await new Promise((resolve, reject) => { runner.once('spawn', resolve); runner.once('error', reject); }); runner.unref();
      await updateTask(stateDir, task.id, next => { next.runnerPid = runner.pid; next.harnessStarted=true; });
    } catch (error) { if(!workerDispatched)await updateTask(stateDir,task.id,n=>{n.harnessStarted=false;n.spawnIntentAt=null;});if(error.controllerShutdown===true){await updateTask(stateDir,task.id,n=>{n.status='paused';n.endedAt=now();n.preparationPause={reason:'controller-shutdown',at:n.endedAt};});return;}const latest=await readTask(stateDir,task.id);if(['stopping','pausing'].includes(latest.status)){if(latest.environment?.kind==='project-execution'){try{await stopProjectEnvironment({stateDir,taskId:task.id,cooperative:error.cooperative===true||latest.lifecycleRequests?.some(r=>r.status==='processing'&&r.cooperative===true),onEvidence:environment=>updateTask(stateDir,task.id,n=>{n.environment=environment;})});}catch(stopError){await fail(task.id,`Project environment shutdown was not confirmed: ${stopError.message}`);for(const r of latest.lifecycleRequests||[])if(r.status==='processing')await finishRequest(task.id,r.id,stopError.message);return;}}await updateTask(stateDir,task.id,n=>{n.status=n.status==='pausing'?'paused':'stopped';n.endedAt=now();for(const r of n.lifecycleRequests||[])if(r.status==='processing'){r.status='completed';r.handledAt=now();}});}else await fail(task.id, `Worker launch failed: ${error.message}`); } finally {launchAbort.delete(task.id);const latest=await readTask(stateDir,task.id);const environment=await reconcileEnvironment({stateDir,taskId:task.id});if(latest.runId!==runId||(!latest.harnessStarted&&!environment?.pending))await capacity.releasePreparation({taskId:task.id,runId});}
  }
  async function verify(task, exit, report) {
    if (exit.exitCode !== 0 || !exit.completedTurn || !exit.threadId) throw new Error('Worker did not produce a successful completed Codex turn and session.');
    if(report?.runId!==task.runId||report.kind!=='result'||typeof report.message!=='string'||!report.message.trim())throw new Error('Worker did not provide a non-empty durable result for this run.');
    const successfulCommands = exit.commands.filter(c => c.exitCode === 0);
    if (!successfulCommands.length) throw new Error('No successful worker command evidence was recorded.');
    const { stdout: root } = await exec('git', ['-C', task.worktree, 'rev-parse', '--show-toplevel']);
    const { stdout: changes } = await exec('git', ['-C', task.worktree, 'status', '--porcelain']);
    const { stdout: commit } = await exec('git', ['-C', task.worktree, 'rev-parse', 'HEAD']);
    const repositoryMode = project?.mode === 'repository';
    const repoPath = repositoryMode ? task.repositoryPath : task.fixtureRepo;
    const { stdout: list } = await exec('git', ['-C', repoPath, 'worktree', 'list', '--porcelain']);
    if (repositoryMode) {
      const actualWorktree = await realpath(task.worktree), actualRepo = await realpath(repoPath);
      const expectedWorktree = await realpath(path.join(await selectWorktreeRoot(stateDir,task), task.worktreeName||task.id));
      if (await realpath(root.trim()) !== actualWorktree || actualWorktree !== expectedWorktree || actualWorktree === actualRepo || !list.includes(`worktree ${actualWorktree}\n`) || commit.trim() !== task.baseCommit) throw new Error('Repository worktree isolation or baseline verification failed');
      if (task.workerSandbox === 'read-only' && changes.trim()) throw new Error('Read-only worker changed the worktree');
      const verification = { scope: 'execution-evidence-only', semanticCorrectnessVerified: false, productionValidated: false, worktree: actualWorktree, commit: commit.trim(), clean: !changes.trim(), changedFiles: changes.trim() ? changes.trimEnd().split('\n') : [], successfulCommands: successfulCommands.length, at: now() };
      await updateTask(stateDir, task.id, next => { next.status = 'completed'; next.endedAt=now(); next.threadId = exit.threadId; next.result = { message: report.message, evidence: report.evidence, finalMessage: exit.finalMessage, verification }; next.question = null; attention(next, `${next.runId}:completion`, 'completion', 'Worker finished; isolated execution evidence checked. Code correctness and production behavior are not independently validated. Review the result and tests with the manager.'); });
      return;
    }
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
  async function dispose(task){
    const environment=await reconcileEnvironment({stateDir,taskId:task.id});if(environment?.pending)throw new Error('An environment command has not confirmed it stopped. Wait for its bounded supervisor before removing this worktree.');
    const previousExit=task.runDir?await json(path.join(task.runDir,'exit.json')):null;if(task.harnessStarted&&(!previousExit||previousExit.runId!==task.runId||previousExit.stopConfirmed!==true))throw new Error('This worker has no matching confirmed terminal record. Preserve this environment until its process ownership can be reconciled.');
    if(task.runnerPid&&alive(task.runnerPid)&&!(await json(path.join(task.runDir,'exit.json'))))throw new Error('Wait until the worker has stopped before removing its environment.');
    if(task.worktree){
      const actual=await realpath(task.worktree),repo=await realpath(task.repositoryPath||task.fixtureRepo);
      const expected=project?.mode==='repository'?path.join(await selectWorktreeRoot(stateDir,task),task.worktreeName||task.id):path.join((await fixture()).base,task.worktreeName||`worker-${task.id}`);
      if(actual!==await realpath(expected)||actual===repo)throw new Error('Worktree ownership could not be verified; nothing was removed.');
      const {stdout:changes}=await exec('git',['-C',actual,'status','--porcelain']);if(changes.trim())throw new Error('This worktree contains changes. Review and preserve them before removing it.');
      const existing=await json(environmentFile(stateDir,task.id));if(existing?.preset)throw new Error('Obsolete project-specific state was retained; no cleanup protocol was executed.');
      if(existing?.kind==='project-execution')await disposeProjectEnvironment({stateDir,taskId:task.id,worktree:task.worktree,repositoryPath:task.repositoryPath,baseCommit:task.baseCommit,onEvidence:e=>updateTask(stateDir,task.id,n=>{n.environment=e;})});
      else await runEnvironmentHooks({stateDir,taskId:task.id,worktree:task.worktree,hooks:project?.worker?.environment||{},phases:['cleanup'],existing,env:applyProjectToolchain(existing?.toolchain),onEvidence:e=>updateTask(stateDir,task.id,n=>{n.environment=e;})});
      await exec('git',['-C',repo,'worktree','remove',actual]);
    }
    await updateTask(stateDir,task.id,n=>{n.status='disposed';n.disposedAt=now();n.endedAt=n.endedAt||now();if(n.execution)n.execution={...n.execution,live:false,endedAt:n.endedAt};});
  }
  async function completeStop(task,request){
    if(task.environment?.kind!=='project-execution')return false;
    if(!operations.has(task.id)){
      const action=request?.action|| (task.status==='pausing'?'pause':'stop'),preserveCompleted=request?.cooperative===true&&task.status==='completed';
      if(!preserveCompleted)await updateTask(stateDir,task.id,n=>{n.status=action==='pause'?'pausing':'stopping';});
      const operation=stopProjectEnvironment({stateDir,taskId:task.id,cooperative:request?.cooperative===true,onEvidence:environment=>updateTask(stateDir,task.id,n=>{n.environment=environment;})})
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
          if(request.cooperative!==true&&task.lifecycleRequests?.find(r=>r.id===request.id)?.status==='processing')launchAbort.get(task.id)?.abort();
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
      }else if(['resume','start'].includes(request.action)){
        if(!['queued','paused','stopped','failed','blocked','awaiting_answer'].includes(task.status))throw new Error('This worker is already active or finished.');
        if(task.question&&task.question.runId===task.runId&&task.answer?.questionId!==task.question.id)throw new Error('Answer this worker’s question before resuming it.');
        const environment=await reconcileEnvironment({stateDir,taskId:task.id});if(environment?.pending)throw new Error('An earlier environment command is still running or lacks a stop confirmation. Wait for its bounded supervisor and retry.');
        if(task.harnessStarted&&!confirmedExit(task,task.runDir?await json(path.join(task.runDir,'exit.json')):null))throw new Error('The previous worker run has no matching confirmed terminal record. Wait for verified shutdown before resuming.');
        if(task.worktree&&!task.threadId&&task.harnessStarted)throw new Error('This worker has no saved conversation to resume. Preserve its worktree and start another worker.');
        if(!task.harnessStarted&&task.runId)await capacity.releasePreparation({taskId:task.id,runId:task.runId});
        task=await updateTask(stateDir,task.id,n=>{n.status=n.threadId?'resume_queued':'queued';n.failure=null;startupQueued.delete(n.id);});await finishRequest(task.id,request.id);
      }else if(request.action==='dispose'){
        if(!['paused','stopped','completed','failed','blocked'].includes(task.status))throw new Error('Stop this worker before removing its environment.');
        if(!operations.has(task.id)){const operation=dispose(task).then(()=>finishRequest(task.id,request.id)).catch(error=>finishRequest(task.id,request.id,error.message)).finally(()=>operations.delete(task.id));operations.set(task.id,operation);}return task;
      }else throw new Error('Unknown worker action.');
    }catch(error){await finishRequest(task.id,request.id,error.message);}
    return await readTask(stateDir,task.id);
  }
  async function reconcile(task){
    if (project && task.projectId !== project.id && !(project.mode === 'fixture' && !task.projectId)) throw new Error('Stored task belongs to another project; refusing to process it');
    if(task.environment?.kind==='project-execution'&&!launches.has(task.id)&&!operations.has(task.id)){const environment=await inspectProjectEnvironment({stateDir,taskId:task.id,processes:processSnapshot,onEvidence:environment=>updateTask(stateDir,task.id,n=>{n.environment=environment;})});if(environment)task.environment=environment;}
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
    if(task.environment?.preset)throw new Error('Obsolete project-specific state is retained; recover it with its original project tooling.');
    task=await lifecycle(task);
    if(!task.runDir)return;
    const runtime=await json(path.join(task.runDir,'runtime.json')),started=await json(path.join(task.runDir,'started.json')),owner=await json(path.join(task.runDir,'owner.json')),exit=await json(path.join(task.runDir,'exit.json'));
    if(started?.runId===task.runId&&task.runnerPid!==started.pid)task=await updateTask(stateDir,task.id,n=>{n.runnerPid=started.pid;});
    if(runtime?.runId===task.runId&&runtime.threadId&&task.threadId!==runtime.threadId)task=await updateTask(stateDir,task.id,n=>{n.threadId=runtime.threadId;});
    const protocolError=await json(path.join(task.runDir,'protocol-error.json'));
    if(protocolError?.runId===task.runId&&!task.attention.some(item=>item.id===`${task.runId}:native-protocol-error`)){
      task=await updateTask(stateDir,task.id,n=>{attention(n,`${n.runId}:native-protocol-error`,'blocked','Worker approval or lifecycle transport needs review. Pending requests and owned process evidence were retained; no automatic response was sent.');});
    }
    const currentExit=exit?.runId===task.runId?exit:null;
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
      if(!confirmedExit(task,exit)){await fail(task.id,'Worker descendants have not confirmed they stopped; preserve its environment.');return;}
      if(exit.stopped&&task.status!=='resume_queued'){await updateTask(stateDir,task.id,n=>{n.status=exit.stopAction==='pause'?'paused':'stopped';n.endedAt=exit.at;});return;}
      if(task.status==='resume_queued')return;
      if(exit.nativeTurnStatus==='interrupted'&&!exit.error){await updateTask(stateDir,task.id,n=>{n.status='stopped';n.endedAt=exit.at;n.nativeTurnStatus='interrupted';attention(n,`${n.runId}:native-interrupted`,'blocked','Codex ended this worker turn after an interruption or canceled approval. Its worktree and history are retained; no successful result is claimed. Discuss explicit resume with the manager.');});return;}
      if(exit.exitCode!==0||!exit.completedTurn){await fail(task.id,`Worker exited without successful turn: ${exit.error||`exit ${exit.exitCode}`}.`);return;}
      if(['resume_queued','awaiting_answer','blocked'].includes(task.status))return;
      if(task.status==='verifying'){const report=task.reports.find(r=>r.runId===task.runId&&r.reportId===task.candidateReportId);if(!report)throw new Error('Missing candidate result report.');try{await verify(task,exit,report);}catch(error){await fail(task.id,`Completion verification failed: ${error.message}`);}}
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
      const tasks=await loadTasks(stateDir);
      const shared = await capacity.view(); maxConcurrent = shared.limit;
      for(const task of tasks){
        if(stopped)break;
        if(await admissionHeld({taskId:task.id,resume:task.status==='resume_queued'}))continue;
        if(foreign(task)||launches.has(task.id))continue;
        if(task.status==='launching'&&Date.now()-Date.parse(task.launchAt)>=15000)await fail(task.id,'Launch interrupted; inspect its environment before restarting.');
        if(!['queued','resume_queued'].includes(task.status))continue;
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
