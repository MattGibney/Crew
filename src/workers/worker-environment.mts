import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Project } from "./contracts.mjs";
import {
  readTask,
  updateTask,
  withStateLock,
} from "../orchestration/store.mjs";
import { selectWorktreeRoot, ensureWorktreeRoot } from "./worktree-paths.mjs";
const exec = promisify(execFile);
/** Explicit environment attachment, independent from conversation delivery. No project commands. */
export async function prepareWorkerEnvironment({
  stateDir,
  project,
  taskId,
  repositoryId,
}: {
  stateDir: string;
  project: Project | null;
  taskId: string;
  repositoryId: string;
}) {
  return withStateLock(stateDir, `.environment-${taskId}.lock`, async () => {
    const task = await readTask(stateDir, taskId);
    if (
      !project ||
      project.mode !== "repository" ||
      task.projectId !== project.id
    )
      throw new Error("Task belongs to another project.");
    const repository = project.repositories.find(
      (item) => item.id === repositoryId,
    );
    if (
      !repository?.path ||
      !repository.baseRef ||
      repository.baseRef.startsWith("-")
    )
      throw new Error("Configured repository path and baseRef are required.");
    if (task.worktree) {
      if ((task.environmentRepositoryId || task.repositoryId) !== repositoryId)
        throw new Error(
          "An environment is already attached from a different repository; it was retained.",
        );
      try {
        if ((await stat(task.worktree)).isDirectory())
          return {
            taskId,
            worktree: task.worktree,
            retained: true,
            applies: "next native continuation",
          };
      } catch {}
      throw new Error(
        "A missing environment is retained. Explicitly resolve that resource record before attaching a replacement.",
      );
    }
    const repo = await realpath(repository.path);
    const { stdout: top } = await exec("git", [
      "-C",
      repo,
      "rev-parse",
      "--show-toplevel",
    ]);
    if ((await realpath(top.trim())) !== repo)
      throw new Error("Configured repository must be the Git root.");
    const { stdout: commit } = await exec("git", [
      "-C",
      repo,
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${repository.baseRef}^{commit}`,
    ]);
    const root = await selectWorktreeRoot(stateDir, task);
    await ensureWorktreeRoot(stateDir, root);
    const name = `crew-${randomUUID().replace(/-/g, "")}`;
    const worktree = path.join(root, name);
    await exec("git", [
      "-C",
      repo,
      "worktree",
      "add",
      "--detach",
      worktree,
      commit.trim(),
    ]);
    // A created worktree is retained even if persistence fails; never delete work
    // silently. Retrying reports the original attachment when it was saved.
    await updateTask(stateDir, taskId, (next) => {
      next.environmentRepositoryId = repositoryId;
      next.worktree = worktree;
      next.worktreeName = name;
      next.worktreeRoot = root;
      next.repositoryPath = repo;
      next.baseCommit = commit.trim();
    });
    return {
      taskId,
      worktree,
      retained: false,
      applies: "next native continuation",
    };
  });
}
