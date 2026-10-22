import type {
  ManagerActivity,
  ActivityView,
  ActivityResult,
  TaskActivity,
  PausePlan,
  PauseTarget,
  PlanIdentity,
} from "./contracts.mjs";
import { parsePausePlan } from "./plan-store.mjs";
interface UpdatePlanOptions {
  preparation?: import("../preparation/coordinator.mjs").PreparationCoordinator;
  stateDir: string;
  version: string;
  getView: () => Promise<ActivityView>;
  getManager: () => ManagerActivity | Promise<ManagerActivity>;
  stopVoice: () => Promise<unknown>;
  interruptManager: (options: { expectedTurnId: string }) => Promise<unknown>;
  requestAction: (options: {
    taskId: string;
    actionId: string;
    action: "pause" | "resume";
    expectedRunId: string | null;
    cooperative?: boolean;
    settleNaturally?: boolean;
  }) => Promise<unknown>;
  activity: () => Promise<ActivityResult>;
  onChange?: (plan: PausePlan | null) => void;
  now?: () => number;
  timeoutMs?: number;
}
import { errorCode, errorMessage } from "../shared/errors.mjs";
// AI-018: deterministic, durable pause/update/resume coordination. No model loop.
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
const HOLDING = new Set([
  "draining",
  "ready",
  "installing",
  "resuming",
  "blocked",
  "canceled",
]);
const ORIGINAL_ACTIVE = new Set([
  "queued",
  "launching",
  "running",
  "resume_queued",
  "verifying",
]);
const TERMINAL = new Set([
  "completed",
  "failed",
  "canceled",
  "cancelled",
  "disposed",
]);
const MANAGER_IDLE = new Set([
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
const unanswered = (task: TaskActivity) =>
  !!(task.question && task.answer?.questionId !== task.question.id);
const clone = <T,>(value: T): T => structuredClone(value);
export function isUpdatePlanHolding(plan: PausePlan | null | undefined) {
  // Unknown persisted phases fail closed rather than admitting work.
  return !!plan && (HOLDING.has(plan.phase) || plan.phase !== "complete");
}
export async function readUpdatePlan(
  stateDir: string,
): Promise<PausePlan | null> {
  let data;
  try {
    data = parsePausePlan(
      await fs.readFile(path.join(stateDir, "update-plan.json"), "utf8"),
    );
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw new Error(
      "Update plan is unreadable; review retained state before starting work.",
    );
  }
  if (
    !data ||
    data.schema !== 1 ||
    data.kind !== "pause-update" ||
    data.consent !== true ||
    !Number.isFinite(Date.parse(data.createdAt)) ||
    typeof data.id !== "string" ||
    !Array.isArray(data.targets) ||
    !Array.isArray(data.progress) ||
    ![...HOLDING, "canceled", "complete"].includes(data.phase) ||
    typeof data.targetVersion !== "string" ||
    typeof data.fromVersion !== "string" ||
    !data.manager ||
    data.targets.some(
      (t) =>
        !t ||
        typeof t.taskId !== "string" ||
        typeof t.pauseActionId !== "string" ||
        typeof t.resumeActionId !== "string",
    )
  )
    throw new Error(
      "Update plan is malformed; review retained state before starting work.",
    );
  return data;
}
export function createUpdatePlan({
  preparation,
  stateDir,
  version,
  getView,
  getManager,
  stopVoice,
  interruptManager,
  requestAction,
  activity,
  onChange = () => {},
  now = () => Date.now(),
  timeoutMs = 120000,
}: UpdatePlanOptions) {
  let plan: PausePlan | null = null;
  function current(): PausePlan {
    if (!plan) throw new Error("No active update plan.");
    return plan;
  }
  let serial: Promise<unknown> = Promise.resolve();
  const stamp = () => new Date(now()).toISOString();
  const ready = readUpdatePlan(stateDir).then((value) => {
    plan = value;
  });
  const transact = <T,>(fn: () => Promise<T>) => {
    const result = serial.then(() => ready).then(fn);
    serial = result.catch(() => {});
    return result;
  };
  async function save() {
    current().updatedAt = stamp();
    await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
    const file = path.join(stateDir, "update-plan.json");
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      const handle = await fs.open(temp, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(plan, null, 2)}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temp, file);
    } finally {
      await fs.unlink(temp).catch((error) => {
        if (errorCode(error) !== "ENOENT") throw error;
      });
    }
    try {
      onChange(clone(plan));
    } catch {
      /* UI notification cannot undo durable state. */
    }
  }
  function progress(message: string, taskId: string | null = null) {
    current().progress.push({
      at: stamp(),
      message,
      ...(taskId ? { taskId } : {}),
    });
    current().progress = current().progress.slice(-120);
  }
  async function blocked(reason: string) {
    await preparation?.cancel(current());
    current().phase = "blocked";
    current().reasons = [reason];
    progress(reason);
    await save();
    return clone(plan);
  }
  const idleManager = (manager: ManagerActivity) =>
    !!manager &&
    !manager.activeTurnId &&
    manager.workStarting === false &&
    MANAGER_IDLE.has(manager.status) &&
    Array.isArray(manager.approvals) &&
    manager.approvals.length === 0;
  const taskNeedsDrain = (task: TaskActivity) =>
    ORIGINAL_ACTIVE.has(task.status) ||
    task.updateEvidence?.worker === "live" ||
    task.updateEvidence?.runtime === "live" ||
    task.updateEvidence?.hooks?.some((hook) => hook.state === "live");
  function addTargets(tasks: TaskActivity[]) {
    for (const task of tasks) {
      if (
        !taskNeedsDrain(task) ||
        current().targets.some((t) => t.taskId === task.id)
      )
        continue;
      const wasEligible = ORIGINAL_ACTIVE.has(task.status) && !unanswered(task);
      current().targets.push({
        taskId: task.id,
        originalRunId: task.runId || null,
        originalStatus: task.status,
        resumeEligible: wasEligible,
        pauseActionId: randomUUID(),
        resumeActionId: randomUUID(),
        progress: "captured",
        pauseConfirmed: false,
      });
      progress("Captured worker before update.", task.id);
    }
  }
  async function viewTasks() {
    const view = await getView();
    if (!view || view.error || !Array.isArray(view.tasks))
      throw new Error("Worker activity is unavailable.");
    return view.tasks;
  }
  function shutdownConfirmed(task: TaskActivity) {
    const evidence = task.updateEvidence;
    return evidence
      ? ["absent", "stopped"].includes(evidence.worker) &&
          ["absent", "stopped"].includes(evidence.runtime) &&
          Array.isArray(evidence.hooks) &&
          evidence.hooks.every((hook) => hook.state === "stopped")
      : !task.harnessStarted ||
          (task.execution?.live === false &&
            task.execution?.stopConfirmed === true);
  }
  function pauseConfirmed(task: TaskActivity, target: PauseTarget) {
    const action = task.lifecycleRequests?.find(
      (r) => r.id === target.pauseActionId,
    );
    return (
      action?.status === "completed" &&
      action.action === "pause" &&
      (action.expectedRunId ?? null) === target.originalRunId &&
      (task.runId || null) === target.originalRunId &&
      ["paused", "stopped"].includes(task.status) &&
      shutdownConfirmed(task)
    );
  }
  function verifiedHeldQueue(task: TaskActivity, target: PauseTarget): boolean {
    const evidence = task.updateEvidence;
    return (
      target.originalRunId === null &&
      ["queued", "resume_queued"].includes(target.originalStatus) &&
      (task.runId || null) === null &&
      !task.harnessStarted &&
      !task.spawnIntentAt &&
      !task.runDir &&
      task.execution?.live !== true &&
      evidence?.worker === "absent" &&
      evidence.runtime === "absent" &&
      evidence.hooks.length === 0
    );
  }
  async function drainPrepared() {
    const tasks = await viewTasks();
    addTargets(tasks);
    await save();
    if (!current().voiceClosed) {
      await stopVoice();
      current().voiceClosed = true;
      progress("Voice disconnected; agent preparation will not reconnect it.");
      await save();
    }
    const manager = await getManager();
    await preparation!.begin(current(), manager, tasks);
    const observed = await preparation!.tick(current(), manager, tasks);
    current().preparation = observed;
    const reasons: string[] = [];
    for (const participant of observed.participants) {
      if (participant.required && participant.response?.state !== "ready")
        reasons.push(
          `${participant.role === "manager" ? "Manager" : `Worker ${participant.taskId}`}: ${participant.response?.note || participant.delivery.error || "waiting for the agent's explicit preparation acknowledgement."}`,
        );
      if (
        participant.required &&
        participant.response?.state === "ready" &&
        !participant.settled
      )
        reasons.push(
          `${participant.role === "manager" ? "Manager" : `Worker ${participant.taskId}`}: ${participant.settlementReason}`,
        );
    }
    for (const target of current().targets) {
      const task = tasks.find((task) => task.id === target.taskId);
      const participant = observed.participants.find(
        (p) => p.role === "worker" && p.taskId === target.taskId,
      );
      if (!task || (!participant && !verifiedHeldQueue(task, target))) {
        reasons.push(
          `Worker ${target.taskId} preparation evidence is unavailable.`,
        );
        continue;
      }
      if (participant?.required && participant.response?.state !== "ready") {
        target.progress =
          participant.response?.state ||
          (participant.delivery.state === "acknowledged"
            ? "awaiting-agent-readiness"
            : "preparation-requested");
        continue;
      }
      if ((task.runId || null) !== target.originalRunId)
        return blocked(
          `Worker ${target.taskId} changed runs during preparation. Review its retained context.`,
        );
      if (
        pauseConfirmed(task, target) &&
        task.lifecycleRequests?.some(
          (action) =>
            action.id === target.pauseActionId &&
            action.cooperative === true &&
            action.settleNaturally === true,
        )
      ) {
        target.pauseConfirmed = true;
        target.progress = "prepared-and-settled";
        continue;
      }
      const action = task.lifecycleRequests?.find(
        (action) => action.id === target.pauseActionId,
      );
      if (
        action?.status === "completed" &&
        action.action === "pause" &&
        action.cooperative === true &&
        action.settleNaturally === true &&
        (action.expectedRunId ?? null) === target.originalRunId &&
        task.status === "completed" &&
        shutdownConfirmed(task)
      ) {
        target.resumeEligible = false;
        target.progress = "prepared-and-finished";
        continue;
      }
      if (action?.status === "failed")
        return blocked(
          `Worker ${target.taskId} preparation settlement could not be confirmed. Review its lifecycle evidence.`,
        );
      if (!action) {
        target.progress = participant?.required
          ? "ready-awaiting-final-messages"
          : "settling-held-queue";
        await save();
        await requestAction({
          taskId: target.taskId,
          actionId: target.pauseActionId,
          action: "pause",
          expectedRunId: target.originalRunId,
          cooperative: true,
          settleNaturally: true,
        });
      }
      reasons.push(
        `Worker ${target.taskId}: waiting for the final turn, durable result and verified natural shutdown.`,
      );
    }
    const fresh = await activity();
    if (!fresh?.safe)
      reasons.push(
        ...(fresh?.reasons?.length
          ? fresh.reasons
          : ["Fresh idle evidence is unavailable."]),
      );
    current().reasons = [...new Set(reasons)];
    if (!reasons.length) {
      current().phase = "ready";
      progress(
        "All required agents acknowledged preparation and final execution is safely settled.",
      );
    } else current().phase = "draining";
    await save();
    return clone(plan);
  }
  async function drain() {
    if (preparation) return drainPrepared();
    if (now() - Date.parse(current().createdAt) > timeoutMs)
      return blocked(
        "Pausing timed out. Review retained work; no process was force-stopped.",
      );
    let tasks = await viewTasks();
    addTargets(tasks);
    await save(); // Rescan includes tasks created while the manager was draining.
    if (!current().voiceClosed) {
      await stopVoice();
      current().voiceClosed = true;
      progress("Voice disconnected; it will remain disconnected.");
      await save();
    }
    const manager = await getManager();
    const reasons = [];
    let interruptTurn = null;
    let managerConflict = false;
    if (!idleManager(manager)) {
      if (manager?.approvals?.length)
        reasons.push(
          "Resolve pending manager approvals; updates never answer them automatically.",
        );
      else if (!manager?.activeTurnId)
        reasons.push(
          manager?.workStarting === true
            ? "Waiting for the manager turn to start before requesting its interruption."
            : "Manager terminal activity is unavailable; review its retained conversation.",
        );
      else if (
        current().manager.interruptTurnId &&
        current().manager.interruptTurnId !== manager.activeTurnId
      )
        managerConflict = true;
      else {
        if (!current().manager.interruptRequested)
          interruptTurn = manager.activeTurnId;
        reasons.push("Waiting for confirmed manager interruption.");
      }
    } else
      current().manager.interrupted =
        current().manager.originalActive &&
        current().manager.interruptRequested;
    // Workers drain independently of manager approvals/terminal evidence. Re-scan each tick.
    tasks = await viewTasks();
    addTargets(tasks);
    await save();
    for (const target of current().targets) {
      const task = tasks.find((item) => item.id === target.taskId);
      if (!task) {
        reasons.push(`Worker ${target.taskId} is unavailable.`);
        continue;
      }
      if (pauseConfirmed(task, target)) {
        if (!target.pauseConfirmed)
          progress(
            "Worker pause confirmed by lifecycle and process evidence.",
            target.taskId,
          );
        target.pauseConfirmed = true;
        target.progress = "paused";
        continue;
      }
      if (TERMINAL.has(task.status) && shutdownConfirmed(task)) {
        target.resumeEligible = false;
        target.progress = "finished-before-pause";
        continue;
      }
      const action = task.lifecycleRequests?.find(
        (r) => r.id === target.pauseActionId,
      );
      if (action?.status === "failed")
        return blocked(
          `Worker ${target.taskId} could not pause safely. Review its lifecycle evidence.`,
        );
      if ((task.runId || null) !== target.originalRunId)
        return blocked(
          `Worker ${target.taskId} changed runs; automatic update is blocked.`,
        );
      if (!action) {
        target.progress = "pause-requested";
        await save();
        await requestAction({
          taskId: target.taskId,
          actionId: target.pauseActionId,
          action: "pause",
          expectedRunId: target.originalRunId,
          cooperative: true,
        });
      }
      reasons.push(
        `Waiting for worker ${target.taskId} to pause cooperatively.`,
      );
    }
    if (managerConflict)
      return blocked(
        "Manager turn changed while draining; review retained conversation before updating.",
      );
    if (interruptTurn) {
      // Queuing worker pauses crosses asynchronous boundaries. The captured
      // manager turn may have finished, acquired an approval, or been replaced.
      const latest = await getManager();
      if (idleManager(latest)) {
        progress("Manager finished before interruption was needed.");
      } else if (latest?.approvals?.length) {
        reasons.push(
          "Resolve pending manager approvals; updates never answer them automatically.",
        );
      } else if (latest?.activeTurnId !== interruptTurn) {
        return blocked(
          "Manager turn changed while draining; review retained conversation before updating.",
        );
      } else {
        current().manager.interruptTurnId = interruptTurn;
        current().manager.interruptRequested = true;
        await save();
        try {
          await interruptManager({ expectedTurnId: interruptTurn });
          progress(
            "Requested manager interruption; waiting for terminal evidence.",
          );
        } catch (error) {
          // A completion notification can win even the final read/RPC race.
          // Only positive idle evidence permits this; newer/unknown work and
          // approvals retain the interruption failure and admission hold.
          if (!idleManager(await getManager())) throw error;
          progress(
            "Manager terminal evidence confirmed after interruption raced completion.",
          );
        }
        await save();
      }
    }
    const fresh = await activity();
    if (!fresh || fresh.safe !== true)
      reasons.push(
        ...(fresh?.reasons?.length
          ? fresh.reasons
          : ["Fresh idle evidence is unavailable."]),
      );
    current().reasons = [...new Set(reasons)];
    if (!reasons.length) {
      current().phase = "ready";
      progress("All captured work is safely paused. Ready to install.");
    }
    await save();
    return clone(plan);
  }
  async function observeHeldPause() {
    // Blocking/canceling stops side effects, not observation of requests already
    // issued. Never turn late proof into installation or automatic resumption.
    const tasks = await viewTasks();
    if (preparation && current().preparation)
      current().preparation = await preparation.tick(
        current(),
        await getManager(),
        tasks,
      );
    for (const target of current().targets) {
      const task = tasks.find((item) => item.id === target.taskId);
      if (task && pauseConfirmed(task, target)) {
        if (!target.pauseConfirmed)
          progress(
            "Worker pause confirmed by lifecycle and process evidence.",
            target.taskId,
          );
        target.pauseConfirmed = true;
        target.progress = "paused";
      } else if (task && TERMINAL.has(task.status) && shutdownConfirmed(task)) {
        target.resumeEligible = false;
        target.progress = "finished-before-pause";
      }
    }
    await save();
    return clone(plan);
  }
  async function resume() {
    const tasks = await viewTasks();
    for (const target of current().targets) {
      if (!target.resumeEligible || !target.pauseConfirmed) continue;
      const task = tasks.find((item) => item.id === target.taskId);
      if (!task)
        return blocked(
          `Paused worker ${target.taskId} is unavailable; no automatic resume.`,
        );
      const existing = task.lifecycleRequests?.find(
        (r) => r.id === target.resumeActionId,
      );
      if (existing) {
        if (
          existing.action !== "resume" ||
          (existing.expectedRunId ?? null) !== target.originalRunId
        )
          return blocked(`Resume correlation changed for ${target.taskId}.`);
        if (existing.status === "failed")
          return blocked(
            `Worker ${target.taskId} could not resume; review its evidence.`,
          );
        if (existing.status === "completed") {
          target.progress = "resumed";
          continue;
        }
        current().reasons = [
          `Waiting for worker ${target.taskId} resume admission.`,
        ];
        await save();
        return clone(plan);
      }
      const pauseAction = task.lifecycleRequests?.find(
        (r) => r.id === target.pauseActionId,
      );
      if (
        ["queued", "resume_queued"].includes(task.status) &&
        !unanswered(task) &&
        (task.runId || null) === target.originalRunId &&
        pauseAction?.status === "completed" &&
        pauseAction.action === "pause" &&
        (pauseAction.expectedRunId ?? null) === target.originalRunId
      ) {
        target.progress = "user-queued";
        continue;
      }
      if (unanswered(task) || !pauseConfirmed(task, target))
        return blocked(
          `Worker ${target.taskId} needs manager review; its pause or question state changed.`,
        );
      target.progress = "resume-requested";
      await save();
      await requestAction({
        taskId: target.taskId,
        actionId: target.resumeActionId,
        action: "resume",
        expectedRunId: target.originalRunId,
      });
      current().reasons = [
        `Waiting for worker ${target.taskId} resume admission.`,
      ];
      await save();
      return clone(plan);
    }
    current().phase = "complete";
    current().reasons = [];
    progress(
      "Resume coordination finished: confirmed paused workers were queued for resume; never-paused queued work may continue. Other retained work needs manager review. Voice remains disconnected; manager input was not replayed.",
    );
    await save();
    return clone(plan);
  }
  const status = () => clone(plan);
  return {
    ready,
    status,
    begin: ({
      targetVersion,
      purpose = "update",
    }: {
      targetVersion: string;
      purpose?: "update" | "quit";
    }) =>
      transact(async () => {
        if (
          typeof targetVersion !== "string" ||
          !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][\w.-]+)?$/.test(targetVersion) ||
          (targetVersion === version && purpose !== "quit") ||
          !["update", "quit"].includes(purpose)
        )
          throw new Error("A different valid target version is required.");
        if (isUpdatePlanHolding(plan)) {
          if (
            current().targetVersion === targetVersion &&
            (current().purpose || "update") === purpose
          )
            return clone(plan);
          throw new Error("An update plan is already holding work.");
        }
        const manager = await getManager();
        const tasks = await viewTasks();
        plan = {
          schema: 1,
          kind: "pause-update",
          consent: true,
          id: randomUUID(),
          targetVersion,
          purpose,
          fromVersion: version,
          phase: "draining",
          createdAt: stamp(),
          updatedAt: stamp(),
          targets: [],
          progress: [],
          reasons: [],
          voiceClosed: false,
          manager: {
            originalActive: !idleManager(manager),
            originalTurnId: manager?.activeTurnId || null,
            interruptRequested: false,
            interrupted: false,
          },
        };
        addTargets(tasks);
        progress("Update requested. New work admission is held.");
        await save(); // Hold is durable before the first side effect.
        return clone(plan); // Tick performs side effects; the explicit action returns once intent is durable.
      }),
    tick: () =>
      transact(async () => {
        if (!plan) return null;
        try {
          if (
            current().phase === "draining" ||
            (preparation && current().phase === "ready")
          )
            return await drain();
          if (current().phase === "resuming") return await resume();
          if (["blocked", "canceled"].includes(current().phase))
            return await observeHeldPause();
        } catch (error) {
          return blocked(`Update coordination failed: ${errorMessage(error)}`);
        }
        return clone(plan);
      }),
    markInstalling: ({ planId, targetVersion }: PlanIdentity = {}) =>
      transact(async () => {
        if (
          plan?.phase !== "ready" ||
          current().id !== planId ||
          current().targetVersion !== targetVersion ||
          current().consent !== true
        )
          return { marked: false, plan: clone(plan) };
        const fresh = await activity();
        if (preparation) {
          const observed = await preparation.tick(
            current(),
            await getManager(),
            await viewTasks(),
          );
          current().preparation = observed;
          if (
            observed.participants.some(
              (participant) =>
                participant.required &&
                (participant.response?.state !== "ready" ||
                  !participant.settled),
            )
          ) {
            await blocked(
              "An agent's readiness or final execution changed before shutdown. Review preparation before retrying.",
            );
            return { marked: false, plan: clone(plan) };
          }
        }
        if (!fresh || fresh.safe !== true) {
          await blocked(
            "Activity changed before install. Review work before retrying.",
          );
          return { marked: false, plan: clone(plan) };
        }
        await preparation?.complete(current());
        current().phase = "installing";
        current().reasons = [];
        progress("Install reserved; paused-work evidence retained.");
        await save();
        return { marked: true, plan: clone(plan) };
      }),
    markBlocked: (
      reason: unknown,
      { planId, targetVersion }: PlanIdentity = {},
    ) =>
      transact(async () => {
        if (
          !plan ||
          current().id !== planId ||
          current().targetVersion !== targetVersion ||
          ["canceled", "complete"].includes(current().phase)
        )
          return clone(plan);
        return blocked(
          String(
            reason || "Installation failed; retained paused work needs review.",
          ).slice(0, 1000),
        );
      }),
    cancel: () =>
      transact(async () => {
        if (!plan || ["complete", "canceled"].includes(current().phase))
          return clone(plan);
        if (current().phase === "installing")
          throw new Error(
            "Installation has begun; recover retained work after restart.",
          );
        current().phase = "canceled";
        await preparation?.cancel(current());
        current().reasons = [
          "Paused work is retained. Choose Resume paused work to continue.",
        ];
        progress("Update canceled; paused work was not silently resumed.");
        await save();
        return clone(plan);
      }),
    resumeAfterCancel: () =>
      transact(async () => {
        if (!plan || !["canceled", "blocked"].includes(current().phase))
          throw new Error("No canceled or blocked plan to resume.");
        // Reconcile pause requests that completed after cancellation, without creating new ones.
        const tasks = await viewTasks();
        for (const target of current().targets) {
          const task = tasks.find((t) => t.id === target.taskId);
          if (task && pauseConfirmed(task, target))
            target.pauseConfirmed = true;
          const pauseAction = task?.lifecycleRequests?.find(
            (r) => r.id === target.pauseActionId,
          );
          if (
            pauseAction &&
            !["completed", "failed"].includes(pauseAction.status)
          )
            throw new Error(
              "A pause request is still pending; wait for confirmation before resuming.",
            );
          if (!target.resumeEligible || target.pauseConfirmed) continue;
          if (!task || pauseAction?.status === "failed")
            return blocked(
              `Worker ${target.taskId} never confirmed its update pause. Use Return to work for manager review; no resume was requested.`,
            );
          const sameRun = (task.runId || null) === target.originalRunId;
          const queuedSafely =
            ["queued", "resume_queued"].includes(task.status) &&
            sameRun &&
            !unanswered(task) &&
            shutdownConfirmed(task) &&
            (pauseAction?.status === "completed" ||
              (!pauseAction &&
                task.harnessStarted !== true &&
                task.execution?.live !== true));
          if (queuedSafely) {
            target.resumeEligible = false;
            target.progress = "queued-without-resume";
            progress(
              "Existing queued work was retained; no pause/resume completion was claimed.",
              target.taskId,
            );
            continue;
          }
          if (
            !pauseAction &&
            TERMINAL.has(task.status) &&
            shutdownConfirmed(task)
          ) {
            target.resumeEligible = false;
            target.progress = "finished-before-pause";
            progress(
              "Worker finished before a confirmed update pause; no resume was requested.",
              target.taskId,
            );
            continue;
          }
          return blocked(
            `Worker ${target.taskId} never confirmed its update pause. Use Return to work for manager review; no resume was requested.`,
          );
        }
        current().phase = "resuming";
        current().reasons = [];
        progress("User requested resuming retained paused work.");
        await save();
        return resume();
      }),
    releaseForReview: () =>
      transact(async () => {
        if (!plan || !["canceled", "blocked"].includes(current().phase))
          throw new Error(
            "Only canceled or blocked update work can return to manager review.",
          );
        await preparation?.cancel(current());
        current().phase = "complete";
        current().reasons = [];
        progress(
          "User returned to work. Queued work may continue; paused workers remain paused for manager review. No resume requests were created.",
        );
        await save();
        return clone(plan);
      }),
    recover: () =>
      transact(async () => {
        if (!plan) return null;
        if (current().phase === "installing") {
          if (current().purpose === "quit") {
            current().phase = "canceled";
            current().reasons = [
              "Crew was prepared for shutdown. Work and continuation are retained; choose Return to work or Resume paused work explicitly.",
            ];
            await preparation?.cancel(current());
            await save();
            return clone(plan);
          }
          if (version !== current().targetVersion)
            return blocked(
              "The target version was not installed. Paused work is retained; choose Resume paused work.",
            );
          current().phase = "resuming";
          progress(
            "Target version confirmed; restoring only correlated plan-paused work.",
          );
          await save();
          return resume();
        }
        if (current().phase === "resuming") return resume();
        return clone(plan);
      }),
  };
}
