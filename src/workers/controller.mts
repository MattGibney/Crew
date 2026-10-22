import { createWorkerDirections } from "./worker-directions.mjs";
import { createWorkerLauncher } from "./worker-launch.mjs";
import { createWorkerLifecycle } from "./worker-lifecycle.mjs";
import { createWorkerReconciler } from "./worker-reconcile.mjs";
import { environmentHooks } from "./controller-evidence.mjs";
function requireRepository(task: TaskRecord): string {
  const value = task.repositoryPath || task.fixtureRepo;
  if (!value) throw new Error("Retained repository identity is unavailable");
  return value;
}
function requireRunDir(task: TaskRecord): string {
  if (!task.runDir)
    throw new Error("Worker run evidence directory is unavailable");
  return task.runDir;
}
import type {
  Project,
  TaskRecord,
  TaskReport,
  LifecycleRequest,
  WorkerResult,
} from "./contracts.mjs";
import {
  readRunnerRecord,
  type RunnerRecord,
  readEnvironmentEvidence,
} from "./evidence.mjs";
import type { ProcessSnapshot } from "../processes/ownership.mjs";
import { errorCode, errorMessage, isRecord } from "./errors.mjs";
interface ControllerOptions {
  stateDir: string;
  sourceDir: string;
  executable: string;
  project?: Project | null;
  workerPrompt?: string;
  workerProfileSource?: { projectId: string } | null;
  getWorkerPrompt?: (() => Promise<{ text: string; version: string }>) | null;
  globalCapacity?: { dir?: string; limit?: number } | null;
  onChange?: (view: {
    tasks: TaskRecord[];
    error: string | null;
    maxConcurrent: number;
  }) => unknown;
  admissionHeld?: (request: {
    taskId: string;
    resume: boolean;
  }) => Promise<boolean>;
}
interface Fixture {
  repo: string;
  base: string;
  commit: string;
  at: string;
}
import type { ResultCandidate } from "./contracts.mjs";
import { verifyWorkerCompletion } from "./worker-verification.mjs";
import { applyProjectToolchain } from "../toolchains/project.mjs";
// Deterministic local controller. Polls files; never polls a model or starts voice.
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  stat,
  mkdir,
  readFile,
  writeFile,
  rename,
  mkdtemp,
  open,
  unlink,
  realpath,
  lstat,
} from "node:fs/promises";
import {
  runEnvironmentHooks,
  environmentFile,
  reconcileEnvironment,
} from "../projects/worker-environment.mjs";
import {
  stopProjectEnvironment,
  disposeProjectEnvironment,
  applyProjectRecovery,
  reviewProjectRecovery,
} from "../projects/environment.mjs";
import { selectWorktreeRoot, ensureWorktreeRoot } from "./worktree-paths.mjs";
import { snapshotProcesses } from "../processes/ownership.mjs";
import { randomUUID, createHash } from "node:crypto";
import {
  promptSnapshot,
  promptVersion,
} from "../manager/instructions/settings.mjs";
import path from "node:path";
import os from "node:os";
import {
  loadTasks,
  readTask,
  updateTask,
  currentAssignment,
  ensureAssignments,
  ensureArchiveExecutionStopped,
  requestWorkerFollowup,
} from "../orchestration/store.mjs";
import { isArchivedTask } from "../shared/worker-archive.mjs";
import { createGlobalCapacity } from "../orchestration/capacity.mjs";
const exec = promisify(execFile);
const now = () => new Date().toISOString();
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const json = readRunnerRecord;
async function atomic(file: string, value: unknown) {
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await rename(temp, file);
}
const confirmedExit = (
  task: TaskRecord,
  exit: RunnerRecord | null,
): exit is RunnerRecord =>
  Boolean(exit && exit.runId === task.runId && exit.stopConfirmed === true);
const connectionEnded = (
  task: TaskRecord,
  exit: RunnerRecord | null,
): exit is RunnerRecord =>
  Boolean(
    exit &&
    exit.runId === task.runId &&
    (exit.connectionClosed === true || exit.stopConfirmed === true),
  );
