import { isArchivedTask, activeTasks, archivedTasks } from '../../../worker-archive.mjs';
const HISTORY = new Set(['completed', 'failed', 'stopped', 'disposed', 'canceled', 'cancelled']);
const LABELS = { queued: 'Queued', launching: 'Preparing', running: 'Working', resume_queued: 'Resume queued', awaiting_answer: 'Needs your answer', blocked: 'Blocked', verifying: 'Checking result', pausing: 'Pausing', stopping: 'Stopping', paused: 'Paused', stopped: 'Stopped', completed: 'Completed', failed: 'Needs attention', disposed: 'Archived', removed: 'Archived', canceled: 'Canceled', cancelled: 'Canceled' };
export const currentAssignment = task => (task.assignments || []).find(item => item.id === task.currentAssignmentId) || { id: 'initial', ticket: task.ticket, brief: task.brief, status: task.status, result: task.result };
export const queuedAssignments = task => (task.assignments || []).filter(item => item.status === 'queued' && item.id !== task.currentAssignmentId);
export const canDiscussFollowup = task => Boolean(task.worktree) && !isArchivedTask(task) && !task.archiveRestoration?.requiresRecovery && task.status !== 'disposed' && !task.retirement;
export function workerFollowupRequest(task) {
  if (!canDiscussFollowup(task)) throw new Error('This worker has no retained worktree available for follow-up.');
  return `CREW_WORKER_FOLLOWUP_REVIEW\nI want to discuss another assignment for this retained worker: ${JSON.stringify({ taskId: task.id, expectedRunId: task.runId || null, expectedAssignmentId: currentAssignment(task).id })}. Read its current status first, then ask me for the new brief and explicit scope authorization. This message requests discussion only and does not authorize execution. After I authorize the specific work, use the manager follow-up assignment operation for this same worker, preserving its conversation, worktree, prior results and normal approvals. Queue direction if it is busy. Do not start a different worker, reinterpret a lifecycle resume as a new brief, or widen the previous assignment automatically.`;
}
export const pendingAttention = task => (task.attention || []).filter(item => !item.ackedAt);
export const pendingLifecycle = task => (task.lifecycleRequests || []).find(item => ['pending', 'processing'].includes(item.status));
export const workspaceWorkers = activeTasks;
export const archivedWorkers = (tasks, projectId, projectMode) => projectId ? archivedTasks(tasks.filter(task => task.projectId === projectId || projectMode === 'fixture' && !task.projectId)) : [];
export const workerSelectionRemoved = (tasks, id) => Boolean(id) && tasks.some(task => task.id === id && isArchivedTask(task));
export function groupWorkers(tasks) {
  const active = [], history = [];
  for (const task of workspaceWorkers(tasks)) {
    // Pending reviews, retained paused workers and observed live processes must never disappear into history.
    (HISTORY.has(task.status) && !pendingAttention(task).length && !pendingLifecycle(task) && !queuedAssignments(task).length && task.execution?.live !== true ? history : active).push(task);
  }
  return { active, history: history.sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0)), retained: workspaceWorkers(tasks).filter(task => task.worktree).length };
}
export function workerStatus(task) { if (task.archiveRestoration?.requiresRecovery) return 'History restored'; return task.retirement?.reason === 'worktree-already-missing' ? 'Retired' : LABELS[task.status] || 'Status unavailable'; }
export function workerProgress(task) {
  if(task.retirement?.reason === 'worktree-already-missing') return 'Worktree already missing. History retained; resource cleanup unverified.';
  if (queuedAssignments(task).length && typeof task.followupWait === 'string' && task.followupWait.trim()) return task.followupWait;
  if (['queued', 'resume_queued'].includes(task.status)) {
    // Only the controller knows whether capacity, an update or explicit manager start is blocking admission.
    if (typeof task.capacityWait === 'string' && task.capacityWait.trim()) return task.capacityWait;
    return task.status === 'resume_queued' ? 'Waiting to resume.' : 'Waiting to start.';
  }
  const assignment = currentAssignment(task);
  return task.failure || assignment.result?.message || task.progress || (task.status === 'launching' ? 'Preparing the project environment.' : 'Waiting for the next progress report.');
}
export function workerTiming(task, now = Date.now()) {
  const execution = task.execution;
  if (!execution || (execution.runId && execution.runId !== task.runId)) return { live: null, elapsed: null, observedAt: null };
  const observedAt = Date.parse(execution.observedAt), startedAt = Date.parse(execution.startedAt), endedAt = Date.parse(execution.endedAt);
  const fresh = Number.isFinite(observedAt) && now >= observedAt - 1000 && now - observedAt <= 15000;
  const live = execution.live === true ? fresh ? true : null : execution.live === false ? false : null;
  // A stopped-looking status or updatedAt is not evidence of the end of an execution.
  const end = Number.isFinite(endedAt) ? endedAt : live === true ? now : NaN;
  return { live, elapsed: Number.isFinite(startedAt) && Number.isFinite(end) && end >= startedAt ? end - startedAt : null, observedAt: Number.isFinite(observedAt) ? execution.observedAt : null };
}
export function formatElapsed(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const seconds = Math.floor(ms / 1000), minutes = Math.floor(seconds / 60), hours = Math.floor(minutes / 60);
  return hours ? `${hours}h ${minutes % 60}m` : minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}
