// Deterministic local controller. Polls files; never polls a model or starts voice.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, rename, mkdtemp, open, unlink, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { loadTasks, readTask, updateTask } from './orchestration-store.mjs';
const exec = promisify(execFile);
const now = () => new Date().toISOString();
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function json(file) { try { return JSON.parse(await readFile(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
async function atomic(file, value) { const temp = `${file}.${process.pid}.tmp`; await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); await rename(temp, file); }
const attention = (task, id, kind, message) => { if (!task.attention.some(a => a.id === id)) task.attention.push({ id, kind, message, at: now() }); };
export async function createController({ stateDir, sourceDir, executable, project = null, workerPrompt = '', onChange = () => {} }) {
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
  async function fixture() {
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
    await updateTask(stateDir, id, task => { task.status = 'failed'; task.failure = message; attention(task, `${task.runId || task.id}:failure`, 'failure', message); });
  }
  async function launch(task, resume) {
    if (resume && project?.mode === 'repository' && task.workerSandbox !== project.worker?.sandbox) {
      await fail(task.id, 'Worker sandbox configuration changed since this task started; refusing resume or permission escalation.');
      return;
    }
    const runId = randomUUID();
    await updateTask(stateDir, task.id, next => {
      if (next.status !== (resume ? 'resume_queued' : 'queued')) throw new Error('Task status changed before launch.');
      next.status = 'launching'; next.previousRunId = next.runId || null; next.runId = runId; next.launchAt = now();
      if (resume) for (const item of next.attention) if (item.kind === 'question' && !item.ackedAt) item.ackedAt = now();
    });
    try {
      if (project && task.projectId !== project.id && !(project.mode === 'fixture' && !task.projectId)) throw new Error('Task project does not match this controller');
      const repositoryMode = project?.mode === 'repository';
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
        meta = { repo, commit: commit.trim(), base: path.join(stateDir, 'worktrees'), repositoryId: repository.id };
        await mkdir(meta.base, { recursive: true, mode: 0o700 });
      } else meta = await fixture();
      let worktree = task.worktree;
      if (!resume) {
        worktree = path.join(meta.base, repositoryMode ? task.id : `worker-${task.id}`);
        await exec('git', ['-C', meta.repo, 'worktree', 'add', '--detach', worktree, meta.commit]);
      }
      if (resume && repositoryMode && (task.repositoryPath !== meta.repo || task.baseCommit !== meta.commit)) throw new Error('Repository configuration or base ref changed since this task started; review before resuming');
      const runDir = path.join(stateDir, 'runs', task.id, runId); await mkdir(runDir, { recursive: true, mode: 0o700 });
      const config = { project, workerPrompt, sandbox: repositoryMode ? project.worker.sandbox : 'read-only', timeoutMs: project?.worker?.timeoutMs || 300000, taskId: task.id, runId, ticket: task.ticket, brief: task.brief, answer: resume ? task.answer : null, threadId: resume ? task.threadId : null, worktree, stateDir, executable, mcpScript: path.join(sourceDir, 'orchestration-mcp.mjs') };
      if (resume && !config.threadId) throw new Error('Cannot resume: no recorded worker Codex session.');
      await atomic(path.join(runDir, 'config.json'), config);
      await updateTask(stateDir, task.id, next => { next.worktree = worktree; next.fixtureRepo = repositoryMode ? null : meta.repo; next.fixtureCommit = repositoryMode ? null : meta.commit; next.repositoryPath = meta.repo; next.baseCommit = meta.commit; next.workerSandbox = config.sandbox; next.runDir = runDir; next.runId = runId; next.status = 'running'; next.handledReports = next.handledReports || []; });
      const runner = spawn(process.execPath, [path.join(sourceDir, 'worker-runner.mjs'), path.join(runDir, 'config.json')], { cwd: sourceDir, detached: true, stdio: 'ignore' });
      await new Promise((resolve, reject) => { runner.once('spawn', resolve); runner.once('error', reject); }); runner.unref();
      await updateTask(stateDir, task.id, next => { next.runnerPid = runner.pid; });
    } catch (error) { await fail(task.id, `Worker launch failed: ${error.message}`); }
  }
  async function verify(task, exit, report) {
    if (exit.exitCode !== 0 || !exit.completedTurn || !exit.finalMessage || !exit.threadId) throw new Error('Worker did not produce a successful completed Codex turn and final message.');
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
      const expectedWorktree = await realpath(path.join(stateDir, 'worktrees', task.id));
      if (await realpath(root.trim()) !== actualWorktree || actualWorktree !== expectedWorktree || actualWorktree === actualRepo || !list.includes(`worktree ${actualWorktree}\n`) || commit.trim() !== task.baseCommit) throw new Error('Repository worktree isolation or baseline verification failed');
      if (task.workerSandbox === 'read-only' && changes.trim()) throw new Error('Read-only worker changed the worktree');
      const verification = { scope: 'execution-evidence-only', semanticCorrectnessVerified: false, productionValidated: false, worktree: actualWorktree, commit: commit.trim(), clean: !changes.trim(), changedFiles: changes.trim() ? changes.trimEnd().split('\n') : [], successfulCommands: successfulCommands.length, at: now() };
      await updateTask(stateDir, task.id, next => { next.status = 'completed'; next.threadId = exit.threadId; next.result = { message: report.message, evidence: report.evidence, finalMessage: exit.finalMessage, verification }; next.question = null; attention(next, `${next.runId}:completion`, 'completion', 'Worker finished; isolated execution evidence checked. Code correctness and production behavior are not independently validated. Review the result and tests with the manager.'); });
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
      next.status = 'completed'; next.threadId = exit.threadId; next.result = { message: report.message, evidence: report.evidence, finalMessage: exit.finalMessage, verification };
      next.question = null;
      attention(next, `${next.runId}:completion`, 'completion', 'Worker finished; isolated read-only execution and check results verified. Review with the manager when ready.');
    });
  }
  async function tick() {
    if (busy || stopped) return;
    busy = true;
    try {
      for (let task of await loadTasks(stateDir)) {
        if (project && task.projectId !== project.id && !(project.mode === 'fixture' && !task.projectId)) throw new Error('Stored task belongs to another project; refusing to process it');
        if (task.status === 'queued') { await launch(task, false); continue; }
        if (task.status === 'launching') { if (Date.now() - Date.parse(task.launchAt) > 15000) await fail(task.id, 'Launch interrupted before a runner was recorded. Not relaunched automatically.'); continue; }
        if (!['running', 'awaiting_answer', 'resume_queued', 'verifying'].includes(task.status)) continue;
        const runtime = task.runDir ? await json(path.join(task.runDir, 'runtime.json')) : null;
        const started = task.runDir ? await json(path.join(task.runDir, 'started.json')) : null;
        if (started?.runId === task.runId && Number.isInteger(started.pid) && task.runnerPid !== started.pid) task = await updateTask(stateDir, task.id, next => { next.runnerPid = started.pid; });
        if (runtime?.runId === task.runId && runtime.threadId && task.threadId !== runtime.threadId) task = await updateTask(stateDir, task.id, next => { next.threadId = runtime.threadId; });
        const reports = task.reports.filter(r => r.runId === task.runId && !(task.handledReports || []).includes(`${r.runId}:${r.reportId}`));
        for (const report of reports) task = await updateTask(stateDir, task.id, next => {
          if (next.runId !== report.runId) return;
          next.handledReports.push(`${report.runId}:${report.reportId}`);
          if (report.kind === 'progress') next.progress = report.message;
          if (report.kind === 'question') { next.question = { id: report.reportId, message: report.message, runId: report.runId }; next.status = 'awaiting_answer'; attention(next, `${report.runId}:${report.reportId}`, 'question', report.message); }
          if (report.kind === 'blocked') { next.status = 'blocked'; attention(next, `${report.runId}:${report.reportId}`, 'blocked', report.message); }
          if (report.kind === 'result') { next.status = 'verifying'; next.candidateReportId = report.reportId; }
        });
        const exit = task.runDir ? await json(path.join(task.runDir, 'exit.json')) : null;
        if (exit && exit.runId === task.runId) {
          if (exit.threadId && task.threadId !== exit.threadId) task = await updateTask(stateDir, task.id, next => { next.threadId = exit.threadId; });
          if (exit.exitCode !== 0 || !exit.completedTurn) { await fail(task.id, `Worker exited without successful turn: ${exit.error || `exit ${exit.exitCode}`}.`); continue; }
          if (task.status === 'resume_queued') { await launch(task, true); continue; }
          if (task.status === 'awaiting_answer' || task.status === 'blocked') continue;
          if (task.status === 'verifying') {
            const report = task.reports.find(r => r.runId === task.runId && r.reportId === task.candidateReportId);
            if (!report) throw new Error('Missing candidate result report.');
            try { await verify(task, exit, report); } catch (error) { await fail(task.id, `Completion verification failed: ${error.message}`); }
          } else await fail(task.id, 'Worker exited without a durable question or result.');
        } else if (!task.runnerPid || !alive(task.runnerPid)) {
          if (Date.now() - Date.parse(task.launchAt) > 15000) await fail(task.id, 'Worker supervisor disappeared without a terminal record. Not relaunched automatically.');
        }
      }
      controllerError = null;
    } catch (error) { controllerError = error.message; }
    finally {
      const view = { tasks: await loadTasks(stateDir).catch(() => []), error: controllerError };
      const serialized = JSON.stringify(view);
      if (serialized !== lastView) { lastView = serialized; onChange(view); }
      busy = false;
    }
  }
  timer = setInterval(() => void tick(), 1000); await tick();
  return { view: async () => ({ tasks: await loadTasks(stateDir), error: controllerError }), tick, stop: async () => { stopped = true; clearInterval(timer); while (busy) await new Promise(r => setTimeout(r, 20)); await unlink(lockPath); } };
}
