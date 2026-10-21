import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, realpath } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Project, TaskRecord, PromptSnapshot } from "./contracts.mjs";
import type { createGlobalCapacity } from "../global-capacity.mjs";
import {
  atomic,
  evidencePath,
  environmentHooks,
  confirmedExit,
} from "./controller-evidence.mjs";
import { errorCode, errorMessage, isRecord } from "./errors.mjs";
import {
  readRunnerRecord as json,
  readEnvironmentEvidence,
} from "./evidence.mjs";
import { readTask, updateTask } from "../orchestration-store.mjs";
import { discoverProjectExecutionPlan } from "../project-execution-plan.mjs";
import {
  resolveProjectToolchain,
  applyProjectToolchain,
} from "../project-toolchain.mjs";
import {
  runEnvironmentHooks,
  environmentFile,
  reconcileEnvironment,
} from "../worker-environment.mjs";
import {
  prepareProjectEnvironment,
  stopProjectEnvironment,
} from "../project-environment.mjs";
import { selectWorktreeRoot, ensureWorktreeRoot } from "../worktree-paths.mjs";
import { promptSnapshot, promptVersion } from "../prompt-settings.mjs";
interface LaunchOptions {
  stateDir: string;
  sourceDir: string;
  executable: string;
  project: Project | null;
  workerPrompt: string;
  getWorkerPrompt: (() => Promise<PromptSnapshot>) | null;
  capacity: Awaited<ReturnType<typeof createGlobalCapacity>>;
  admissionHeld: (request: {
    taskId: string;
    resume: boolean;
  }) => Promise<boolean>;
  isStopped: () => boolean;
  fixture: () => Promise<{
    repo: string;
    commit: string;
    base: string;
    at: string;
  }>;
  fail: (id: string, message: string) => Promise<void>;
  finishRequest: (
    id: string,
    requestId: string,
    error?: string | null,
  ) => Promise<void>;
  launchAbort: Map<string, AbortController>;
}
const exec = promisify(execFile),
  now = () => new Date().toISOString();
