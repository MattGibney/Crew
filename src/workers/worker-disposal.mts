import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath, lstat } from "node:fs/promises";
import path from "node:path";
import type { TaskRecord, LifecycleRequest } from "./contracts.mjs";
import type { ControllerServices } from "./controller-services.mjs";
import {
  readRunnerRecord as json,
  readEnvironmentEvidence,
} from "./evidence.mjs";
import {
  environmentHooks,
  connectionEnded,
  alive,
  requireRepository,
  requireRunDir,
} from "./controller-evidence.mjs";
import { errorCode } from "./errors.mjs";
import {
  readTask,
  updateTask,
  ensureArchiveExecutionStopped,
} from "../orchestration/store.mjs";
import {
  runEnvironmentHooks,
  environmentFile,
  reconcileEnvironment,
} from "../projects/worker-environment.mjs";
import { applyProjectToolchain } from "../toolchains/project.mjs";
import {
  disposeProjectEnvironment,
  reviewProjectRecovery,
} from "../projects/environment.mjs";
import { selectWorktreeRoot } from "./worktree-paths.mjs";
const exec = promisify(execFile),
  now = () => new Date().toISOString();
export function createWorkerDisposal({
  stateDir,
  project,
  fixture,
}: Pick<ControllerServices, "stateDir" | "project" | "fixture">) {
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
  return dispose;
}