export function workerActions(task) {
  if (isArchivedTask(task) || pendingLifecycle(task) || ['disposed', 'stopping', 'pausing'].includes(task.status)) return [];
  if (task.execution?.live === true) return ['pause', 'stop'];
  if (task.archiveRestoration?.requiresRecovery) return ['dispose'];
  if (['running', 'queued', 'launching', 'resume_queued', 'verifying', 'awaiting_answer'].includes(task.status)) return ['pause', 'stop'];
  if (['paused', 'stopped', 'failed', 'blocked'].includes(task.status)) return [...((task.environment?.kind==='project-execution'?(task.environment.setupAttempted&&!task.environment.prepared&&task.environment.hooks?.some(h=>h.phase==='setup'&&h.status==='failed')):(task.environment?.hooks?.some(h=>h.phase==='bootstrap'&&h.status==='failed')&&!task.environment.hooks.some(h=>h.phase==='bootstrap'&&h.status==='succeeded')))?['retry_setup']:[]),...(task.question?.runId === task.runId && task.answer?.questionId !== task.question.id ? [] : ['resume']), 'dispose'];
  return task.status === 'completed' ? [...(queuedAssignments(task).length ? ['resume'] : []), 'dispose'] : [];
}
export function workerActionRequest(task, action, id = `worker-${crypto.randomUUID()}`) {
  if (!workerActions(task).includes(action)) throw new Error('This worker action is no longer available. Refresh its status.');
  const selection = { taskId: task.id, action, actionId: id, expectedRunId: task.runId || null };
  return { requestId: id, text: `CREW_WORKER_ACTION\nI explicitly request this lifecycle action for the selected worker only: ${JSON.stringify(selection)}. Read local_orchestration.get_status for this task first. If its run ID differs from the selected expectedRunId (including a selected null), or the action is no longer valid, do not perform it; explain the changed state. Otherwise use local_orchestration.worker_action with this taskId, action, actionId and current expectedRunId when non-null. Reuse this actionId on retries. Preserve normal approvals. Do not launch a different worker, change the agreed brief, modify tickets, or open a microphone. Retry_setup explicitly authorizes rerunning the failed incomplete Setup or bootstrap command in the same worktree with latest saved settings; preserve partial files and old attempts, and never perform cleanup or reseeding beyond that declared command. Stop/pause retain partial work and evidence. Archive (the compatible dispose action) is authorized only through the existing safe teardown, which must refuse dirty or unresolved work and retain task records. Report queued intent separately from confirmed completion.` };
}

export function workerRecoveryReviewRequest(task) {
  if(task.archiveRestoration?.requiresRecovery || !task.worktree || !['failed','blocked','paused','stopped','completed'].includes(task.status) || pendingLifecycle(task)) throw new Error('Recovery review is not available for this task state.');
  return `CREW_WORKER_RECOVERY_REVIEW\nReview recovery options for only ${JSON.stringify({taskId:task.id,expectedRunId:task.runId||null})}. Read get_status and review_worker_recovery for reconcile_plan and retire_missing. Explain retained/current command differences, exact blockers and cleanup uncertainty. This requests review only: do not apply a recovery decision, start/resume work, stop a process, remove resources or retire records until I explicitly approve the exact reviewed action. Preserve history and normal approvals.`;
}