const attention = (
  task: TaskRecord,
  id: string,
  kind: string,
  message: string,
) => {
  if (!task.attention.some((a) => a.id === id))
    task.attention.push({ id, kind, message, at: now() });
};
export async function createController({
  stateDir,
  sourceDir,
  executable,
  project = null,
  workerPrompt = "",
  workerProfileSource = null,
  getWorkerPrompt = null,
  globalCapacity = null,
  onChange = () => {},
  admissionHeld = async () => false,
}: ControllerOptions) {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const lockPath = path.join(stateDir, "controller.lock");
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch (e) {
    if (errorCode(e) !== "EEXIST") throw e;
    const prior = await json(lockPath);
    if (!prior || !Number.isInteger(prior.pid) || alive(prior.pid ?? -1))
      throw new Error(
        "Another controller may be running. Refusing duplicate launches.",
      );
    await unlink(lockPath);
    lock = await open(lockPath, "wx", 0o600);
  }
  await lock.writeFile(JSON.stringify({ pid: process.pid, at: now() }));
  await lock.close();
  let busy = false,
    timer: NodeJS.Timeout,
    lastView = "",
    stopped = false,
    controllerError: string | null = null;
  const launches = new Map<string, Promise<void>>(),
    operations = new Map<string, Promise<unknown>>();
  let processSnapshot: ProcessSnapshot = new Map();
  async function ownedRunnerAlive(task: TaskRecord) {
    if (!task.runnerPid || !task.runDir) return false;
    const owner = await json(path.join(requireRunDir(task), "owner.json"));
    const actual = processSnapshot.get(task.runnerPid),
      expected = owner?.supervisorIdentity;
    return Boolean(
      owner &&
      owner.runId === task.runId &&
      owner.supervisorPid === task.runnerPid &&
      actual &&
      expected &&
      actual.start === expected.start &&
      actual.commandHash === expected.commandHash &&
      !actual.state?.includes("Z"),
    );
  }
  let maxConcurrent = Number.isInteger(project?.worker?.maxConcurrent)
    ? Math.max(1, Math.min(8, project?.worker.maxConcurrent || 2))
    : 2;
  const capacity = await createGlobalCapacity({
    dir: globalCapacity?.dir || path.join(stateDir, "capacity"),
    stateDir,
    ...(globalCapacity?.dir ? {} : { limit: maxConcurrent }),
  });
  if (globalCapacity?.limit !== undefined)
    throw new Error(
      "Configure the global worker limit once through configureGlobalCapacity, not per controller.",
    );
  const ownedTask = (task: TaskRecord) =>
    !project ||
    task.projectId === project.id ||
    (project.mode === "fixture" && !task.projectId);
  const startupTasks = (await loadTasks(stateDir)).filter(ownedTask);
  for (const task of startupTasks) {
    const interrupted = new Set(
      (task.lifecycleRequests || [])
        .filter(
          (request) =>
            ["start", "resume", "retry_setup"].includes(request.action) &&
            ["pending", "processing"].includes(request.status),
        )
        .map((request) => request.id),
    );
    await updateTask(stateDir, task.id, (n) => {
      // Old start/resume intent must never dispatch new work during recovery.
      // Retain its exact request/run history; stop/pause still recover normally.
      for (const request of n.lifecycleRequests || [])
        if (
          interrupted.has(request.id) &&
          ["pending", "processing"].includes(request.status)
        ) {
          request.status = "failed";
          request.handledAt = now();
          request.error =
            "Controller restarted before start/resume completed; ask the manager to start again.";
        }
      if (["queued", "resume_queued"].includes(n.status))
        n.capacityWait = "Waiting for the manager to start after reopening";
    });
  }
  const startupQueued = new Map(
    (await loadTasks(stateDir))
      .filter((task) => ["queued", "resume_queued"].includes(task.status))
      .map((task) => [task.id, JSON.stringify(task.answer || null)]),
  );
  let fixturePromise: Promise<Fixture> | null;
  async function fixture() {
    if (!fixturePromise)
      fixturePromise = createFixture().catch((error) => {
        fixturePromise = null;
        throw error;
      });
    return fixturePromise;
  }
  async function createFixture() {
    const metaPath = path.join(stateDir, "fixture.json");
    const meta = await json(metaPath);
    if (meta) {
      if (!meta.repo || !meta.base || !meta.commit || !meta.at)
        throw new Error("Malformed fixture metadata");
      await exec("git", ["-C", meta.repo, "rev-parse", "--verify", "HEAD"]);
      return {
        repo: meta.repo,
        base: meta.base,
        commit: meta.commit,
        at: meta.at,
      };
    }
    const base = await mkdtemp(path.join(os.tmpdir(), "crew-fixture-"));
    const repo = path.join(base, "repo");
    await mkdir(path.join(repo, "src"), { recursive: true });
    await exec("git", ["init", "-b", "main", repo]);
    await writeFile(
      path.join(repo, "README.md"),
      "# Disposable audit fixture\n\nTicket AI-004. This is not product source. Audit totals without editing files.\n",
    );
    await writeFile(
      path.join(repo, "AGENTS.md"),
      "# Worker scope\nRead-only audit in this disposable fixture only. Do not edit or commit. Use local_orchestration.report for useful progress, questions and final result. Never inspect credentials or access outside the task.\n",
    );
    await writeFile(
      path.join(repo, "src/totals.mjs"),
      "export function sum(values) { return values.reduce((total, value) => total + value, 1); }\n",
    );
    await exec("git", [
      "-C",
      repo,
      "add",
      "README.md",
      "AGENTS.md",
      "src/totals.mjs",
    ]);
    await exec("git", [
      "-C",
      repo,
      "-c",
      "user.name=Codex Fixture",
      "-c",
      "user.email=fixture@localhost.invalid",
      "commit",
      "-m",
      "Disposable read-only audit fixture",
    ]);
    const { stdout } = await exec("git", ["-C", repo, "rev-parse", "HEAD"]);
    const created = { repo, base, commit: stdout.trim(), at: now() };
    await atomic(metaPath, created);
    return created;
  }
  async function fail(id: string, message: string) {
    await updateTask(stateDir, id, (task) => {
      task.status = "failed";
      task.endedAt = now();
      task.failure = message;
      attention(task, `${task.runId || task.id}:failure`, "failure", message);
    });
  }
  const verify = (
    task: TaskRecord,
    exit: RunnerRecord,
    report: ResultCandidate,
  ) => verifyWorkerCompletion({ stateDir, project, task, exit, report });
  const services = {
    stateDir,
    sourceDir,
    executable,
    project,
    workerPrompt,
    getWorkerPrompt,
    workerProfileSource,
    capacity,
    launches,
    operations,
    startupQueued,
    admissionHeld,
    isStopped: () => stopped,
    fixture,
    fail,
    verify,
    ownedTask,
    ownedRunnerAlive,
    getProcessSnapshot: () => processSnapshot,
  };
  const { nativeConnectionLive, activateFollowup } =
    createWorkerDirections(services);
  const { lifecycle, completeStop, finishRequest } = createWorkerLifecycle({
    ...services,
    nativeConnectionLive,
    activateFollowup,
  });
  const { launch, launchContinuation } = createWorkerLauncher({
    ...services,
    nativeConnectionLive,
  });
  const reconcile = createWorkerReconciler({
    ...services,
    lifecycle,
    completeStop,
    finishRequest,
  });
  async function tick() {
    if (busy || stopped) return;
    busy = true;
    try {
      processSnapshot = await snapshotProcesses();
      const foreign = (task: TaskRecord) =>
        project &&
        task.projectId !== project.id &&
        !(project.mode === "fixture" && !task.projectId);
      controllerError = null;
      for (const task of await loadTasks(stateDir)) {
        if (foreign(task)) {
          controllerError =
            "Stored task belongs to another project; refusing to process it";
          continue;
        }
        try {
          await reconcile(task);
        } catch (error) {
          await fail(
            task.id,
            `Worker controller error: ${errorMessage(error)}`,
          ).catch(() => {});
        }
      }
      for (const retained of await loadTasks(stateDir)) {
        if (foreign(retained)) continue;
        try {
          await activateFollowup(retained);
        } catch (error) {
          await updateTask(stateDir, retained.id, (n) => {
            const pending = (n.assignments || []).find(
              (a) => a.status === "queued" && a.id !== n.currentAssignmentId,
            );
            if (pending) n.followupWait = errorMessage(error);
          });
        }
      }
      const tasks = await loadTasks(stateDir);
      for (const task of tasks) {
        if (stopped) break;
        if (
          foreign(task) ||
          launches.has(task.id) ||
          !["queued", "resume_queued"].includes(task.status) ||
          !task.threadId ||
          !task.worktree
        )
          continue;
        if (await admissionHeld({ taskId: task.id, resume: true })) continue;
        try {
          if (await nativeConnectionLive(task)) continue;
        } catch (error) {
          await updateTask(stateDir, task.id, (n) => {
            n.capacityWait = errorMessage(error);
          });
          continue;
        }
        const runId = randomUUID(),
          admission = await capacity.acquire({
            taskId: task.id,
            runId,
            replaceConnection: true,
            previousRunId: task.runId,
          });
        if (!admission.admitted) {
          await updateTask(stateDir, task.id, (n) => {
            if (n.runId === task.runId)
              n.capacityWait = admission.admissionPaused
                ? "Native execution is held for an update."
                : "Waiting for shared native execution capacity.";
          });
          continue;
        }
        const job = launchContinuation(task, runId);
        launches.set(task.id, job);
        // Publish the reserved native run before considering new-worker slots.
        // Preparation here is local context I/O; no project command is run.
        try {
          await job;
        } catch (error) {
          controllerError = errorMessage(error);
        } finally {
          launches.delete(task.id);
        }
      }
      const shared = await capacity.view();
      maxConcurrent = shared.limit;
      for (const task of tasks) {
        if (stopped) break;
        if (
          await admissionHeld({
            taskId: task.id,
            resume: task.status === "resume_queued",
          })
        )
          continue;
        if (
          foreign(task) ||
          launches.has(task.id) ||
          (task.threadId && task.worktree)
        )
          continue;
        if (
          task.status === "launching" &&
          Date.now() - Date.parse(task.launchAt || "") >= 15000
        )
          await fail(
            task.id,
            "Launch interrupted; inspect its environment before restarting.",
          );
        if (!["queued", "resume_queued"].includes(task.status)) continue;
        if (task.archiveRestoration?.requiresRecovery) {
          await fail(
            task.id,
            "This restored worker is history only and requires explicit recovery before lifecycle execution.",
          );
          continue;
        }
        // Restart reconciles running work but never dispatches a stored backlog.
        if (startupQueued.has(task.id)) {
          // Lifecycle start/resume explicitly removes this hold. Otherwise only
          // a changed durable answer can authorize dispatch; timestamps and
          // unrelated render/attention updates never replay old authorization.
          if (
            JSON.stringify(task.answer || null) === startupQueued.get(task.id)
          )
            continue;
          startupQueued.delete(task.id);
        }
        if (
          task.harnessStarted &&
          !confirmedExit(
            task,
            task.runDir
              ? await json(path.join(requireRunDir(task), "exit.json"))
              : null,
          )
        )
          continue;
        const runId = randomUUID();
        const admission = await capacity.acquire({ taskId: task.id, runId });
        maxConcurrent = admission.limit;
        if (!admission.admitted) {
          await updateTask(stateDir, task.id, (n) => {
            if (
              n.status !== task.status ||
              n.runId !== task.runId ||
              !["queued", "resume_queued"].includes(n.status)
            )
              return;
            n.capacityWait = admission.admissionPaused
              ? "Waiting while Crew prepares an update"
              : "Waiting for shared worker capacity";
          });
          continue;
        }
        await updateTask(stateDir, task.id, (n) => {
          delete n.capacityWait;
        });
        const job = launch(task, task.status === "resume_queued", runId);
        launches.set(task.id, job);
        void job
          .catch((error) => {
            controllerError = errorMessage(error);
          })
          .finally(() => {
            launches.delete(task.id);
            void tick();
          });
      }
    } catch (error) {
      controllerError = errorMessage(error);
    } finally {
      const view = {
        tasks: await loadTasks(stateDir).catch(() => []),
        error: controllerError,
        maxConcurrent,
      };
      const serialized = JSON.stringify(view);
      if (serialized !== lastView) {
        lastView = serialized;
        onChange(view);
      }
      busy = false;
    }
  }
  timer = setInterval(() => void tick(), 250);
  await tick();
  return {
    view: async () => ({
      tasks: await loadTasks(stateDir),
      error: controllerError,
      maxConcurrent,
    }),
    tick,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      while (busy) await new Promise((r) => setTimeout(r, 20));
      await Promise.allSettled([...launches.values(), ...operations.values()]);
      await unlink(lockPath);
    },
  };
}