/** Own preparation and native spawn as one abortable, evidence-preserving operation. */
export function createWorkerLauncher({
  stateDir,
  sourceDir,
  executable,
  project,
  workerPrompt,
  getWorkerPrompt,
  capacity,
  admissionHeld,
  isStopped,
  fixture,
  fail,
  finishRequest,
  launchAbort,
}: LaunchOptions) {
  return async function launch(
    task: TaskRecord,
    resume: boolean,
    runId: string,
  ) {
    if (isStopped() || (await admissionHeld({ taskId: task.id, resume }))) {
      await capacity.releasePreparation({ taskId: task.id, runId });
      return;
    }
    if (
      task.harnessStarted &&
      !confirmedExit(
        task,
        task.runDir ? await json(evidencePath(task, "exit.json")) : null,
      )
    ) {
      await fail(
        task.id,
        "The previous worker run has no matching confirmed terminal record. Preserve its environment until ownership is reconciled.",
      );
      await capacity.releasePreparation({ taskId: task.id, runId });
      return;
    }
    if (
      resume &&
      project?.mode === "repository" &&
      task.workerSandbox !== project.worker?.sandbox
    ) {
      await fail(
        task.id,
        "Worker sandbox configuration changed since this task started; refusing resume or permission escalation.",
      );
      await capacity.releasePreparation({ taskId: task.id, runId });
      return;
    }
    const abort = new AbortController();
    launchAbort.set(task.id, abort);
    let workerDispatched = false;
    try {
      await updateTask(stateDir, task.id, (next) => {
        if (next.status !== (resume ? "resume_queued" : "queued"))
          throw new Error("Task status changed before launch.");
        next.status = "launching";
        next.harnessStarted = false;
        next.runnerPid = null;
        next.failure = null;
        next.startedAt = null;
        next.endedAt = null;
        next.execution = null;
        next.spawnIntentAt = null;
        next.previousRunId = next.runId || null;
        next.runId = runId;
        next.launchAt = now();
        if (resume)
          for (const item of next.attention)
            if (item.kind === "question" && !item.ackedAt) item.ackedAt = now();
      });
      const pauseBoundary = async () => {
        for (;;) {
          if (isStopped()) {
            const error = new Error(
              "Controller stopped at a safe preparation boundary. Existing environment evidence was retained.",
            );
            Object.assign(error, { controllerShutdown: true });
            throw error;
          }
          const latest = await readTask(stateDir, task.id);
          const request = latest.lifecycleRequests?.find(
            (r) =>
              ["pending", "processing"].includes(r.status) &&
              r.action === "pause" &&
              r.cooperative === true,
          );
          if (request) {
            await updateTask(stateDir, task.id, (n) => {
              n.status = "pausing";
              const r = n.lifecycleRequests.find((r) => r.id === request.id);
              if (r) r.status = "processing";
            });
            const error = new Error(
              "Cooperative update pause reached a safe preparation boundary.",
            );
            Object.assign(error, { cooperative: true });
            throw error;
          }
          if (!(await admissionHeld({ taskId: task.id, resume }))) return;
          await new Promise((r) => setTimeout(r, 50));
        }
      };
      await pauseBoundary();
      if (
        project &&
        task.projectId !== project.id &&
        !(project.mode === "fixture" && !task.projectId)
      )
        throw new Error("Task project does not match this controller");
      const repositoryMode = project?.mode === "repository";
      // Capture at the first actual launch, before provisioning. Retained workers
      // keep the same behavior across answers, pause/resume and controller restart.
      let workerPromptSnapshot = task.workerPromptSnapshot;
      if (!workerPromptSnapshot && (resume || task.threadId)) {
        const previous = task.runDir
          ? await json(evidencePath(task, "config.json"))
          : null;
        if (
          !previous ||
          typeof previous.workerPrompt !== "string" ||
          !previous.workerPrompt.trim()
        )
          throw new Error(
            "Original worker prompt is unavailable; refusing to resume with changed behavior.",
          );
        workerPromptSnapshot = promptSnapshot(previous.workerPrompt);
      }
      if (!workerPromptSnapshot)
        workerPromptSnapshot = getWorkerPrompt
          ? await getWorkerPrompt()
          : promptSnapshot(
              workerPrompt ||
                (await readFile(
                  path.join(sourceDir, "prompts", "worker.md"),
                  "utf8",
                )),
            );
      if (
        !workerPromptSnapshot ||
        promptVersion(workerPromptSnapshot.text) !==
          workerPromptSnapshot.version
      )
        throw new Error("Worker prompt snapshot version is invalid.");
      await updateTask(stateDir, task.id, (next) => {
        next.workerPromptSnapshot = workerPromptSnapshot;
      });

      if (project && !project.readiness?.ready)
        throw new Error(
          "Project configuration is incomplete; no worktree was created",
        );
      if (
        project &&
        !["read-only", "workspace-write"].includes(project.worker?.sandbox)
      )
        throw new Error("Invalid worker sandbox configuration");
      let meta;
      if (repositoryMode) {
        const repository = project.repositories.find(
          (repo) => repo.id === task.repositoryId,
        );
        if (!repository?.path || !repository.baseRef)
          throw new Error(
            "Configured repository path and baseRef are required",
          );
        const repo = await realpath(repository.path);
        const { stdout: top } = await exec("git", [
          "-C",
          repo,
          "rev-parse",
          "--show-toplevel",
        ]);
        if ((await realpath(top.trim())) !== repo)
          throw new Error("Configured repository path must be the Git root");
        if (repository.baseRef.startsWith("-"))
          throw new Error("Invalid configured baseRef");
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
          repositoryId: repository.id,
        };
      } else meta = await fixture();
      let worktree = task.worktree;
      if (!resume && !worktree) {
        const worktreeName =
          task.worktreeName || `crew-${randomUUID().replace(/-/g, "")}`;
        await updateTask(stateDir, task.id, (next) => {
          next.worktreeName = worktreeName;
          if (repositoryMode) next.worktreeRoot = meta.base;
        });
        if (repositoryMode) await ensureWorktreeRoot(stateDir, meta.base);
        task.worktreeName = worktreeName;
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
      if (!worktree) throw new Error("Retained worktree is unavailable.");
      if ((resume || task.worktree) && task.repositoryPath !== meta.repo)
        throw new Error(
          "Repository changed since this task started; review before resuming",
        );
      if (resume || task.worktree) {
        try {
          await realpath(worktree);
        } catch (error) {
          if (errorCode(error) === "ENOENT")
            throw new Error(
              "Retained worktree is missing. Ask the manager to review missing-worktree recovery; cleanup is unverified.",
            );
          throw error;
        }
        const { stdout } = await exec("git", [
          "-C",
          worktree,
          "rev-parse",
          "HEAD",
        ]);
        if (stdout.trim() !== task.baseCommit)
          throw new Error("Worker baseline changed; refusing resume.");
      }
      if (task.worktree) {
        const actual = await realpath(worktree),
          expected = await realpath(
            path.join(
              meta.base,
              task.worktreeName ||
                (repositoryMode ? task.id : `worker-${task.id}`),
            ),
          );
        const { stdout: list } = await exec("git", [
          "-C",
          meta.repo,
          "worktree",
          "list",
          "--porcelain",
        ]);
        if (actual !== expected || actual === meta.repo)
          throw new Error(
            "Retained worktree path ownership does not match this task.",
          );
        if (!list.includes(`worktree ${actual}\n`))
          throw new Error(
            "Retained worktree is not registered with its repository. Review Git registration before resuming.",
          );
      }
      const runDir = path.join(stateDir, "runs", task.id, runId);
      await mkdir(runDir, { recursive: true, mode: 0o700 });
      await updateTask(stateDir, task.id, (next) => {
        next.worktree = worktree;
        next.repositoryPath = meta.repo;
        next.baseCommit = task.worktree ? task.baseCommit : meta.commit;
        next.runDir = runDir;
        next.harnessStarted = false;
        next.fixtureRepo = repositoryMode ? null : meta.repo;
        next.fixtureCommit = repositoryMode ? null : meta.commit;
      });
      const baseCommit = task.worktree ? task.baseCommit : meta.commit;
      if (!baseCommit)
        throw new Error("Retained worker baseline is unavailable.");
      const existingEnvironment = await readEnvironmentEvidence(
        environmentFile(stateDir, task.id),
      );
      if (existingEnvironment?.preset)
        throw new Error(
          "An obsolete project-specific environment is retained. No project protocol was executed; preserve its state and recover it with its original project tooling.",
        );
      await pauseBoundary();
      const plainDiscovery =
        repositoryMode && !project?.worker?.environment?.executionPlan
          ? await discoverProjectExecutionPlan({
              path: meta.repo,
              ref: baseCommit,
            })
          : null;
      const plainToolchain =
        repositoryMode && !project?.worker?.environment?.executionPlan
          ? await resolveProjectToolchain({
              worktree,
              baseCommit: baseCommit,
              plan: { sources: plainDiscovery?.sources || [] },
              retained: existingEnvironment?.toolchain,
            })
          : null;
      await pauseBoundary();
      const environment = project?.worker?.environment?.executionPlan
        ? await prepareProjectEnvironment({
            plan: project.worker.environment.executionPlan,
            stateDir,
            taskId: task.id,
            worktree,
            repositoryPath: meta.repo,
            baseCommit: baseCommit,
            resume,
            signal: abort.signal,
            pauseBoundary,
            onEvidence: (environment) =>
              updateTask(stateDir, task.id, (next) => {
                next.environment = environment;
              }),
          })
        : await runEnvironmentHooks({
            stateDir,
            taskId: task.id,
            worktree,
            hooks: environmentHooks(project),
            phases: resume
              ? ["resume", "ready"]
              : ["bootstrap", "start", "ready"],
            existing:
              existingEnvironment ||
              (plainToolchain
                ? {
                    id: `crew-${randomUUID().replace(/-/g, "")}`,
                    taskId: task.id,
                    worktree,
                    hooks: [],
                    toolchain: plainToolchain,
                  }
                : null),
            toolchain: plainToolchain,
            env: plainToolchain
              ? applyProjectToolchain(plainToolchain)
              : process.env,
            signal: abort.signal,
            pauseBoundary,
            onEvidence: (environment) =>
              updateTask(stateDir, task.id, (next) => {
                next.environment = environment;
              }),
          });
      if (abort.signal.aborted)
        throw new Error("Worker environment preparation canceled.");

      await pauseBoundary();
      const config = {
        project,
        workerPrompt: workerPromptSnapshot.text,
        workerPromptVersion: workerPromptSnapshot.version,
        sandbox: repositoryMode ? project.worker.sandbox : "read-only",
        timeoutMs: project?.worker?.timeoutMs || 300000,
        taskId: task.id,
        runId,
        ticket: task.ticket,
        brief: task.brief,
        modelSelection: task.modelSelection || null,
        environment,
        answer: resume ? task.answer : null,
        threadId: resume ? task.threadId : null,
        worktree,
        stateDir,
        executable,
        mcpScript: path.join(sourceDir, "orchestration-mcp.mjs"),
      };
      if (resume && !config.threadId)
        throw new Error("Cannot resume: no recorded worker Codex session.");
      await atomic(path.join(runDir, "config.json"), config);
      await updateTask(stateDir, task.id, (next) => {
        next.worktree = worktree;
        next.fixtureRepo = repositoryMode ? null : meta.repo;
        next.fixtureCommit = repositoryMode ? null : meta.commit;
        next.repositoryPath = meta.repo;
        next.baseCommit = task.worktree ? task.baseCommit : meta.commit;
        next.workerSandbox = config.sandbox;
        next.runDir = runDir;
        next.runId = runId;
        next.status = "running";
        next.harnessStarted = "pending";
        next.spawnIntentAt = now();
        next.startedAt = null;
        next.endedAt = null;
        next.execution = null;
        next.handledReports = next.handledReports || [];
      });
      await pauseBoundary();
      const runner = spawn(
        process.execPath,
        [
          path.join(sourceDir, "worker-runner.mjs"),
          path.join(runDir, "config.json"),
        ],
        {
          cwd: sourceDir,
          detached: true,
          stdio: "ignore",
          env: applyProjectToolchain(environment.toolchain),
        },
      );
      workerDispatched = true;
      await new Promise((resolve, reject) => {
        runner.once("spawn", resolve);
        runner.once("error", reject);
      });
      runner.unref();
      await updateTask(stateDir, task.id, (next) => {
        next.runnerPid = runner.pid;
        next.harnessStarted = true;
      });
    } catch (error) {
      if (!workerDispatched)
        await updateTask(stateDir, task.id, (n) => {
          n.harnessStarted = false;
          n.spawnIntentAt = null;
        });
      if (isRecord(error) && error.controllerShutdown === true) {
        await updateTask(stateDir, task.id, (n) => {
          n.status = "paused";
          n.endedAt = now();
          n.preparationPause = { reason: "controller-shutdown", at: n.endedAt };
        });
        return;
      }
      const latest = await readTask(stateDir, task.id);
      if (["stopping", "pausing"].includes(latest.status)) {
        if (latest.environment?.kind === "project-execution") {
          try {
            await stopProjectEnvironment({
              stateDir,
              taskId: task.id,
              cooperative:
                (isRecord(error) && error.cooperative === true) ||
                latest.lifecycleRequests?.some(
                  (r) => r.status === "processing" && r.cooperative === true,
                ),
              onEvidence: (environment) =>
                updateTask(stateDir, task.id, (n) => {
                  n.environment = environment;
                }),
            });
          } catch (stopError) {
            await fail(
              task.id,
              `Project environment shutdown was not confirmed: ${errorMessage(stopError)}`,
            );
            for (const r of latest.lifecycleRequests || [])
              if (r.status === "processing")
                await finishRequest(task.id, r.id, errorMessage(stopError));
            return;
          }
        }
        await updateTask(stateDir, task.id, (n) => {
          n.status = n.status === "pausing" ? "paused" : "stopped";
          n.endedAt = now();
          for (const r of n.lifecycleRequests || [])
            if (r.status === "processing") {
              r.status = "completed";
              r.handledAt = now();
            }
        });
      } else
        await fail(task.id, `Worker launch failed: ${errorMessage(error)}`);
    } finally {
      launchAbort.delete(task.id);
      const latest = await readTask(stateDir, task.id);
      const environment = await reconcileEnvironment({
        stateDir,
        taskId: task.id,
      });
      if (
        latest.runId !== runId ||
        (!latest.harnessStarted && !environment?.pending)
      )
        await capacity.releasePreparation({ taskId: task.id, runId });
    }
  };
}
