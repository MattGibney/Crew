import { inspectUpdateEvidence } from "../updates/evidence.mjs";
import { createWorkerDisposal } from "./worker-disposal.mjs";
import { createHash } from "node:crypto";
import path from "node:path";
import type { TaskRecord, LifecycleRequest } from "./contracts.mjs";
import type {
  ControllerServices,
  NativeConnectionLive,
  ActivateFollowup,
} from "./controller-services.mjs";
import { readRunnerRecord as json } from "./evidence.mjs";
import {
  atomic,
  confirmedExit,
  connectionEnded,
  attention,
  requireRunDir,
} from "./controller-evidence.mjs";
import { errorMessage } from "./errors.mjs";
import {
  readTask,
  updateTask,
  currentAssignment,
  requestWorkerFollowup,
} from "../orchestration/store.mjs";
import { reconcileEnvironment } from "../projects/worker-environment.mjs";
import {
  stopProjectEnvironment,
  applyProjectRecovery,
} from "../projects/environment.mjs";
const now = () => new Date().toISOString();
export function createWorkerLifecycle({
  stateDir,
  project,
  capacity,
  launches,
  operations,
  startupQueued,
  admissionHeld,
  fixture,
  fail,
  verify,
  nativeConnectionLive,
  activateFollowup,
}: Pick<
  ControllerServices,
  | "stateDir"
  | "project"
  | "capacity"
  | "launches"
  | "operations"
  | "startupQueued"
  | "admissionHeld"
  | "fixture"
  | "fail"
  | "verify"
> & {
  nativeConnectionLive: NativeConnectionLive;
  activateFollowup: ActivateFollowup;
}) {
  async function finishRequest(
    id: string,
    requestId: string,
    error: string | null = null,
  ) {
    await updateTask(stateDir, id, (next) => {
      const r = next.lifecycleRequests?.find((r) => r.id === requestId);
      if (r) {
        r.status = error ? "failed" : "completed";
        r.handledAt = now();
        if (error) r.error = error;
      }
    });
  }
  const dispose = createWorkerDisposal({ stateDir, project, fixture });
  async function completeStop(task: TaskRecord, request?: LifecycleRequest) {
    if (request?.settleNaturally === true) {
      if (
        request.cooperative !== true ||
        request.action !== "pause" ||
        (request.expectedRunId ?? null) !== (task.runId || null)
      )
        throw new Error(
          "Natural preparation settlement has a changed lifecycle identity",
        );
      // Agents own resource stopping. Observe all captured execution afresh;
      // neither a ready tool response nor an old exit flag authorizes commands.
      const observed = await inspectUpdateEvidence({
        stateDir,
        view: { tasks: [task] },
      });
      const evidence = observed.tasks[0]?.updateEvidence;
      if (
        !evidence ||
        !["absent", "stopped"].includes(evidence.worker) ||
        !["absent", "stopped"].includes(evidence.runtime) ||
        evidence.hooks.some(
          (hook) => !["absent", "stopped"].includes(hook.state),
        )
      )
        return true;
      await updateTask(stateDir, task.id, (next) => {
        if ((next.runId || null) !== request.expectedRunId)
          throw new Error("Worker run changed before natural settlement");
        const current = next.lifecycleRequests.find(
          (item) => item.id === request.id,
        );
        if (
          !current ||
          current.action !== "pause" ||
          current.settleNaturally !== true ||
          current.cooperative !== true ||
          (current.expectedRunId ?? null) !== (next.runId || null)
        )
          throw new Error(
            "Natural preparation action changed before settlement",
          );
        if (next.status !== "completed") next.status = "paused";
        next.endedAt ||= now();
        if (next.execution)
          next.execution = {
            ...next.execution,
            live: false,
            endedAt: next.endedAt,
          };
        current.status = "completed";
        current.handledAt = now();
      });
      return true;
    }
    if (task.environment?.kind !== "project-execution") return false;
    if (!operations.has(task.id)) {
      const action =
          request?.action || (task.status === "pausing" ? "pause" : "stop"),
        preserveCompleted =
          request?.cooperative === true && task.status === "completed";
      if (!preserveCompleted)
        await updateTask(stateDir, task.id, (n) => {
          n.status = action === "pause" ? "pausing" : "stopping";
        });
      const operation = stopProjectEnvironment({
        plan: project?.worker?.environment?.executionPlan,
        stateDir,
        taskId: task.id,
        cooperative: request?.cooperative === true,
        onEvidence: (environment) =>
          updateTask(stateDir, task.id, (n) => {
            n.environment = environment;
          }),
      })
        .then(() =>
          updateTask(stateDir, task.id, (n) => {
            n.status = preserveCompleted
              ? "completed"
              : action === "pause"
                ? "paused"
                : "stopped";
            n.endedAt = now();
            if (n.execution)
              n.execution = { ...n.execution, live: false, endedAt: n.endedAt };
            const current = n.lifecycleRequests?.find(
              (r) => r.id === request?.id,
            );
            if (current) {
              current.status = "completed";
              current.handledAt = now();
            }
          }),
        )
        .catch(async (error) => {
          if (request)
            await finishRequest(task.id, request.id, errorMessage(error));
          if (preserveCompleted)
            await updateTask(stateDir, task.id, (n) => {
              n.environmentStopFailure = errorMessage(error);
              attention(
                n,
                `${n.runId}:environment-stop-failure`,
                "blocked",
                `Completed work was retained, but project environment stop failed: ${errorMessage(error)}`,
              );
            });
          else
            await fail(
              task.id,
              `Project environment stop failed: ${errorMessage(error)}`,
            );
        })
        .finally(() => operations.delete(task.id));
      operations.set(task.id, operation);
    }
    return true;
  }
  async function lifecycle(task: TaskRecord) {
    if (operations.has(task.id)) return task;
    const request = (task.lifecycleRequests || []).find((r) =>
      ["pending", "processing"].includes(r.status),
    );
    if (!request) return task;
    try {
      if (
        request.expectedRunId !== undefined &&
        request.expectedRunId !== (task.runId || null)
      )
        throw new Error(
          "Worker run changed. Refresh its status before retrying.",
        );
      if (request.status === "pending")
        task = await updateTask(stateDir, task.id, (n) => {
          const current = n.lifecycleRequests.find((r) => r.id === request.id);
          if (current) current.status = "processing";
        });
      if (["pause", "stop"].includes(request.action)) {
        const exit = task.runDir
          ? await json(path.join(requireRunDir(task), "exit.json"))
          : null;
        if (
          request.cooperative === true &&
          (confirmedExit(task, exit) ||
            (request.settleNaturally === true &&
              connectionEnded(task, exit))) &&
          !launches.has(task.id)
        ) {
          const result = task.reports.find(
            (r) => r.runId === task.runId && r.kind === "result",
          );
          if (
            task.status !== "completed" &&
            exit.exitCode === 0 &&
            exit.completedTurn &&
            exit.threadId &&
            result
          ) {
            try {
              await verify(task, exit, result);
              task = await readTask(stateDir, task.id);
            } catch (error) {
              await fail(
                task.id,
                `Completion verification failed: ${errorMessage(error)}`,
              );
              throw error;
            }
          }
          if (task.status === "completed") {
            if (await completeStop(task, request))
              return await readTask(stateDir, task.id);
            await finishRequest(task.id, request.id);
            return await readTask(stateDir, task.id);
          }
        }
        if (launches.has(task.id)) {
          task = await updateTask(stateDir, task.id, (n) => {
            const current = n.lifecycleRequests?.find(
              (r) => r.id === request.id,
            );
            // Preparation completes outside this tick. Never overwrite its terminal
            // transition from a request snapshot read before that completion.
            if (current?.status !== "processing") return;
            if (["paused", "stopped"].includes(n.status)) {
              current.status = "completed";
              current.handledAt = now();
              return;
            }
            n.status = request.action === "pause" ? "pausing" : "stopping";
          });
          return task;
        }
        const priorEnvironment =
          request.settleNaturally === true
            ? null
            : await reconcileEnvironment({
                stateDir,
                taskId: task.id,
                stop: request.cooperative !== true,
              });
        if (priorEnvironment?.pending) {
          await updateTask(stateDir, task.id, (n) => {
            n.status = request.action === "pause" ? "pausing" : "stopping";
            n.environment = priorEnvironment;
          });
          return await readTask(stateDir, task.id);
        }
        if (
          exit &&
          task.harnessStarted &&
          !confirmedExit(task, exit) &&
          !(request.settleNaturally === true && connectionEnded(task, exit))
        )
          throw new Error(
            "Worker commands have no matching confirmed terminal record. No stop completion was claimed.",
          );
        if (
          !task.harnessStarted ||
          confirmedExit(task, exit) ||
          (request.settleNaturally === true && connectionEnded(task, exit))
        ) {
          if (await completeStop(task, request))
            return await readTask(stateDir, task.id);
          await updateTask(stateDir, task.id, (n) => {
            n.status = request.action === "pause" ? "paused" : "stopped";
            n.endedAt = exit?.at || now();
            if (n.execution)
              n.execution = { ...n.execution, live: false, endedAt: n.endedAt };
            const current = n.lifecycleRequests?.find(
              (r) => r.id === request.id,
            );
            if (current) {
              current.status = "completed";
              current.handledAt = now();
            }
          });
          await finishRequest(task.id, request.id);
          return await readTask(stateDir, task.id);
        }
        if (!task.runDir)
          throw new Error(
            "Worker ownership is unknown; no process was stopped.",
          );
        await atomic(path.join(requireRunDir(task), "control.json"), {
          runId: task.runId,
          requestId: request.id,
          action: request.action,
          cooperative: request.cooperative === true,
          settleNaturally: request.settleNaturally === true,
          at: now(),
        });
        task = await updateTask(stateDir, task.id, (n) => {
          n.status = request.action === "pause" ? "pausing" : "stopping";
        });
      } else if (
        ["resume", "start"].includes(request.action) &&
        task.threadId &&
        task.worktree
      ) {
        if (task.archiveRestoration?.requiresRecovery)
          throw new Error(
            "This history-only record has no available worker environment.",
          );
        if (await nativeConnectionLive(task)) return task;
        // An explicit resume after an ended assignment repeats its direction;
        // retain the previous result rather than rewriting its immutable record.
        if (
          currentAssignment(task).status === "completed" &&
          !(task.assignments || []).some(
            (item) =>
              item.status === "queued" && item.id !== task.currentAssignmentId,
          )
        ) {
          const requestId = `resume-${createHash("sha256").update(request.id).digest("hex").slice(0, 32)}`;
          task = await requestWorkerFollowup(stateDir, {
            taskId: task.id,
            requestId,
            brief: currentAssignment(task).brief,
            ticket: currentAssignment(task).ticket,
          });
        }
        task = await activateFollowup(task);
        task = await updateTask(stateDir, task.id, (n) => {
          n.status = "resume_queued";
          n.retainedDirection = true;
          n.failure = null;
          delete n.capacityWait;
          startupQueued.delete(n.id);
        });
        await finishRequest(task.id, request.id);
      } else if (request.action === "retry_setup") {
        throw new Error(
          "Setup is agent-initiated. Read get_project_environment and execute the existing project command through native tools; Crew does not replay setup.",
        );
      } else if (["resume", "start"].includes(request.action)) {
        if (task.archiveRestoration?.requiresRecovery)
          throw new Error(
            "This restored record has history only; its working directory is unavailable.",
          );
        if (await nativeConnectionLive(task)) return task;
        if (
          task.harnessStarted &&
          !confirmedExit(
            task,
            task.runDir
              ? await json(path.join(requireRunDir(task), "exit.json"))
              : null,
          )
        )
          throw new Error(
            "The previous native connection has no confirmed exit; preserve its context.",
          );
        if (task.worktree && !task.threadId && task.harnessStarted)
          throw new Error(
            "This worker has no saved native conversation to resume. Its working directory and evidence are retained.",
          );
        if (!task.harnessStarted && task.runId)
          await capacity.releasePreparation({
            taskId: task.id,
            runId: task.runId,
          });
        task = await updateTask(stateDir, task.id, (n) => {
          n.status = "queued";
          n.failure = null;
          startupQueued.delete(n.id);
        });
        await finishRequest(task.id, request.id);
      } else if (
        ["reconcile_plan", "retire_missing"].includes(request.action)
      ) {
        if (await admissionHeld({ taskId: task.id, resume: false }))
          throw new Error(
            "Recovery is held while the manager or application reserves lifecycle changes. Return to work before recovery.",
          );
        if (launches.has(task.id))
          throw new Error(
            "Worker preparation is still active. Wait for a safe stopped boundary before recovery.",
          );
        const operation = applyProjectRecovery({
          stateDir,
          task,
          project,
          mode: request.action,
          request,
        })
          .then((value) =>
            updateTask(stateDir, task.id, (n) => {
              if ((n.runId || null) !== request.expectedRunId)
                throw new Error(
                  "Worker run changed during recovery. Preserve its decision evidence.",
                );
              if (request.action === "reconcile_plan") {
                if (value && "id" in value) n.environment = value;
                else
                  throw new Error("Recovery returned no environment evidence");
              } else {
                n.status = "disposed";
                n.disposedAt = now();
                n.archivedAt = n.disposedAt;
                for (const assignment of n.assignments || [])
                  if (assignment.status === "queued") {
                    assignment.status = "stopped";
                    assignment.endedAt = n.disposedAt;
                    assignment.stopReason = "worker-archived";
                  }
                n.endedAt = n.endedAt || n.disposedAt;
                n.retirement = {
                  reason: "worktree-already-missing",
                  cleanupVerified: false,
                  at: n.disposedAt,
                  reviewHash: request.reviewHash,
                  decision: request.decision,
                };
                if (n.execution)
                  n.execution = {
                    ...n.execution,
                    live: false,
                    endedAt: n.endedAt,
                  };
                for (const item of n.attention)
                  if (!item.ackedAt) {
                    item.ackedAt = n.disposedAt;
                    item.resolution =
                      "Retired missing-worktree record; cleanup unverified";
                  }
              }
              (n.history ||= []).push({
                id: `recovery:${request.id}`,
                actor: "controller",
                kind: "recovery",
                at: now(),
                runId: n.runId || null,
                message:
                  request.action === "reconcile_plan"
                    ? "Applied reviewed compatible lifecycle configuration. Setup and worker execution were not started."
                    : "Retired an already missing and unregistered worktree record. Resource cleanup was not independently verified.",
                evidence: [
                  `Review ${request.reviewHash}`,
                  request.decision || "",
                ],
              });
              const current = n.lifecycleRequests.find(
                (r) => r.id === request.id,
              );
              if (current) {
                current.status = "completed";
                current.handledAt = now();
              }
            }),
          )
          .catch((error) =>
            finishRequest(task.id, request.id, errorMessage(error)),
          )
          .finally(() => operations.delete(task.id));
        operations.set(task.id, operation);
        return task;
      } else if (["dispose", "archive"].includes(request.action)) {
        if (
          !["paused", "stopped", "completed", "failed", "blocked"].includes(
            task.status,
          )
        )
          throw new Error("Stop this worker before removing its environment.");
        if (!operations.has(task.id)) {
          const operation = dispose(task, request)
            .catch((error) =>
              finishRequest(task.id, request.id, errorMessage(error)),
            )
            .finally(() => operations.delete(task.id));
          operations.set(task.id, operation);
        }
        return task;
      } else throw new Error("Unknown worker action.");
    } catch (error) {
      await finishRequest(task.id, request.id, errorMessage(error));
    }
    return await readTask(stateDir, task.id);
  }

  return { lifecycle, completeStop, finishRequest };
}
