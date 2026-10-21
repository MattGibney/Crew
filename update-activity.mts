import type {
  ManagerActivity,
  ActivityView,
  ActivityResult,
} from "./shared/update.mjs";
// Update readiness distinguishes durable history from current owned execution.
const terminalTasks = new Set([
  "completed",
  "failed",
  "canceled",
  "cancelled",
  "stopped",
  "paused",
  "disposed",
]);
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
const inactiveEnvironment = new Set(["stopped", "disposed", "not-configured"]);
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
    if (work.activeTurnId || work.workStarting || !idleManager.has(work.status))
      reasons.push(
        "The manager is still working or its state is unverified. Wait for completion, or use Stop manager for work you want to cancel.",
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
      const retainedWaiting =
        ["awaiting_answer", "blocked"].includes(task.status) &&
        evidence &&
        ["absent", "stopped"].includes(evidence.worker) &&
        ["absent", "stopped"].includes(evidence.runtime) &&
        Array.isArray(evidence.hooks) &&
        evidence.hooks.every((hook) => hook.state === "stopped");
      if (!terminalTasks.has(task.status) && !retainedWaiting)
        reasons.push(
          `${label} is ${task.status || "unverified"}. Finish or explicitly stop it before updating.`,
        );
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
      const environment = task.environment;
      if (evidence) {
        for (const hook of evidence.hooks || []) {
          if (hook.state !== "stopped")
            reasons.push(
              `${label}: ${hook.phase || "environment"} command ${hook.state === "live" ? "is still running" : "shutdown is unverified"}. Review that command’s diagnostics before updating.`,
            );
        }
        if (evidence.runtime === "live")
          reasons.push(
            `${label} project runtime is still running. Stop its environment before updating.`,
          );
        else if (!["absent", "stopped"].includes(evidence.runtime))
          reasons.push(
            `${label} project runtime shutdown is unverified. Preserve its worktree and review runtime ownership.`,
          );
        if (
          environment?.servicesStarted &&
          !environment.runtime &&
          !inactiveEnvironment.has(environment.status || "")
        )
          reasons.push(
            `${label} has services without a matching runtime record. Review its environment ownership before updating.`,
          );
        if (
          environment?.status === "failed" &&
          evidence.runtime === "absent" &&
          (evidence.hooks || []).length &&
          (evidence.hooks || []).every((hook) => hook.state === "stopped") &&
          ["absent", "stopped"].includes(evidence.worker)
        )
          notices.push(
            `${label}: failed environment commands are confirmed stopped. Its retained worktree and data do not need to be removed to update.`,
          );
      } else if (environment) {
        if (
          environment.hooks?.some((hook) =>
            ["pending", "running", "processing"].includes(hook.status),
          )
        )
          reasons.push(
            `${label} has an environment command awaiting shutdown verification. Refresh readiness.`,
          );
        if (environment.runtime && environment.runtime.status !== "stopped")
          reasons.push(
            `${label} project runtime is active or unverified. Stop or review it before updating.`,
          );
        if (
          !inactiveEnvironment.has(environment.status || "") &&
          !["ready", "configured"].includes(environment.status || "")
        )
          reasons.push(
            `${label} environment shutdown evidence is unavailable. Refresh readiness; a failed status alone does not mean it is running.`,
          );
        if (
          environment.servicesStarted &&
          !inactiveEnvironment.has(environment.status || "")
        )
          reasons.push(
            `${label} has project services awaiting shutdown verification.`,
          );
      }
    }
  return {
    safe: reasons.length === 0,
    reasons: [...new Set(reasons)],
    ...(notices.length ? { notices: [...new Set(notices)] } : {}),
  };
}
