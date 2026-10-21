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
export function createWorkerReconciler({
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
  lifecycle,
  completeStop,
  finishRequest,
}: ControllerServices & {
  lifecycle: (task: TaskRecord) => Promise<TaskRecord>;
  completeStop: (
    task: TaskRecord,
    request?: LifecycleRequest,
  ) => Promise<boolean>;
  finishRequest: (
    id: string,
    requestId: string,
    error?: string | null,
  ) => Promise<void>;
}) {
  async function reconcile(task: TaskRecord) {
    if (
      project &&
      task.projectId !== project.id &&
      !(project.mode === "fixture" && !task.projectId)
    )
      throw new Error(
        "Stored task belongs to another project; refusing to process it",
      );
    if (isArchivedTask(task)) return;
    // Durable supervisor evidence wins over a controller write interrupted at spawn.
    // A pending spawn intent without an owner/terminal record remains uncertain and
    // cannot be treated as a never-executed preparation or silently relaunched.
    if (task.runDir) {
      const started = await json(
          path.join(requireRunDir(task), "started.json"),
        ),
        owner = await json(path.join(requireRunDir(task), "owner.json")),
        runtime = await json(path.join(requireRunDir(task), "runtime.json")),
        exit = await json(path.join(requireRunDir(task), "exit.json"));
      const config = await json(path.join(requireRunDir(task), "config.json"));
      const claim =
        config?.runId === task.runId &&
        (await readFile(path.join(requireRunDir(task), "runner.claim"))
          .then(() => true)
          .catch((error) => {
            if (errorCode(error) === "ENOENT") return false;
            throw error;
          }));
      const matching = [started, owner, runtime, exit].some(
        (record) => record?.runId === task.runId,
      );
      if (matching || claim) {
        const pid =
          started && started.runId === task.runId
            ? started.pid
            : owner && owner.runId === task.runId
              ? owner.supervisorPid
              : null;
        const threadId =
          runtime && runtime.runId === task.runId
            ? runtime.threadId
            : exit && exit.runId === task.runId
              ? exit.threadId
              : null;
        if (
          task.harnessStarted !== true ||
          (pid && task.runnerPid !== pid) ||
          (threadId && task.threadId !== threadId)
        )
          task = await updateTask(stateDir, task.id, (n) => {
            n.harnessStarted = true;
            if (pid) n.runnerPid = pid;
            if (threadId) n.threadId = threadId;
          });
      }
    }
    if (task.runDir) {
      const terminal = await json(path.join(requireRunDir(task), "exit.json"));
      const evidence = await json(
        path.join(requireRunDir(task), "worktree-evidence.json"),
      );
      if (
        confirmedExit(task, terminal) &&
        evidence?.taskId === task.id &&
        evidence.runId === task.runId &&
        evidence.assignmentId === currentAssignment(task).id &&
        /^[a-f0-9]{64}$/.test(evidence.fingerprint || "") &&
        task.retainedWorktreeEvidence?.runId !== task.runId
      ) {
        task = await updateTask(stateDir, task.id, (n) => {
          if (
            n.runId === evidence.runId &&
            currentAssignment(n).id === evidence.assignmentId
          )
            n.retainedWorktreeEvidence = {
              runId: evidence.runId,
              assignmentId: evidence.assignmentId,
              fingerprint: evidence.fingerprint,
              at: evidence.at,
            };
        });
      }
    }
    task = await lifecycle(task);
    if (task.archiveRestoration?.requiresRecovery) return;
    if (!task.runDir) return;
    const runtime = await json(path.join(requireRunDir(task), "runtime.json")),
      started = await json(path.join(requireRunDir(task), "started.json")),
      owner = await json(path.join(requireRunDir(task), "owner.json")),
      exit = await json(path.join(requireRunDir(task), "exit.json"));
    if (
      started &&
      started.runId === task.runId &&
      task.runnerPid !== started.pid
    )
      task = await updateTask(stateDir, task.id, (n) => {
        n.runnerPid = started.pid;
      });
    if (
      runtime &&
      runtime.runId === task.runId &&
      runtime.threadId &&
      task.threadId !== runtime.threadId
    )
      task = await updateTask(stateDir, task.id, (n) => {
        n.threadId = runtime.threadId;
      });
    const modelEvidence = await json(
      path.join(requireRunDir(task), "model-selection.json"),
    );
    if (
      modelEvidence &&
      typeof modelEvidence.status === "string" &&
      typeof modelEvidence.message === "string" &&
      typeof modelEvidence.at === "string" &&
      task.modelSelection &&
      modelEvidence.runId === task.runId &&
      modelEvidence.requestId === task.modelSelection?.id &&
      JSON.stringify(task.modelSelection.runtime) !==
        JSON.stringify(modelEvidence)
    ) {
      task = await updateTask(stateDir, task.id, (n) => {
        if (
          n.runId !== modelEvidence.runId ||
          !n.modelSelection ||
          n.modelSelection.id !== modelEvidence.requestId
        )
          return;
        n.modelSelection = {
          ...n.modelSelection,
          status: modelEvidence.status || "unknown",
          message: modelEvidence.message || "",
          runtime: modelEvidence,
        };
        if (
          ["selected", "failed", "rerouted"].includes(
            modelEvidence.status || "",
          )
        ) {
          const id = `model:${modelEvidence.requestId}:${modelEvidence.runId}:${modelEvidence.status}`;
          if (!n.history.some((item) => item.id === id))
            n.history.push({
              id,
              actor: "controller",
              kind: "model_selection",
              message: modelEvidence.message || "",
              at: modelEvidence.at || null,
              runId: n.runId || null,
            });
        }
      });
    }
    const protocolError = await json(
      path.join(requireRunDir(task), "protocol-error.json"),
    );
    if (
      protocolError &&
      protocolError.runId === task.runId &&
      !task.attention.some(
        (item) => item.id === `${task.runId}:native-protocol-error`,
      )
    ) {
      task = await updateTask(stateDir, task.id, (n) => {
        attention(
          n,
          `${n.runId}:native-protocol-error`,
          "blocked",
          "Worker approval or lifecycle transport needs review. Pending requests and owned process evidence were retained; no automatic response was sent.",
        );
      });
    }
    const currentExit = exit && exit.runId === task.runId ? exit : null;
    if (
      currentExit?.connectionClosed === true &&
      currentExit.ownership?.remaining?.length &&
      !(task.retainedResourceRuns || []).some(
        (item) => item.runId === task.runId,
      )
    ) {
      task = await updateTask(stateDir, task.id, (n) => {
        if (n.runId)
          (n.retainedResourceRuns ||= []).push({
            runId: n.runId,
            at: currentExit.at,
          });
      });
    }
    const isLive = !currentExit && (await ownedRunnerAlive(task));
    const spawnAgeMs =
      Date.now() -
      Date.parse(
        task.spawnIntentAt ||
          (started && started.runId === task.runId ? started.at : null) ||
          task.startedAt ||
          task.launchAt ||
          "",
      );
    const workerStarted =
      (owner &&
        owner.runId === task.runId &&
        Number.isInteger(owner.workerPid)) ||
      (currentExit && Number.isInteger(currentExit.workerPid));
    const startAt =
      started && started.runId === task.runId
        ? started.at
        : owner && owner.runId === task.runId
          ? owner.at
          : currentExit?.at;
    if (
      workerStarted &&
      startAt &&
      task.runId &&
      (task.execution?.live !== isLive ||
        (currentExit && !(task.accountedRuns || []).includes(task.runId)) ||
        (isLive &&
          Date.now() - Date.parse(task.execution?.observedAt || "") >= 1000))
    ) {
      task = await updateTask(stateDir, task.id, (n) => {
        n.startedAt = startAt;
        n.accountedRuns = n.accountedRuns || [];
        if (currentExit && !n.accountedRuns.includes(n.runId || "")) {
          n.activeMs =
            (n.activeMs || 0) +
            Math.max(0, Date.parse(currentExit.at || "") - Date.parse(startAt));
          n.accountedRuns.push(n.runId || "");
        }
        n.execution = {
          ...n.execution,
          runId: n.runId,
          live: isLive,
          stopConfirmed: currentExit?.stopConfirmed ?? null,
          supervisorPid: n.runnerPid,
          startedAt: startAt,
          endedAt: currentExit?.at || null,
          totalMs:
            (n.activeMs || 0) +
            (isLive ? Math.max(0, Date.now() - Date.parse(startAt)) : 0),
          observedAt: now(),
        };
      });
    }
    if (["stopping", "pausing"].includes(task.status)) {
      if (!task.harnessStarted) return;
      if (confirmedExit(task, exit)) {
        const request = (task.lifecycleRequests || []).find(
          (r) => r.status === "processing",
        );
        if (await completeStop(task, request)) return;
        await updateTask(stateDir, task.id, (n) => {
          n.status = n.status === "pausing" ? "paused" : "stopped";
          n.endedAt = exit.at;
          const current = n.lifecycleRequests?.find(
            (r) => r.id === request?.id,
          );
          if (current) {
            current.status = "completed";
            current.handledAt = now();
          }
        });
        if (request) await finishRequest(task.id, request.id);
      } else if (!isLive && spawnAgeMs > 15000) {
        const request = (task.lifecycleRequests || []).find(
          (r) => r.status === "processing",
        );
        if (request)
          await finishRequest(
            task.id,
            request.id,
            "Supervisor disappeared without a stop confirmation. No unrelated process was killed.",
          );
        await fail(
          task.id,
          "Supervisor disappeared without a stop confirmation.",
        );
      }
      return;
    }
    if (
      ![
        "running",
        "awaiting_answer",
        "resume_queued",
        "verifying",
        "blocked",
      ].includes(task.status)
    )
      return;
    for (const report of task.reports.filter(
      (r) =>
        r.runId === task.runId &&
        !(task.handledReports || []).includes(`${r.runId}:${r.reportId}`),
    )) {
      task = await updateTask(stateDir, task.id, (n) => {
        n.handledReports = n.handledReports || [];
        n.handledReports.push(`${report.runId}:${report.reportId}`);
        if (report.kind === "progress") n.progress = report.message;
        if (report.kind === "question") {
          n.answer = null;
          n.question = {
            id: report.reportId,
            message: report.message,
            runId: report.runId,
          };
          n.status = "awaiting_answer";
          attention(
            n,
            `${report.runId}:${report.reportId}`,
            "question",
            report.message,
          );
        }
        if (report.kind === "blocked") {
          n.status = "blocked";
          attention(
            n,
            `${report.runId}:${report.reportId}`,
            "blocked",
            report.message,
          );
        }
        if (report.kind === "result") {
          n.status = "verifying";
          n.candidateReportId = report.reportId;
        }
      });
    }
    if (exit && exit.runId === task.runId) {
      if (exit.threadId && task.threadId !== exit.threadId)
        task = await updateTask(stateDir, task.id, (n) => {
          n.threadId = exit.threadId;
        });
      // A queued native continuation uses fresh connection liveness. A saved
      // descendant-exit flag is historical evidence, never direction admission.
      if (task.status === "resume_queued") return;
      if (!connectionEnded(task, exit)) {
        await fail(
          task.id,
          "Native worker connection has no confirmed terminal record; preserve its context.",
        );
        return;
      }
      if (exit.stopped && task.status !== "resume_queued") {
        await updateTask(stateDir, task.id, (n) => {
          n.status = exit.stopAction === "pause" ? "paused" : "stopped";
          n.endedAt = exit.at;
        });
        return;
      }
      if (task.status === "resume_queued") return;
      if (exit.nativeTurnStatus === "interrupted" && !exit.error) {
        await updateTask(stateDir, task.id, (n) => {
          n.status = "stopped";
          n.endedAt = exit.at;
          n.nativeTurnStatus = "interrupted";
          attention(
            n,
            `${n.runId}:native-interrupted`,
            "blocked",
            "Codex ended this worker turn after an interruption or canceled approval. Its worktree and history are retained; no successful result is claimed. Discuss explicit resume with the manager.",
          );
        });
        return;
      }
      if (exit.exitCode !== 0 || !exit.completedTurn) {
        await fail(
          task.id,
          `Worker exited without successful turn: ${exit.error || `exit ${exit.exitCode}`}.`,
        );
        return;
      }
      if (["resume_queued", "awaiting_answer", "blocked"].includes(task.status))
        return;
      if (task.status === "verifying") {
        const report = task.reports.find(
          (r) =>
            r.runId === task.runId && r.reportId === task.candidateReportId,
        );
        if (!report) throw new Error("Missing candidate result report.");
        try {
          await verify(task, exit, report);
        } catch (error) {
          await fail(
            task.id,
            `Completion verification failed: ${errorMessage(error)}`,
          );
        }
      } else if (project?.mode === "repository" || task.retainedDirection)
        await verify(task, exit, {
          runId: task.runId,
          kind: "result",
          message: exit.finalMessage || "Native Codex turn completed.",
          evidence: [],
        });
      else
        await fail(
          task.id,
          "Worker exited without a durable question or result.",
        );
    } else if (!isLive && spawnAgeMs > 15000)
      await fail(
        task.id,
        "Worker supervisor disappeared without a terminal record. Not relaunched automatically.",
      );
  }

  return reconcile;
}
