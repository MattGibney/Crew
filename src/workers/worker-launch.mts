import { readSavedWorkerProfile } from "../manager/instructions/worker-profile.mjs";
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
export function createWorkerLauncher({
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
  isStopped,
  fixture,
  fail,
  verify,
  ownedTask,
  ownedRunnerAlive,
  getProcessSnapshot,
  nativeConnectionLive,
}: ControllerServices & { nativeConnectionLive: NativeConnectionLive }) {
  const readCurrentPrompt = async () => {
    if (workerProfileSource) {
      if (workerProfileSource.projectId !== project?.id)
        throw new Error("Worker profile project identity changed.");
      return readSavedWorkerProfile(stateDir, workerProfileSource.projectId);
    }
    // Standalone transport fixtures may supply their own source. The product
    // controller always binds the canonical saved project profile above.
    return getWorkerPrompt
      ? getWorkerPrompt()
      : promptSnapshot(
          workerPrompt ||
            (await readFile(
              path.join(sourceDir, "prompts", "worker.md"),
              "utf8",
            )),
        );
  };
  async function launchContinuation(task: TaskRecord, runId: string) {
    if (
      isStopped() ||
      (await admissionHeld({ taskId: task.id, resume: true })) ||
      (await nativeConnectionLive(task, { ignoreLaunch: true }))
    ) {
      await capacity.releasePreparation({ taskId: task.id, runId });
      return;
    }
    if (
      isArchivedTask(task) ||
      ["disposed", "removed", "archived"].includes(task.status) ||
      task.archiveRestoration?.requiresRecovery
    ) {
      await fail(
        task.id,
        "The selected worker environment is unavailable after archive/disposal.",
      );
      return;
    }
    let dispatched = false;
    try {
      if (!task.threadId)
        throw new Error(
          "This worker has no existing native Codex conversation to receive the direction.",
        );
      if (!task.worktree)
        throw new Error("This worker has no existing working directory.");
      const cwd = await realpath(task.worktree);
      if (!(await stat(cwd)).isDirectory())
        throw new Error("The worker working directory is unavailable.");
      const saved = await readCurrentPrompt();
      const assignment = currentAssignment(task),
        runDir = path.join(stateDir, "runs", task.id, runId);
      await mkdir(runDir, { recursive: true, mode: 0o700 });
      const config = {
        project,
        workerProfileSource,
        workerPrompt: saved.text,
        workerPromptVersion: saved.version,
        retainedDirection: true,
        taskId: task.id,
        assignmentId: assignment.id,
        runId,
        ticket: assignment.ticket,
        brief: assignment.brief,
        modelSelection: task.modelSelection || null,
        environment: task.environment || null,
        answer: task.answer || null,
        threadId: task.threadId,
        worktree: cwd,
        stateDir,
        executable,
        mcpScript: path.join(sourceDir, "orchestration-mcp.mjs"),
      };
      await atomic(path.join(runDir, "config.json"), config);
      await updateTask(stateDir, task.id, (n) => {
        if (
          n.runId !== task.runId ||
          n.currentAssignmentId !== task.currentAssignmentId ||
          !["queued", "resume_queued"].includes(n.status)
        )
          throw new Error(
            "Worker transport selection changed before dispatch.",
          );
        n.previousRunId = n.runId || null;
        n.runId = runId;
        n.runDir = runDir;
        n.retainedDirection = true;
        n.workerPromptSnapshot = saved;
        n.status = "running";
        n.harnessStarted = "pending";
        n.runnerPid = null;
        n.spawnIntentAt = now();
        n.startedAt = null;
        n.endedAt = null;
        n.execution = null;
        n.launchAt = now();
      });
      const beforeSpawn = await readTask(stateDir, task.id);
      const stopping = beforeSpawn.lifecycleRequests?.some(
        (item) =>
          ["pending", "processing"].includes(item.status) &&
          ["stop", "pause"].includes(item.action),
      );
      if (
        isStopped() ||
        stopping ||
        (await admissionHeld({
          taskId: task.id,
          resume: Boolean(task.threadId),
        }))
      ) {
        await updateTask(stateDir, task.id, (n) => {
          n.harnessStarted = false;
          n.spawnIntentAt = null;
          if (!["stopping", "pausing"].includes(n.status))
            n.status = stopping
              ? "stopping"
              : n.threadId
                ? "resume_queued"
                : "queued";
        });
        await capacity.releasePreparation({ taskId: task.id, runId });
        return;
      }
      const runner = spawn(
        process.execPath,
        [
          path.join(sourceDir, "workers/runner.mjs"),
          path.join(runDir, "config.json"),
        ],
        { cwd: sourceDir, detached: true, stdio: "ignore", env: process.env },
      );
      await new Promise((resolve, reject) => {
        runner.once("spawn", resolve);
        runner.once("error", reject);
      });
      runner.unref();
      dispatched = true;
      await updateTask(stateDir, task.id, (n) => {
        if (n.runId === runId) {
          n.runnerPid = runner.pid;
          n.harnessStarted = true;
        }
      });
    } catch (error) {
      await updateTask(stateDir, task.id, (n) => {
        if (!dispatched) {
          n.harnessStarted = false;
          n.spawnIntentAt = null;
        }
        n.status = "failed";
        n.failure = `Worker direction transport failed: ${errorMessage(error)}`;
        n.endedAt = now();
        attention(
          n,
          `${n.runId || n.id}:direction-failure`,
          "failure",
          n.failure,
        );
      });
    } finally {
      if (!dispatched)
        await capacity.releasePreparation({ taskId: task.id, runId });
    }
  }
  async function launch(task: TaskRecord, resume: boolean, runId: string) {
    if (task.worktree && task.threadId) return launchContinuation(task, runId);
    if (isStopped() || (await admissionHeld({ taskId: task.id, resume }))) {
      await capacity.releasePreparation({ taskId: task.id, runId });
      return;
    }
    let dispatched = false;
    try {
      if (task.archiveRestoration?.requiresRecovery)
        throw new Error(
          "This worker has history only; its working directory is unavailable.",
        );
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
          "The previous native execution has no confirmed exit; preserve its context.",
        );
      if (project && !ownedTask(task))
        throw new Error("Task project does not match this controller.");
      await updateTask(stateDir, task.id, (n) => {
        if (n.status !== (resume ? "resume_queued" : "queued"))
          throw new Error("Transport selection changed before dispatch.");
        n.status = "launching";
        n.previousRunId = n.runId || null;
        n.runId = runId;
        n.harnessStarted = false;
        n.runnerPid = null;
        n.failure = null;
        n.startedAt = null;
        n.endedAt = null;
        n.execution = null;
        n.spawnIntentAt = null;
        n.launchAt = now();
      });
      const repositoryMode = project?.mode === "repository";
      const saved = await readCurrentPrompt();
      if (!saved || promptVersion(saved.text) !== saved.version)
        throw new Error("Worker prompt snapshot is invalid.");
      let meta;
      if (repositoryMode) {
        const repository = project.repositories.find(
          (repo) => repo.id === task.repositoryId,
        );
        if (!repository?.path || !repository.baseRef)
          throw new Error(
            "Configured repository path and baseRef are required.",
          );
        const repo = await realpath(repository.path);
        const { stdout: top } = await exec("git", [
          "-C",
          repo,
          "rev-parse",
          "--show-toplevel",
        ]);
        if ((await realpath(top.trim())) !== repo)
          throw new Error("Configured repository must be the Git root.");
        if (repository.baseRef.startsWith("-"))
          throw new Error("Invalid repository baseRef.");
        const { stdout: commit } = await exec("git", [
          "-C",
          repo,
          "rev-parse",
          "--verify",
          "--end-of-options",
          `${repository.baseRef}^{commit}`,
        ]);
        meta = {
          repo,
          commit: commit.trim(),
          base: await selectWorktreeRoot(stateDir, task),
        };
      } else meta = await fixture();
      let worktree = task.worktree;
      if (!worktree) {
        const worktreeName =
          task.worktreeName || `crew-${randomUUID().replace(/-/g, "")}`;
        await updateTask(stateDir, task.id, (n) => {
          n.worktreeName = worktreeName;
          if (repositoryMode) n.worktreeRoot = meta.base;
        });
        if (repositoryMode) await ensureWorktreeRoot(stateDir, meta.base);
        worktree = path.join(meta.base, worktreeName);
        await exec("git", [
          "-C",
          meta.repo,
          "worktree",
          "add",
          "--detach",
          worktree,
          meta.commit,
        ]);
      }
      worktree = await realpath(worktree);
      if (!(await stat(worktree)).isDirectory())
        throw new Error("Worker working directory is unavailable.");
      // Configuration is context for the agent, never an automatic command or
      // readiness prerequisite. Native Codex owns command policy and approvals.
      const environment = task.environment || null;
      const runDir = path.join(stateDir, "runs", task.id, runId);
      await mkdir(runDir, { recursive: true, mode: 0o700 });
      const latest = await readTask(stateDir, task.id);
      if (
        ["stopping", "pausing"].includes(latest.status) ||
        latest.lifecycleRequests?.some(
          (item) =>
            ["pending", "processing"].includes(item.status) &&
            ["stop", "pause"].includes(item.action),
        )
      ) {
        await updateTask(stateDir, task.id, (n) => {
          n.worktree = worktree;
          n.repositoryPath = meta.repo;
          n.baseCommit = task.baseCommit || meta.commit;
          n.runDir = runDir;
          n.harnessStarted = false;
          n.spawnIntentAt = null;
        });
        return;
      }
      if (isStopped() || (await admissionHeld({ taskId: task.id, resume }))) {
        await updateTask(stateDir, task.id, (n) => {
          n.worktree = worktree;
          n.repositoryPath = meta.repo;
          n.baseCommit = task.baseCommit || meta.commit;
          n.runDir = runDir;
          n.status = "queued";
          n.harnessStarted = false;
          n.spawnIntentAt = null;
          n.capacityWait =
            "Native execution is held by the manager or application.";
        });
        return;
      }
      const assignment = currentAssignment(task);
      const config = {
        project,
        workerProfileSource,
        workerPrompt: saved.text,
        workerPromptVersion: saved.version,
        agentOwnedEnvironment: true,
        taskId: task.id,
        runId,
        ticket: assignment.ticket,
        brief: assignment.brief,
        assignmentId: assignment.id,
        modelSelection: task.modelSelection || null,
        environment,
        answer: resume ? task.answer : null,
        threadId: task.threadId || null,
        worktree,
        stateDir,
        executable,
        mcpScript: path.join(sourceDir, "orchestration-mcp.mjs"),
      };
      await atomic(path.join(runDir, "config.json"), config);
      await updateTask(stateDir, task.id, (n) => {
        n.workerPromptSnapshot = saved;
        n.worktree = worktree;
        n.repositoryPath = meta.repo;
        n.baseCommit = task.baseCommit || meta.commit;
        n.fixtureRepo = repositoryMode ? null : meta.repo;
        n.fixtureCommit = repositoryMode ? null : meta.commit;
        n.runDir = runDir;
        n.status = "running";
        n.harnessStarted = "pending";
        n.spawnIntentAt = now();
        n.handledReports = n.handledReports || [];
      });
      const beforeSpawn = await readTask(stateDir, task.id);
      const stopping = beforeSpawn.lifecycleRequests?.some(
        (item) =>
          ["pending", "processing"].includes(item.status) &&
          ["stop", "pause"].includes(item.action),
      );
      if (
        isStopped() ||
        stopping ||
        (await admissionHeld({
          taskId: task.id,
          resume: Boolean(task.threadId),
        }))
      ) {
        await updateTask(stateDir, task.id, (n) => {
          n.harnessStarted = false;
          n.spawnIntentAt = null;
          if (!["stopping", "pausing"].includes(n.status))
            n.status = stopping
              ? "stopping"
              : n.threadId
                ? "resume_queued"
                : "queued";
        });
        await capacity.releasePreparation({ taskId: task.id, runId });
        return;
      }
      const runner = spawn(
        process.execPath,
        [
          path.join(sourceDir, "workers/runner.mjs"),
          path.join(runDir, "config.json"),
        ],
        { cwd: sourceDir, detached: true, stdio: "ignore", env: process.env },
      );
      await new Promise((resolve, reject) => {
        runner.once("spawn", resolve);
        runner.once("error", reject);
      });
      runner.unref();
      dispatched = true;
      await updateTask(stateDir, task.id, (n) => {
        n.runnerPid = runner.pid;
        n.harnessStarted = true;
      });
    } catch (error) {
      if (!dispatched)
        await updateTask(stateDir, task.id, (n) => {
          n.harnessStarted = false;
          n.spawnIntentAt = null;
        });
      await fail(task.id, `Worker launch failed: ${errorMessage(error)}`);
    } finally {
      const latest = await readTask(stateDir, task.id);
      if (latest.runId !== runId || !latest.harnessStarted)
        await capacity.releasePreparation({ taskId: task.id, runId });
    }
  }

  return { launchContinuation, launch };
}
