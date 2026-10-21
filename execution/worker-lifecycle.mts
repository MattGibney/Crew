import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  stat,
  mkdir,
  readFile,
  writeFile,
  realpath,
  lstat,
} from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import path from "node:path";
import type {
  TaskRecord,
  LifecycleRequest,
  ResultCandidate,
} from "./contracts.mjs";
import type { RunnerRecord } from "./evidence.mjs";
import type {
  ControllerServices,
  NativeConnectionLive,
  ActivateFollowup,
} from "./controller-services.mjs";
import {
  readRunnerRecord as json,
  readEnvironmentEvidence,
} from "./evidence.mjs";
import {
  environmentHooks,
  atomic,
  confirmedExit,
  connectionEnded,
  attention,
  alive,
  requireRepository,
  requireRunDir,
} from "./controller-evidence.mjs";
import { errorCode, errorMessage } from "./errors.mjs";
import {
  readTask,
  updateTask,
  currentAssignment,
  ensureAssignments,
  ensureArchiveExecutionStopped,
  requestWorkerFollowup,
} from "../orchestration-store.mjs";
import { isArchivedTask } from "../worker-archive.mjs";
import {
  runEnvironmentHooks,
  environmentFile,
  reconcileEnvironment,
} from "../worker-environment.mjs";
import { applyProjectToolchain } from "../project-toolchain.mjs";
import {
  stopProjectEnvironment,
  disposeProjectEnvironment,
  applyProjectRecovery,
  reviewProjectRecovery,
} from "../project-environment.mjs";
import { selectWorktreeRoot, ensureWorktreeRoot } from "../worktree-paths.mjs";
import { promptSnapshot, promptVersion } from "../prompt-settings.mjs";
const exec = promisify(execFile),
  now = () => new Date().toISOString();
export function createWorkerLifecycle({
  stateDir,
  sourceDir,
  executable,
  project,
  workerPrompt,
  getWorkerPrompt,
  capacity,
  launches,
  operations,
  startupQueued,
  admissionHeld,
  isStopped,
  fixture,
  fail,
  verify,
  ownedTask,
  ownedRunnerAlive,
  getProcessSnapshot,
  nativeConnectionLive,
  activateFollowup,
}: ControllerServices & {
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
  async function dispose(task: TaskRecord, request: LifecycleRequest) {
    if (task.archiveRestoration?.requiresRecovery) {
      await ensureArchiveExecutionStopped(stateDir, task);
      if (task.worktree) {
        if (
          project?.mode === "repository" &&
          task.environment?.kind === "project-execution"
        ) {
          const review = await reviewProjectRecovery({
            stateDir,
            task,
            project,
            mode: "retire_missing",
          });
          if (!review.allowed)
            throw new Error(
              `Restored history cannot be archived while resource ownership is unresolved: ${review.blockers.join("; ")}`,
            );
        } else {
          const repositoryMode = project?.mode === "repository";
          const repository = repositoryMode
            ? project.repositories?.find(
                (item) => item.id === task.repositoryId,
              )
            : null;
          const meta = repositoryMode
            ? {
                repo: repository?.path,
                base: await selectWorktreeRoot(stateDir, task),
              }
            : await json(path.join(stateDir, "fixture.json"));
          if (!meta?.base)
            throw new Error(
              "Restored worktree identity is unverified; history was retained.",
            );
          const expected = path.join(
            meta.base,
            task.worktreeName ||
              (repositoryMode ? task.id : `worker-${task.id}`),
          );
          if (
            !meta?.repo ||
            task.worktree !== expected ||
            (await realpath(requireRepository(task))) !==
              (await realpath(meta.repo))
          )
            throw new Error(
              "Restored worktree identity is unverified; history was retained.",
            );
          const exists = await lstat(task.worktree).then(
            () => true,
            (error) => {
              if (errorCode(error) === "ENOENT") return false;
              throw error;
            },
          );
          if (exists)
            throw new Error(
              "Restored worker worktree path exists; preserve it for explicit review.",
            );
          const canonical = path.join(
            await realpath(path.dirname(expected)),
            path.basename(expected),
          );
          const { stdout } = await exec("git", [
            "-C",
            meta.repo,
            "worktree",
            "list",
            "--porcelain",
            "-z",
          ]);
          if (
            stdout
              .split("\0")
              .some(
                (field) =>
                  field === `worktree ${expected}` ||
                  field === `worktree ${canonical}`,
              )
          )
            throw new Error(
              "Restored worker worktree remains registered with Git; history was retained.",
            );
        }
      }
      await updateTask(stateDir, task.id, (n) => {
        const at = now();
        n.status = "disposed";
        n.archivedAt = at;
        for (const assignment of n.assignments || [])
          if (assignment.status === "queued") {
            assignment.status = "stopped";
            assignment.endedAt = at;
            assignment.stopReason = "worker-archived";
          }
        if (n.archiveRestoration)
          n.archiveRestoration = { ...n.archiveRestoration, rearchivedAt: at };
        (n.history ||= []).push({
          id: `archive-restored:${request.id}`,
          actor: "controller",
          kind: "lifecycle",
          at,
          runId: n.runId || null,
          message: task.worktree
            ? "Re-archived restored history after verified absent worktree and terminal execution. No environment cleanup was run."
            : "Re-archived restored history with no recorded worktree path. Resource cleanup remains unverified. No environment cleanup was run.",
        });
        const current = n.lifecycleRequests.find((r) => r.id === request.id);
        if (current) {
          current.status = "completed";
          current.handledAt = at;
        }
      });
      return;
    }
    const environment = await reconcileEnvironment({
      stateDir,
      taskId: task.id,
    });
    if (environment?.pending)
      throw new Error(
        "An environment command has not confirmed it stopped. Wait for its bounded supervisor before removing this worktree.",
      );
    const previousExit = task.runDir
      ? await json(path.join(requireRunDir(task), "exit.json"))
      : null;
    if (task.harnessStarted && !connectionEnded(task, previousExit))
      throw new Error(
        "This worker has no matching confirmed terminal record. Preserve this environment until its process ownership can be reconciled.",
      );
    if (
      task.runnerPid &&
      alive(task.runnerPid) &&
      !(await json(path.join(requireRunDir(task), "exit.json")))
    )
      throw new Error(
        "Wait until the worker has stopped before removing its environment.",
      );
    if (task.worktree) {
      const actual = await realpath(task.worktree),
        repo = await realpath(requireRepository(task));
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
          plan: project?.worker?.environment?.executionPlan,
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
      await ensureArchiveExecutionStopped(
        stateDir,
        await readTask(stateDir, task.id),
      );
      await exec("git", ["-C", repo, "worktree", "remove", actual]);
    }
    await updateTask(stateDir, task.id, (n) => {
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
      if (n.execution)
        n.execution = { ...n.execution, live: false, endedAt: n.endedAt };
      const current = n.lifecycleRequests?.find((r) => r.id === request.id);
      if (current) {
        current.status = "completed";
        current.handledAt = n.disposedAt;
      }
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
        await atomic(path.join(requireRunDir(task), "control.json"), {
          runId: task.runId,
          requestId: request.id,
          action: request.action,
          cooperative: request.cooperative === true,
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
