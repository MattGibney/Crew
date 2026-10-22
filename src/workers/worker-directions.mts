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
} from "../orchestration/store.mjs";
import { isArchivedTask } from "../shared/worker-archive.mjs";
import {
  runEnvironmentHooks,
  environmentFile,
  reconcileEnvironment,
} from "../projects/worker-environment.mjs";
import { applyProjectToolchain } from "../toolchains/project.mjs";
import {
  stopProjectEnvironment,
  disposeProjectEnvironment,
  applyProjectRecovery,
  reviewProjectRecovery,
} from "../projects/environment.mjs";
import { selectWorktreeRoot, ensureWorktreeRoot } from "./worktree-paths.mjs";
import {
  promptSnapshot,
  promptVersion,
} from "../manager/instructions/settings.mjs";
const exec = promisify(execFile),
  now = () => new Date().toISOString();
export function createWorkerDirections({
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
}: ControllerServices) {
  // Directions are queued transport input, never a Crew permission decision.
  // Wait only for the previous native connection to finish so one conversation
  // cannot acquire duplicate turns. File/configuration history is informational.
  async function nativeConnectionLive(
    task: TaskRecord,
    { ignoreLaunch = false }: { ignoreLaunch?: boolean } = {},
  ) {
    if (!ignoreLaunch && launches.has(task.id)) return true;
    if (!task.runDir) return false;
    const terminal = await json(path.join(requireRunDir(task), "exit.json"));
    if (connectionEnded(task, terminal)) return false;
    if (await ownedRunnerAlive(task)) return true;
    const owner = await json(path.join(requireRunDir(task), "owner.json"));
    const records =
      (await json(path.join(requireRunDir(task), "ownership.json")))?.records ||
      [];
    const native = records.find((record) => record.pid === owner?.workerPid),
      actual = native && getProcessSnapshot().get(native.pid);
    if (
      actual &&
      actual.start === native.start &&
      actual.commandHash === native.commandHash &&
      !actual.state?.includes("Z")
    )
      return true;
    // Spawn acknowledgement precedes the supervisor's ownership journal. Keep
    // directions queued across that transport bootstrap gap; missing identity
    // is not positive evidence that this conversation is available again.
    if (!owner || owner.runId !== task.runId || !owner.supervisorIdentity) {
      const started = await json(
        path.join(requireRunDir(task), "started.json"),
      );
      const intent = Date.parse(
        task.spawnIntentAt ||
          (started && started.runId === task.runId ? started.at : null) ||
          "",
      );
      if (Number.isFinite(intent) && task.harnessStarted) {
        if (Date.now() - intent <= 15000) return true;
        throw new Error(
          "Native worker startup ownership is unresolved. Direction remains queued; no duplicate connection was launched.",
        );
      }
    }
    return false;
  }
  async function activateFollowup(task: TaskRecord) {
    if (
      isArchivedTask(task) ||
      ["disposed", "removed", "archived"].includes(task.status) ||
      task.archiveRestoration?.requiresRecovery
    )
      return task;
    const pending = (task.assignments || []).find(
      (item) =>
        item.status === "queued" && item.id !== task.currentAssignmentId,
    );
    if (!pending || !task.threadId || !task.worktree) return task;
    if (operations.has(task.id) || (await nativeConnectionLive(task)))
      return task;
    // Terminal publication may land after this tick's reconciliation read. Save
    // the prior execution outcome before selecting another queued direction.
    // This is history settlement, never admission or project workflow inference.
    const terminal = task.runDir
      ? await json(path.join(requireRunDir(task), "exit.json"))
      : null;
    if (
      terminal &&
      terminal.runId === task.runId &&
      terminal.connectionClosed === true &&
      terminal.ownership?.remaining?.length &&
      !(task.retainedResourceRuns || []).some(
        (item) => item.runId === task.runId,
      )
    ) {
      task = await updateTask(stateDir, task.id, (n) => {
        if (n.runId)
          (n.retainedResourceRuns ||= []).push({
            runId: n.runId,
            at: terminal.at,
          });
      });
    }
    if (
      connectionEnded(task, terminal) &&
      terminal.exitCode === 0 &&
      terminal.completedTurn &&
      currentAssignment(task).status !== "completed"
    ) {
      const latest = await readTask(stateDir, task.id);
      const result = [...(latest.reports || [])]
        .reverse()
        .find((item) => item.runId === latest.runId && item.kind === "result");
      if (
        latest.runId === task.runId &&
        (result || (!latest.question && latest.status !== "blocked"))
      ) {
        try {
          await verify(
            latest,
            terminal,
            result || {
              runId: latest.runId,
              kind: "result",
              message: terminal.finalMessage || "Native Codex turn completed.",
              evidence: [],
            },
          );
        } catch (error) {
          await fail(
            latest.id,
            `Native result history could not be recorded: ${errorMessage(error)}`,
          );
        }
        task = await readTask(stateDir, task.id);
      }
    }
    // Settling the ended turn is history observation; selecting its next
    // assignment is ordinary work admission. Preserve both result and queued
    // direction while preparation, manager lifecycle or update holds admissions.
    if (await admissionHeld({ taskId: task.id, resume: true })) return task;
    if (
      task.lifecycleRequests?.some(
        (r) =>
          ["pending", "processing"].includes(r.status) &&
          ["archive", "dispose"].includes(r.action),
      )
    )
      return task;
    const started = task.runDir
      ? await json(path.join(requireRunDir(task), "started.json"))
      : null;
    const terminalStart =
      started && started.runId === task.runId ? started.at : task.startedAt;
    return updateTask(stateDir, task.id, (n) => {
      if (
        n.runId !== task.runId ||
        n.currentAssignmentId !== task.currentAssignmentId
      )
        return;
      const assignments = ensureAssignments(n);
      const next = assignments.find((item) => item.id === pending.id);
      if (next?.status !== "queued") return;
      if (
        terminal &&
        terminal.runId === n.runId &&
        Number.isInteger(terminal.workerPid) &&
        Number.isFinite(Date.parse(terminalStart || "")) &&
        Number.isFinite(Date.parse(terminal.at || "")) &&
        !(n.accountedRuns || []).includes(n.runId || "")
      ) {
        n.activeMs =
          (n.activeMs || 0) +
          Math.max(
            0,
            Date.parse(terminal.at || "") - Date.parse(terminalStart || ""),
          );
        (n.accountedRuns ||= []).push(n.runId || "");
      }
      const prior = currentAssignment(n);
      if (prior.status !== "completed") {
        prior.status = "stopped";
        prior.endedAt = n.endedAt || now();
      }
      n.currentAssignmentId = next.id;
      next.status = "active";
      n.result = null;
      n.question = null;
      n.answer = null;
      n.progress = null;
      n.failure = null;
      n.candidateReportId = null;
      n.endedAt = null;
      n.completedAt = null;
      n.status = "resume_queued";
      n.retainedDirection = true;
      delete n.followupWait;
      delete n.capacityWait;
    });
  }

  return { nativeConnectionLive, activateFollowup };
}
