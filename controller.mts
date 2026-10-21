import {
  evidencePath,
  environmentHooks,
  atomic,
  confirmedExit,
} from "./execution/controller-evidence.mjs";
import type {
  Project,
  TaskRecord,
  TaskReport,
  LifecycleRequest,
} from "./execution/contracts.mjs";
import {
  readRunnerRecord,
  readEnvironmentEvidence,
  type RunnerRecord,
} from "./execution/evidence.mjs";
import type { ProcessSnapshot } from "./process-ownership.mjs";
import { errorCode, errorMessage, isRecord } from "./execution/errors.mjs";
interface ControllerOptions {
  stateDir: string;
  sourceDir: string;
  executable: string;
  project?: Project | null;
  workerPrompt?: string;
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
import { createWorkerLifecycle } from "./execution/worker-lifecycle.mjs";
import { createWorkerLauncher } from "./execution/worker-launch.mjs";
import { verifyWorkerCompletion } from "./execution/worker-verification.mjs";
import { discoverProjectExecutionPlan } from "./project-execution-plan.mjs";
import {
  resolveProjectToolchain,
  applyProjectToolchain,
} from "./project-toolchain.mjs";
// Deterministic local controller. Polls files; never polls a model or starts voice.
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  mkdtemp,
  open,
  unlink,
  realpath,
} from "node:fs/promises";
import {
  runEnvironmentHooks,
  environmentFile,
  reconcileEnvironment,
} from "./worker-environment.mjs";
import {
  prepareProjectEnvironment,
  stopProjectEnvironment,
  disposeProjectEnvironment,
  inspectProjectEnvironment,
  applyProjectRecovery,
} from "./project-environment.mjs";
import { selectWorktreeRoot, ensureWorktreeRoot } from "./worktree-paths.mjs";
import { snapshotProcesses } from "./process-ownership.mjs";
import { randomUUID } from "node:crypto";
import { promptSnapshot, promptVersion } from "./prompt-settings.mjs";
import path from "node:path";
import os from "node:os";
import { loadTasks, readTask, updateTask } from "./orchestration-store.mjs";
import { createGlobalCapacity } from "./global-capacity.mjs";
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
    launchAbort = new Map<string, AbortController>(),
    operations = new Map<string, Promise<unknown>>();
  let processSnapshot: ProcessSnapshot = new Map();
  async function ownedRunnerAlive(task: TaskRecord) {
    if (!task.runnerPid || !task.runDir) return false;
    const owner = await json(evidencePath(task, "owner.json"));
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
            ["start", "resume"].includes(request.action) &&
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
  async function createFixture(): Promise<Fixture> {
    const metaPath = path.join(stateDir, "fixture.json");
    const meta = await json(metaPath);
    if (meta) {
      if (!meta.repo || !meta.base || !meta.commit || !meta.at)
        throw new Error("Malformed fixture repository metadata.");
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
  const verify = (task: TaskRecord, exit: RunnerRecord, report: TaskReport) =>
    verifyWorkerCompletion({ stateDir, project, task, exit, report });
  const { lifecycle, completeStop, finishRequest } = createWorkerLifecycle({
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
  });
  const launch = createWorkerLauncher({
    stateDir,
    sourceDir,
    executable,
    project,
    workerPrompt,
    getWorkerPrompt,
    capacity,
    admissionHeld,
    isStopped: () => stopped,
    fixture,
    fail,
    finishRequest,
    launchAbort,
  });
  async function reconcile(task: TaskRecord) {
    if (
      project &&
      task.projectId !== project.id &&
      !(project.mode === "fixture" && !task.projectId)
    )
      throw new Error(
        "Stored task belongs to another project; refusing to process it",
      );
    if (
      task.environment?.kind === "project-execution" &&
      !launches.has(task.id) &&
      !operations.has(task.id)
    ) {
      const environment = await inspectProjectEnvironment({
        stateDir,
        taskId: task.id,
        processes: processSnapshot,
        onEvidence: (environment) =>
          updateTask(stateDir, task.id, (n) => {
            n.environment = environment;
          }),
      });
      if (environment) task.environment = environment;
    }
    // Durable supervisor evidence wins over a controller write interrupted at spawn.
    // A pending spawn intent without an owner/terminal record remains uncertain and
    // cannot be treated as a never-executed preparation or silently relaunched.
    if (task.runDir) {
      const started = await json(evidencePath(task, "started.json")),
        owner = await json(evidencePath(task, "owner.json")),
        runtime = await json(evidencePath(task, "runtime.json")),
        exit = await json(evidencePath(task, "exit.json"));
      const config = await json(evidencePath(task, "config.json"));
      const claim =
        config?.runId === task.runId &&
        (await readFile(evidencePath(task, "runner.claim"))
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
    if (task.environment?.preset)
      throw new Error(
        "Obsolete project-specific state is retained; recover it with its original project tooling.",
      );
    task = await lifecycle(task);
    if (!task.runDir) return;
    const runtime = await json(evidencePath(task, "runtime.json")),
      started = await json(evidencePath(task, "started.json")),
      owner = await json(evidencePath(task, "owner.json")),
      exit = await json(evidencePath(task, "exit.json"));
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
      evidencePath(task, "model-selection.json"),
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
    const protocolError = await json(evidencePath(task, "protocol-error.json"));
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
      if (!confirmedExit(task, exit)) {
        await fail(
          task.id,
          "Worker descendants have not confirmed they stopped; preserve its environment.",
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
      } else
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
      const tasks = await loadTasks(stateDir);
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
        if (foreign(task) || launches.has(task.id)) continue;
        if (
          task.status === "launching" &&
          Date.now() - Date.parse(task.launchAt || "") >= 15000
        )
          await fail(
            task.id,
            "Launch interrupted; inspect its environment before restarting.",
          );
        if (!["queued", "resume_queued"].includes(task.status)) continue;
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
            task.runDir ? await json(evidencePath(task, "exit.json")) : null,
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
