// AI-018: deterministic, durable pause/update/resume coordination. No model loop.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const HOLDING = new Set(['draining', 'ready', 'installing', 'resuming', 'blocked', 'canceled']);
const ORIGINAL_ACTIVE = new Set(['queued', 'launching', 'running', 'resume_queued', 'verifying']);
const TERMINAL = new Set(['completed', 'failed', 'canceled', 'cancelled', 'disposed']);
const MANAGER_IDLE = new Set(['idle', 'ready', 'stopped', 'failed', 'error', 'completed', 'interrupted', 'canceled', 'cancelled']);
const unanswered = task => !!(task.question && task.answer?.questionId !== task.question.id);
const clone = value => value === undefined ? undefined : structuredClone(value);
export function isUpdatePlanHolding(plan) {
  // Unknown persisted phases fail closed rather than admitting work.
  return !!plan && (HOLDING.has(plan.phase) || plan.phase !== 'complete');
}
export async function readUpdatePlan(stateDir) {
  let data;
  try { data = JSON.parse(await fs.readFile(path.join(stateDir, 'update-plan.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw new Error('Update plan is unreadable; review retained state before starting work.'); }
  if (!data || data.schema !== 1 || data.kind !== 'pause-update' || data.consent !== true || !Number.isFinite(Date.parse(data.createdAt)) || typeof data.id !== 'string' || !Array.isArray(data.targets) || !Array.isArray(data.progress) || ![...HOLDING, 'canceled', 'complete'].includes(data.phase)
      || typeof data.targetVersion !== 'string' || typeof data.fromVersion !== 'string' || !data.manager
      || data.targets.some(t => !t || typeof t.taskId !== 'string' || typeof t.pauseActionId !== 'string' || typeof t.resumeActionId !== 'string')) throw new Error('Update plan is malformed; review retained state before starting work.');
  return data;
}
export function createUpdatePlan({ stateDir, version, getView, getManager, stopVoice, interruptManager, requestAction, activity, onChange = () => {}, now = () => Date.now(), timeoutMs = 120000 }) {
  let plan = null;
  let serial = Promise.resolve();
  const stamp = () => new Date(now()).toISOString();
  const ready = readUpdatePlan(stateDir).then(value => { plan = value; });
  const transact = fn => {
    const result = serial.then(() => ready).then(fn);
    serial = result.catch(() => {});
    return result;
  };
  async function save() {
    plan.updatedAt = stamp();
    await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
    const file = path.join(stateDir, 'update-plan.json');
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      const handle = await fs.open(temp, 'wx', 0o600);
      try { await handle.writeFile(`${JSON.stringify(plan, null, 2)}\n`); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temp, file);
    } finally { await fs.unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    try { onChange(clone(plan)); } catch { /* UI notification cannot undo durable state. */ }
  }
  function progress(message, taskId = null) {
    plan.progress.push({ at: stamp(), message, ...(taskId ? { taskId } : {}) });
    plan.progress = plan.progress.slice(-120);
  }
  async function blocked(reason) {
    plan.phase = 'blocked'; plan.reasons = [reason]; progress(reason); await save(); return clone(plan);
  }
  const idleManager = manager => !!manager && !manager.activeTurnId && manager.workStarting === false && MANAGER_IDLE.has(manager.status)
    && Array.isArray(manager.approvals) && manager.approvals.length === 0;
  const taskNeedsDrain = task => ORIGINAL_ACTIVE.has(task.status) || task.updateEvidence?.worker === 'live'
    || task.updateEvidence?.runtime === 'live' || task.updateEvidence?.hooks?.some(hook => hook.state === 'live');
  function addTargets(tasks) {
    for (const task of tasks) {
      if (!taskNeedsDrain(task) || plan.targets.some(t => t.taskId === task.id)) continue;
      const wasEligible = ORIGINAL_ACTIVE.has(task.status) && !unanswered(task);
      plan.targets.push({ taskId: task.id, originalRunId: task.runId || null, originalStatus: task.status, resumeEligible: wasEligible,
        pauseActionId: randomUUID(), resumeActionId: randomUUID(), progress: 'captured', pauseConfirmed: false });
      progress('Captured worker before update.', task.id);
    }
  }
  async function viewTasks() {
    const view = await getView();
    if (!view || view.error || !Array.isArray(view.tasks)) throw new Error('Worker activity is unavailable.');
    return view.tasks;
  }
  function shutdownConfirmed(task) {
    const evidence = task.updateEvidence;
    return evidence ? ['absent', 'stopped'].includes(evidence.worker) && ['absent', 'stopped'].includes(evidence.runtime) && Array.isArray(evidence.hooks) && evidence.hooks.every(hook => hook.state === 'stopped')
      : !task.harnessStarted || (task.execution?.live === false && task.execution?.stopConfirmed === true);
  }
  function pauseConfirmed(task, target) {
    const action = task.lifecycleRequests?.find(r => r.id === target.pauseActionId);
    return action?.status === 'completed' && action.action === 'pause' && (action.expectedRunId ?? null) === target.originalRunId
      && (task.runId || null) === target.originalRunId && ['paused', 'stopped'].includes(task.status)
      && shutdownConfirmed(task);
  }
  async function drain() {
    if (now() - Date.parse(plan.createdAt) > timeoutMs) return blocked('Pausing timed out. Review retained work; no process was force-stopped.');
    let tasks = await viewTasks();
    addTargets(tasks); await save(); // Rescan includes tasks created while the manager was draining.
    if (!plan.voiceClosed) {
      await stopVoice(); plan.voiceClosed = true; progress('Voice disconnected; it will remain disconnected.'); await save();
    }
    const manager = await getManager();
    const reasons = [];
    let interruptTurn = null;
    let managerConflict = false;
    if (!idleManager(manager)) {
      if (manager?.approvals?.length) reasons.push('Resolve pending manager approvals; updates never answer them automatically.');
      else if (!manager?.activeTurnId) reasons.push(manager?.workStarting === true ? 'Waiting for the manager turn to start before requesting its interruption.' : 'Manager terminal activity is unavailable; review its retained conversation.');
      else if (plan.manager.interruptTurnId && plan.manager.interruptTurnId !== manager.activeTurnId) managerConflict = true;
      else {
        if (!plan.manager.interruptRequested) interruptTurn = manager.activeTurnId;
        reasons.push('Waiting for confirmed manager interruption.');
      }
    } else plan.manager.interrupted = plan.manager.originalActive && plan.manager.interruptRequested;
    // Workers drain independently of manager approvals/terminal evidence. Re-scan each tick.
    tasks = await viewTasks(); addTargets(tasks); await save();
    for (const target of plan.targets) {
      const task = tasks.find(item => item.id === target.taskId);
      if (!task) { reasons.push(`Worker ${target.taskId} is unavailable.`); continue; }
      if (pauseConfirmed(task, target)) {
        if (!target.pauseConfirmed) progress('Worker pause confirmed by lifecycle and process evidence.', target.taskId);
        target.pauseConfirmed = true; target.progress = 'paused'; continue;
      }
      if (TERMINAL.has(task.status) && shutdownConfirmed(task)) {
        target.resumeEligible = false; target.progress = 'finished-before-pause'; continue;
      }
      const action = task.lifecycleRequests?.find(r => r.id === target.pauseActionId);
      if (action?.status === 'failed') return blocked(`Worker ${target.taskId} could not pause safely. Review its lifecycle evidence.`);
      if ((task.runId || null) !== target.originalRunId) return blocked(`Worker ${target.taskId} changed runs; automatic update is blocked.`);
      if (!action) {
        target.progress = 'pause-requested'; await save();
        await requestAction({ taskId: target.taskId, actionId: target.pauseActionId, action: 'pause', expectedRunId: target.originalRunId, cooperative: true });
      }
      reasons.push(`Waiting for worker ${target.taskId} to pause cooperatively.`);
    }
    if (managerConflict) return blocked('Manager turn changed while draining; review retained conversation before updating.');
    if (interruptTurn) {
      plan.manager.interruptTurnId = interruptTurn; plan.manager.interruptRequested = true; await save();
      await interruptManager({ expectedTurnId: interruptTurn });
      progress('Requested manager interruption; waiting for terminal evidence.'); await save();
    }
    const fresh = await activity();
    if (!fresh || fresh.safe !== true) reasons.push(...(fresh?.reasons?.length ? fresh.reasons : ['Fresh idle evidence is unavailable.']));
    plan.reasons = [...new Set(reasons)];
    if (!reasons.length) { plan.phase = 'ready'; progress('All captured work is safely paused. Ready to install.'); }
    await save(); return clone(plan);
  }
  async function resume() {
    const tasks = await viewTasks();
    for (const target of plan.targets) {
      if (!target.resumeEligible || !target.pauseConfirmed) continue;
      const task = tasks.find(item => item.id === target.taskId);
      if (!task) return blocked(`Paused worker ${target.taskId} is unavailable; no automatic resume.`);
      const existing = task.lifecycleRequests?.find(r => r.id === target.resumeActionId);
      if (existing) {
        if (existing.action !== 'resume' || (existing.expectedRunId ?? null) !== target.originalRunId) return blocked(`Resume correlation changed for ${target.taskId}.`);
        if (existing.status === 'failed') return blocked(`Worker ${target.taskId} could not resume; review its evidence.`);
        if (existing.status === 'completed') { target.progress = 'resumed'; continue; }
        plan.reasons = [`Waiting for worker ${target.taskId} resume admission.`]; await save(); return clone(plan);
      }
      const pauseAction = task.lifecycleRequests?.find(r => r.id === target.pauseActionId);
      if (['queued', 'resume_queued'].includes(task.status) && !unanswered(task) && (task.runId || null) === target.originalRunId
          && pauseAction?.status === 'completed' && pauseAction.action === 'pause' && (pauseAction.expectedRunId ?? null) === target.originalRunId) {
        target.progress = 'user-queued'; continue;
      }
      if (unanswered(task) || !pauseConfirmed(task, target)) return blocked(`Worker ${target.taskId} needs manager review; its pause or question state changed.`);
      target.progress = 'resume-requested'; await save();
      await requestAction({ taskId: target.taskId, actionId: target.resumeActionId, action: 'resume', expectedRunId: target.originalRunId });
      plan.reasons = [`Waiting for worker ${target.taskId} resume admission.`]; await save(); return clone(plan);
    }
    plan.phase = 'complete'; plan.reasons = []; progress('Resume coordination finished: confirmed paused workers were queued for resume; never-paused queued work may continue. Other retained work needs manager review. Voice remains disconnected; manager input was not replayed.');
    await save(); return clone(plan);
  }
  const status = () => clone(plan);
  return {
    ready, status,
    begin: ({ targetVersion }) => transact(async () => {
      if (typeof targetVersion !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][\w.-]+)?$/.test(targetVersion) || targetVersion === version) throw new Error('A different valid target version is required.');
      if (isUpdatePlanHolding(plan)) {
        if (plan.targetVersion === targetVersion) return clone(plan);
        throw new Error('An update plan is already holding work.');
      }
      const manager = await getManager();
      const tasks = await viewTasks();
      plan = { schema: 1, kind: 'pause-update', consent: true, id: randomUUID(), targetVersion, fromVersion: version, phase: 'draining', createdAt: stamp(), updatedAt: stamp(), targets: [], progress: [], reasons: [], voiceClosed: false,
        manager: { originalActive: !idleManager(manager), originalTurnId: manager?.activeTurnId || null, interruptRequested: false, interrupted: false } };
      addTargets(tasks); progress('Update requested. New work admission is held.'); await save(); // Hold is durable before the first side effect.
      return clone(plan); // Tick performs side effects; the explicit action returns once intent is durable.
    }),
    tick: () => transact(async () => {
      if (!plan) return null;
      try { if (plan.phase === 'draining') return await drain(); if (plan.phase === 'resuming') return await resume(); }
      catch (error) { return blocked(`Update coordination failed: ${error.message}`); }
      return clone(plan);
    }),
    markInstalling: ({ planId, targetVersion } = {}) => transact(async () => {
      if (plan?.phase !== 'ready' || plan.id !== planId || plan.targetVersion !== targetVersion || plan.consent !== true) return { marked: false, plan: clone(plan) };
      const fresh = await activity();
      if (!fresh || fresh.safe !== true) { await blocked('Activity changed before install. Review work before retrying.'); return { marked: false, plan: clone(plan) }; }
      plan.phase = 'installing'; plan.reasons = []; progress('Install reserved; paused-work evidence retained.'); await save(); return { marked: true, plan: clone(plan) };
    }),
    markBlocked: (reason, { planId, targetVersion } = {}) => transact(async () => {
      if (!plan || plan.id !== planId || plan.targetVersion !== targetVersion || ['canceled', 'complete'].includes(plan.phase)) return clone(plan);
      return blocked(String(reason || 'Installation failed; retained paused work needs review.').slice(0, 1000));
    }),
    cancel: () => transact(async () => {
      if (!plan || ['complete', 'canceled'].includes(plan.phase)) return clone(plan);
      if (plan.phase === 'installing') throw new Error('Installation has begun; recover retained work after restart.');
      plan.phase = 'canceled'; plan.reasons = ['Paused work is retained. Choose Resume paused work to continue.']; progress('Update canceled; paused work was not silently resumed.'); await save(); return clone(plan);
    }),
    resumeAfterCancel: () => transact(async () => {
      if (!plan || !['canceled', 'blocked'].includes(plan.phase)) throw new Error('No canceled or blocked plan to resume.');
      // Reconcile pause requests that completed after cancellation, without creating new ones.
      const tasks = await viewTasks();
      for (const target of plan.targets) {
        const task = tasks.find(t => t.id === target.taskId);
        if (task && pauseConfirmed(task, target)) target.pauseConfirmed = true;
        const pauseAction = task?.lifecycleRequests?.find(r => r.id === target.pauseActionId);
        if (pauseAction && !['completed', 'failed'].includes(pauseAction.status)) throw new Error('A pause request is still pending; wait for confirmation before resuming.');
        if (!target.resumeEligible || target.pauseConfirmed) continue;
        if (!task || pauseAction?.status === 'failed') return blocked(`Worker ${target.taskId} never confirmed its update pause. Use Return to work for manager review; no resume was requested.`);
        const sameRun = (task.runId || null) === target.originalRunId;
        const queuedSafely = ['queued', 'resume_queued'].includes(task.status) && sameRun && !unanswered(task) && shutdownConfirmed(task)
          && (pauseAction?.status === 'completed' || (!pauseAction && task.harnessStarted !== true && task.execution?.live !== true));
        if (queuedSafely) {
          target.resumeEligible = false; target.progress = 'queued-without-resume';
          progress('Existing queued work was retained; no pause/resume completion was claimed.', target.taskId);
          continue;
        }
        if (!pauseAction && TERMINAL.has(task.status) && shutdownConfirmed(task)) {
          target.resumeEligible = false; target.progress = 'finished-before-pause';
          progress('Worker finished before a confirmed update pause; no resume was requested.', target.taskId);
          continue;
        }
        return blocked(`Worker ${target.taskId} never confirmed its update pause. Use Return to work for manager review; no resume was requested.`);
      }
      plan.phase = 'resuming'; plan.reasons = []; progress('User requested resuming retained paused work.'); await save(); return resume();
    }),
    releaseForReview: () => transact(async () => {
      if (!plan || !['canceled', 'blocked'].includes(plan.phase)) throw new Error('Only canceled or blocked update work can return to manager review.');
      plan.phase = 'complete'; plan.reasons = [];
      progress('User returned to work. Queued work may continue; paused workers remain paused for manager review. No resume requests were created.');
      await save(); return clone(plan);
    }),
    recover: () => transact(async () => {
      if (!plan) return null;
      if (plan.phase === 'installing') {
        if (version !== plan.targetVersion) return blocked('The target version was not installed. Paused work is retained; choose Resume paused work.');
        plan.phase = 'resuming'; progress('Target version confirmed; restoring only correlated plan-paused work.'); await save(); return resume();
      }
      if (plan.phase === 'resuming') return resume();
      return clone(plan);
    }),
  };
}
