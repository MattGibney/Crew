import type { WorkerTask, WorkerAction } from "../contracts/manager.js";
import {
  isArchivedTask,
  activeTasks,
  archivedTasks,
} from "../../../src/shared/worker-archive.mjs";
const HISTORY = new Set([
  "completed",
  "failed",
  "stopped",
  "disposed",
  "canceled",
  "cancelled",
]);
const LABELS: Record<string, string> = {
  queued: "Queued",
  launching: "Preparing",
  running: "Working",
  resume_queued: "Resume queued",
  awaiting_answer: "Needs your answer",
  blocked: "Blocked",
  verifying: "Checking result",
  pausing: "Pausing",
  stopping: "Stopping",
  paused: "Paused",
  stopped: "Stopped",
  completed: "Turn ended",
  failed: "Needs attention",
  disposed: "Archived",
  removed: "Archived",
  canceled: "Canceled",
  cancelled: "Canceled",
};
export const currentAssignment = (task: WorkerTask) =>
  (task.assignments || []).find(
    (item) => item.id === task.currentAssignmentId,
  ) || {
    id: "initial",
    ticket: task.ticket,
    workLink: task.workLink,
    brief: task.brief,
    status: task.status,
    result: task.result,
  };
export const queuedAssignments = (task: WorkerTask) =>
  (task.assignments || []).filter(
    (item) => item.status === "queued" && item.id !== task.currentAssignmentId,
  );
export const canDiscussFollowup = (task: WorkerTask) =>
  Boolean(task.worktree || task.threadId || task.execution?.live) &&
  !isArchivedTask(task) &&
  !task.archiveRestoration?.requiresRecovery &&
  task.status !== "disposed" &&
  !task.retirement;
export function workerFollowupRequest(task: WorkerTask) {
  if (!canDiscussFollowup(task))
    throw new Error(
      "This worker has no retained worktree available for follow-up.",
    );
  return `CREW_WORKER_DIRECTION\nContinue with this same retained worker: ${JSON.stringify({ taskId: task.id })}. Ask me what direction to send if I have not supplied it, then use assign_worker_followup with a stable requestId and my direction. Preserve this worker's Codex conversation, worktree and prior results. Queue while busy. Do not require worktree review, fingerprint adoption, a new ticket or an extra authorization statement. Pass through native Codex approvals normally.`;
}
export const pendingAttention = (task: WorkerTask) =>
  (task.attention || []).filter((item) => !item.ackedAt);
export const pendingLifecycle = (task: WorkerTask) =>
  (task.lifecycleRequests || []).find((item) =>
    ["pending", "processing"].includes(item.status),
  );
export const workspaceWorkers = activeTasks;
export const archivedWorkers = (
  tasks: WorkerTask[],
  projectId?: string,
  projectMode?: string,
) =>
  projectId
    ? archivedTasks(
        tasks.filter(
          (task) =>
            task.projectId === projectId ||
            (projectMode === "fixture" && !task.projectId),
        ),
      )
    : [];
export const workerSelectionRemoved = (
  tasks: WorkerTask[],
  id: string | null,
) =>
  Boolean(id) && tasks.some((task) => task.id === id && isArchivedTask(task));
export function groupWorkers(tasks: WorkerTask[]) {
  const active: WorkerTask[] = [],
    history: WorkerTask[] = [];
  for (const task of workspaceWorkers(tasks)) {
    // Pending reviews, retained paused workers and observed live processes must never disappear into history.
    (HISTORY.has(task.status) &&
    !pendingAttention(task).length &&
    !pendingLifecycle(task) &&
    !queuedAssignments(task).length &&
    task.execution?.live !== true
      ? history
      : active
    ).push(task);
  }
  return {
    active,
    history: history.sort(
      (a, b) =>
        (Date.parse(b.updatedAt || "") || 0) -
        (Date.parse(a.updatedAt || "") || 0),
    ),
    retained: workspaceWorkers(tasks).filter((task) => task.worktree).length,
  };
}
export const workerWorkflow = (task: WorkerTask) =>
  typeof task.workflowState?.value === "string" &&
  task.workflowState.value.trim()
    ? task.workflowState.value
    : null;
