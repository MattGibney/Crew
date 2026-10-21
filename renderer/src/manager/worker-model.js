const HISTORY = new Set(['completed', 'failed', 'stopped', 'disposed', 'canceled', 'cancelled']);
const LABELS = { queued: 'Queued', launching: 'Preparing', running: 'Working', resume_queued: 'Resume queued', awaiting_answer: 'Needs your answer', blocked: 'Blocked', verifying: 'Checking result', pausing: 'Pausing', stopping: 'Stopping', paused: 'Paused', stopped: 'Stopped', completed: 'Completed', failed: 'Needs attention', disposed: 'Removed', canceled: 'Canceled', cancelled: 'Canceled' };
export const pendingAttention = task => (task.attention || []).filter(item => !item.ackedAt);
export const pendingLifecycle = task => (task.lifecycleRequests || []).find(item => ['pending', 'processing'].includes(item.status));
export function groupWorkers(tasks) {
  const active = [], history = [];
  for (const task of tasks) {
    // Pending reviews, retained paused workers and observed live processes must never disappear into history.
    (HISTORY.has(task.status) && !pendingAttention(task).length && !pendingLifecycle(task) && task.execution?.live !== true ? history : active).push(task);
  }
  return { active, history: history.sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0)), retained: tasks.filter(task => task.worktree && task.status !== 'disposed').length };
}
export function workerStatus(task) { return LABELS[task.status] || 'Status unavailable'; }
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
  if (pendingLifecycle(task) || ['disposed', 'stopping', 'pausing'].includes(task.status)) return [];
  if (task.execution?.live === true) return ['pause', 'stop'];
  if (['running', 'queued', 'launching', 'resume_queued', 'verifying', 'awaiting_answer'].includes(task.status)) return ['pause', 'stop'];
  if (['paused', 'stopped', 'failed', 'blocked'].includes(task.status)) return [...(task.question?.runId === task.runId && task.answer?.questionId !== task.question.id ? [] : ['resume']), 'dispose'];
  return task.status === 'completed' ? ['dispose'] : [];
}
export function workerActionRequest(task, action, id = `worker-${crypto.randomUUID()}`) {
  if (!workerActions(task).includes(action)) throw new Error('This worker action is no longer available. Refresh its status.');
  const selection = { taskId: task.id, action, actionId: id, expectedRunId: task.runId || null };
  return { requestId: id, text: `CREW_WORKER_ACTION\nI explicitly request this lifecycle action for the selected worker only: ${JSON.stringify(selection)}. Read local_orchestration.get_status for this task first. If its run ID differs from the selected expectedRunId (including a selected null), or the action is no longer valid, do not perform it; explain the changed state. Otherwise use local_orchestration.worker_action with this taskId, action, actionId and current expectedRunId when non-null. Reuse this actionId on retries. Preserve normal approvals. Do not launch a different worker, change the agreed brief, modify tickets, or open a microphone. Stop/pause retain partial work and evidence. Dispose is authorized only through the existing safe teardown, which must refuse dirty or unresolved work and retain task records. Report queued intent separately from confirmed completion.` };
}
