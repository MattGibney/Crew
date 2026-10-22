import type {
  ManagerActivity,
  ActivityView,
  ActivityResult,
} from "./contracts.mjs";
// Final restart checks observe execution, never agent workflow labels.
const idleManager = new Set([
  "idle",
  "ready",
  "stopped",
  "failed",
  "error",
  "completed",
  "interrupted",
  "canceled",
  "cancelled",
]);
export function updateActivity({
  work,
  view,
  setupBusy = false,
}: {
  work?: ManagerActivity;
  view?: ActivityView;
  setupBusy?: boolean;
} = {}): ActivityResult {
  const reasons = [],
    notices = [];
  if (
    !work ||
    typeof work.voiceActive !== "boolean" ||
    typeof work.voiceConnecting !== "boolean" ||
    typeof work.workStarting !== "boolean"
  )
    reasons.push(
      "Manager activity is unavailable. Reconnect the manager to verify it before updating.",
    );
  else {
    if (work.voiceActive || work.voiceConnecting)
      reasons.push("Disconnect voice before restarting to update.");
    if (work.activeTurnId)
      reasons.push(
        "The manager has an active native turn. Wait for its confirmed completion or interruption; use Stop manager if you want to cancel it.",
      );
    if (work.workStarting)
      reasons.push(
        "A manager request is still starting. Wait for its native turn or cancellation to be confirmed.",
      );
    if (
      !work.activeTurnId &&
      !work.workStarting &&
      !idleManager.has(work.status)
    )
      reasons.push(
        "The manager has no confirmed terminal state. Review its connection and retained conversation before updating.",
      );
    if (!Array.isArray(work.approvals) || work.approvals.length)
      reasons.push("Resolve the manager’s pending input before updating.");
  }
  if (setupBusy)
    reasons.push("Finish project setup before restarting to update.");
  if (!view || view.error || !Array.isArray(view.tasks))
    reasons.push(
      "Worker activity is unavailable. Refresh readiness or review the controller error.",
    );
  else
    for (const task of view.tasks) {
      const label = `Worker ${String(task.id || "with unavailable identity").slice(0, 100)}`;
      const evidence = task.updateEvidence;
      if (evidence) {
        if (evidence.worker === "live")
          reasons.push(
            `${label} has an owned process still running. Stop that worker before updating.`,
          );
        else if (!["absent", "stopped"].includes(evidence.worker))
          reasons.push(
            `${label} shutdown is unverified. Review its retained execution records; do not remove its worktree to enable updates.`,
          );
      } else {
        if (task.execution?.live === true)
          reasons.push(
            `${label} process is still running. Stop that worker before updating.`,
          );
        if (
          task.harnessStarted &&
          (task.execution?.live !== false ||
            task.execution?.stopConfirmed !== true)
        )
          reasons.push(
            `${label} shutdown evidence is unavailable. Review it before updating.`,
          );
      }
      if (
        task.lifecycleRequests?.some(
          (request) => !["completed", "failed"].includes(request.status),
        )
      )
        reasons.push(
          `${label} has a pending lifecycle action. Wait for it to finish.`,
        );
      // Foreground hooks belong to the controller. Independent environments
      // and agent-started services are retained rather than stopped for updates.
      for (const hook of evidence?.hooks || []) {
        if (hook.state !== "stopped")
          reasons.push(
            `${label}: ${hook.phase || "environment"} command is ${hook.state}; wait for controller-owned execution to settle.`,
          );
      }
      if (evidence?.runtime === "live")
        notices.push(
          `${label}: its independent project environment remains running across restart.`,
        );
    }
  return {
    safe: reasons.length === 0,
    reasons: [...new Set(reasons)],
    ...(notices.length ? { notices: [...new Set(notices)] } : {}),
  };
}