export function workerStatus(task: WorkerTask) {
  if (task.archiveRestoration?.requiresRecovery) return "History restored";
  return task.retirement?.reason === "worktree-already-missing"
    ? "Retired"
    : LABELS[task.status] || "Status unavailable";
}
export function workerProgress(task: WorkerTask) {
  if (task.archiveRestoration?.requiresRecovery)
    return (
      task.failure ||
      "History restored. The worker environment is unavailable and requires recovery."
    );
  if (task.retirement?.reason === "worktree-already-missing")
    return "Worktree already missing. History retained; resource cleanup unverified.";
  if (
    queuedAssignments(task).length &&
    typeof task.followupWait === "string" &&
    task.followupWait.trim()
  )
    return task.followupWait;
  if (["queued", "resume_queued"].includes(task.status)) {
    // Only the controller knows whether capacity, an update or explicit manager start is blocking admission.
    if (typeof task.capacityWait === "string" && task.capacityWait.trim())
      return task.capacityWait;
    return task.status === "resume_queued"
      ? "Waiting to resume."
      : "Waiting to start.";
  }
  const assignment = currentAssignment(task);
  return (
    task.failure ||
    assignment.result?.message ||
    task.progress ||
    (task.status === "launching"
      ? "Opening worker session."
      : "Waiting for the next progress report.")
  );
}
export function workerTiming(task: WorkerTask, now = Date.now()) {
  const execution = task.execution;
  if (!execution || (execution.runId && execution.runId !== task.runId))
    return { live: null, elapsed: null, observedAt: null };
  const observedAt = Date.parse(execution.observedAt || ""),
    startedAt = Date.parse(execution.startedAt || ""),
    endedAt = Date.parse(execution.endedAt || "");
  const fresh =
    Number.isFinite(observedAt) &&
    now >= observedAt - 1000 &&
    now - observedAt <= 15000;
  const live =
    execution.live === true
      ? fresh
        ? true
        : null
      : execution.live === false
        ? false
        : null;
  // A stopped-looking status or updatedAt is not evidence of the end of an execution.
  const end = Number.isFinite(endedAt) ? endedAt : live === true ? now : NaN;
  return {
    live,
    elapsed:
      Number.isFinite(startedAt) && Number.isFinite(end) && end >= startedAt
        ? end - startedAt
        : null,
    observedAt: Number.isFinite(observedAt) ? execution.observedAt : null,
  };
}
export function formatElapsed(ms: number | null) {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return null;
  const seconds = Math.floor(ms / 1000),
    minutes = Math.floor(seconds / 60),
    hours = Math.floor(minutes / 60);
  return hours
    ? `${hours}h ${minutes % 60}m`
    : minutes
      ? `${minutes}m ${seconds % 60}s`
      : `${seconds}s`;
}
export function workerActions(task: WorkerTask): WorkerAction[] {
  if (
    isArchivedTask(task) ||
    pendingLifecycle(task) ||
    ["disposed", "stopping", "pausing"].includes(task.status)
  )
    return [];
  if (task.execution?.live === true) return ["pause", "stop"];
  if (task.archiveRestoration?.requiresRecovery) return ["dispose"];
  if (
    ["running", "queued", "launching", "resume_queued", "verifying"].includes(
      task.status,
    )
  )
    return ["pause", "stop"];
  return [
    "awaiting_answer",
    "paused",
    "stopped",
    "failed",
    "blocked",
    "completed",
  ].includes(task.status)
    ? ["resume", "dispose"]
    : [];
}
export function workerActionRequest(
  task: WorkerTask,
  action: WorkerAction,
  id = `worker-${crypto.randomUUID()}`,
) {
  if (!workerActions(task).includes(action))
    throw new Error(
      "This worker action is no longer available. Refresh its status.",
    );
  const selection = {
    taskId: task.id,
    action,
    actionId: id,
    expectedRunId: task.runId || null,
  };
  return {
    requestId: id,
    text: `CREW_WORKER_ACTION\nI explicitly request this lifecycle action for the selected worker only: ${JSON.stringify(selection)}. Read local_orchestration.get_status for this task first. If its run ID differs from the selected expectedRunId (including a selected null), or the action is no longer valid, do not perform it; explain the changed state. Otherwise use local_orchestration.worker_action with this taskId, action, actionId and current expectedRunId when non-null. Reuse this actionId on retries. Preserve normal approvals. Do not launch a different worker, change the agreed brief, modify tickets, or open a microphone. Stop/pause retain partial work and evidence. Archive (the compatible dispose action) is authorized only through the existing safe teardown, which must refuse dirty or unresolved work and retain task records. Report queued intent separately from confirmed completion.`,
  };
}

export function workerRecoveryReviewRequest(task: WorkerTask) {
  if (
    task.archiveRestoration?.requiresRecovery ||
    !task.worktree ||
    !["failed", "blocked", "paused", "stopped", "completed"].includes(
      task.status,
    ) ||
    pendingLifecycle(task)
  )
    throw new Error("Recovery review is not available for this task state.");
  return `CREW_WORKER_RECOVERY_REVIEW\nReview recovery options for only ${JSON.stringify({ taskId: task.id, expectedRunId: task.runId || null })}. Read get_status and review_worker_recovery for reconcile_plan and retire_missing. Explain retained/current command differences, exact blockers and cleanup uncertainty. This requests review only: do not apply a recovery decision, start/resume work, stop a process, remove resources or retire records until I explicitly approve the exact reviewed action. Preserve history and normal approvals.`;
}
