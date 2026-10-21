import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath } from "node:fs/promises";
import path from "node:path";
import type {
  Project,
  TaskRecord,
  TaskReport,
  LifecycleRequest,
} from "./contracts.mjs";
import type { RunnerRecord } from "./evidence.mjs";
import type { createGlobalCapacity } from "../global-capacity.mjs";
import {
  atomic,
  evidencePath,
  environmentHooks,
  confirmedExit,
} from "./controller-evidence.mjs";
import {
  readRunnerRecord as json,
  readEnvironmentEvidence,
} from "./evidence.mjs";
import { errorMessage } from "./errors.mjs";
import { readTask, updateTask } from "../orchestration-store.mjs";
import {
  runEnvironmentHooks,
  environmentFile,
  reconcileEnvironment,
} from "../worker-environment.mjs";
import {
  stopProjectEnvironment,
  disposeProjectEnvironment,
  applyProjectRecovery,
} from "../project-environment.mjs";
import { applyProjectToolchain } from "../project-toolchain.mjs";
import { selectWorktreeRoot } from "../worktree-paths.mjs";
interface LifecycleOptions {
  stateDir: string;
  project: Project | null;
  capacity: Awaited<ReturnType<typeof createGlobalCapacity>>;
  launches: Map<string, Promise<void>>;
  launchAbort: Map<string, AbortController>;
  operations: Map<string, Promise<unknown>>;
  startupQueued: Map<string, string>;
  admissionHeld: (request: {
    taskId: string;
    resume: boolean;
  }) => Promise<boolean>;
  fixture: () => Promise<{
    repo: string;
    commit: string;
    base: string;
    at: string;
  }>;
  fail: (id: string, message: string) => Promise<void>;
  verify: (
    task: TaskRecord,
    exit: RunnerRecord,
    report: TaskReport,
  ) => Promise<void>;
}
const exec = promisify(execFile),
  now = () => new Date().toISOString();
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const attention = (
  task: TaskRecord,
  id: string,
  kind: string,
  message: string,
) => {
  if (!task.attention.some((item) => item.id === id))
    task.attention.push({ id, kind, message, at: now() });
};
/** Apply durable user lifecycle intent while retaining native and environment evidence. */
export function createWorkerLifecycle({
  stateDir,
  project,
  capacity,
  launches,
  launchAbort,
  operations,
  startupQueued,
  admissionHeld,
  fixture,
  fail,
  verify,
}: LifecycleOptions) {
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
  async function dispose(task: TaskRecord) {
    const environment = await reconcileEnvironment({
      stateDir,
      taskId: task.id,
    });
    if (environment?.pending)
      throw new Error(
        "An environment command has not confirmed it stopped. Wait for its bounded supervisor before removing this worktree.",
      );
    const previousExit = task.runDir
      ? await json(evidencePath(task, "exit.json"))
      : null;
    if (
      task.harnessStarted &&
      (!previousExit ||
        previousExit.runId !== task.runId ||
        previousExit.stopConfirmed !== true)
    )
      throw new Error(
        "This worker has no matching confirmed terminal record. Preserve this environment until its process ownership can be reconciled.",
      );
    if (
      task.runnerPid &&
      alive(task.runnerPid) &&
      !(await json(evidencePath(task, "exit.json")))
    )
      throw new Error(
        "Wait until the worker has stopped before removing its environment.",
      );
    if (task.worktree) {
      const repoPath = task.repositoryPath || task.fixtureRepo;
      if (!repoPath)
        throw new Error("Worker repository identity is unavailable.");
      const actual = await realpath(task.worktree),
        repo = await realpath(repoPath);
      const expected =
        project?.mode === "repository"
          ? path.join(
              await selectWorktreeRoot(stateDir, task),
              task.worktreeName || task.id,
            )
          : path.join(
              (await fixture()).base,
              task.worktreeName || `worker-${task.id}`,
            );
      if (actual !== (await realpath(expected)) || actual === repo)
        throw new Error(
          "Worktree ownership could not be verified; nothing was removed.",
        );
      const { stdout: changes } = await exec("git", [
        "-C",
        actual,
        "status",
        "--porcelain",
      ]);
      if (changes.trim())
        throw new Error(
          "This worktree contains changes. Review and preserve them before removing it.",
        );
      const existing = await readEnvironmentEvidence(
        environmentFile(stateDir, task.id),
      );
      if (existing?.preset)
        throw new Error(
          "Obsolete project-specific state was retained; no cleanup protocol was executed.",
        );
      if (existing?.kind === "project-execution")
        await disposeProjectEnvironment({
          stateDir,
          taskId: task.id,
          worktree: task.worktree,
          repositoryPath: task.repositoryPath,
          baseCommit: task.baseCommit,
          onEvidence: (e) =>
            updateTask(stateDir, task.id, (n) => {
              n.environment = e;
            }),
        });
      else
        await runEnvironmentHooks({
          stateDir,
          taskId: task.id,
          worktree: task.worktree,
          hooks: environmentHooks(project),
          phases: ["cleanup"],
          existing,
          env: applyProjectToolchain(existing?.toolchain),
          onEvidence: (e) =>
            updateTask(stateDir, task.id, (n) => {
              n.environment = e;
            }),
        });
      await exec("git", ["-C", repo, "worktree", "remove", actual]);
    }
    await updateTask(stateDir, task.id, (n) => {
      n.status = "disposed";
      n.disposedAt = now();
      n.endedAt = n.endedAt || now();
      if (n.execution)
        n.execution = { ...n.execution, live: false, endedAt: n.endedAt };
    });
  }
  async function completeStop(task: TaskRecord, request?: LifecycleRequest) {
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
          const found = n.lifecycleRequests.find((r) => r.id === request.id);
          if (found) found.status = "processing";
        });
      if (["pause", "stop"].includes(request.action)) {
        const exit = task.runDir
          ? await json(evidencePath(task, "exit.json"))
          : null;
        if (
          request.cooperative === true &&
          confirmedExit(task, exit) &&
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
          if (
            request.cooperative !== true &&
            task.lifecycleRequests?.find((r) => r.id === request.id)?.status ===
              "processing"
          )
            launchAbort.get(task.id)?.abort();
          return task;
        }
        const priorEnvironment = await reconcileEnvironment({
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
        if (exit && task.harnessStarted && !confirmedExit(task, exit))
          throw new Error(
            "Worker commands have no matching confirmed terminal record. No stop completion was claimed.",
          );
        if (!task.harnessStarted || confirmedExit(task, exit)) {
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
        await atomic(evidencePath(task, "control.json"), {
          runId: task.runId,
          requestId: request.id,
          action: request.action,
          cooperative: request.cooperative === true,
          at: now(),
        });
        task = await updateTask(stateDir, task.id, (n) => {
          n.status = request.action === "pause" ? "pausing" : "stopping";
        });
      } else if (["resume", "start"].includes(request.action)) {
        if (
          ![
            "queued",
            "paused",
            "stopped",
            "failed",
            "blocked",
            "awaiting_answer",
          ].includes(task.status)
        )
          throw new Error("This worker is already active or finished.");
        if (
          task.question &&
          task.question.runId === task.runId &&
          task.answer?.questionId !== task.question.id
        )
          throw new Error("Answer this worker’s question before resuming it.");
        const environment = await reconcileEnvironment({
          stateDir,
          taskId: task.id,
        });
        if (environment?.pending)
          throw new Error(
            "An earlier environment command is still running or lacks a stop confirmation. Wait for its bounded supervisor and retry.",
          );
        if (
          task.harnessStarted &&
          !confirmedExit(
            task,
            task.runDir ? await json(evidencePath(task, "exit.json")) : null,
          )
        )
          throw new Error(
            "The previous worker run has no matching confirmed terminal record. Wait for verified shutdown before resuming.",
          );
        if (task.worktree && !task.threadId && task.harnessStarted)
          throw new Error(
            "This worker has no saved conversation to resume. Preserve its worktree and start another worker.",
          );
        if (!task.harnessStarted && task.runId)
          await capacity.releasePreparation({
            taskId: task.id,
            runId: task.runId,
          });
        task = await updateTask(stateDir, task.id, (n) => {
          n.status = n.threadId ? "resume_queued" : "queued";
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
                  throw new Error("Recovery returned no environment evidence.");
              } else {
                n.status = "disposed";
                n.disposedAt = now();
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
      } else if (request.action === "dispose") {
        if (
          !["paused", "stopped", "completed", "failed", "blocked"].includes(
            task.status,
          )
        )
          throw new Error("Stop this worker before removing its environment.");
        if (!operations.has(task.id)) {
          const operation = dispose(task)
            .then(() => finishRequest(task.id, request.id))
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
