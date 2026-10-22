import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath, lstat } from "node:fs/promises";
import path from "node:path";
import type { LifecycleRequest } from "../workers/contracts.mjs";
import type { RecoveryContext } from "./project-context.mjs";
import {
  assertOwned,
  persist,
  runtimeState,
  executionPlanHash,
  canonical,
} from "./project-state.mjs";
import {
  verifyProjectWorktree,
  assertPlan,
  verifySources,
  verifyPermissionsSource,
} from "./project-integrity.mjs";
import {
  readEnvironmentEvidence,
  readRunnerRecord as json,
} from "../workers/evidence.mjs";
import { errorCode, errorMessage } from "../workers/errors.mjs";
import { environmentFile } from "./worker-environment.mjs";
import { selectWorktreeRoot } from "../workers/worktree-paths.mjs";
import { snapshotProcesses } from "../processes/ownership.mjs";
const exec = promisify(execFile),
  now = () => new Date().toISOString();
// GH-24: recovery only changes reviewed metadata. It never executes a command.
const recoveryPhases = ["resume", "ready", "stop", "teardown"];
const equalValue = (a: unknown, b: unknown) =>
  JSON.stringify(canonical(a ?? null)) === JSON.stringify(canonical(b ?? null));
async function recoveryChecks(args: RecoveryContext) {
  const { task, project, mode } = args;
  const environment = await readEnvironmentEvidence(
    environmentFile(args.stateDir, task.id),
  );
  if (!["reconcile_plan", "retire_missing"].includes(mode))
    throw new Error("Unknown recovery action.");
  if (
    !["paused", "stopped", "failed", "blocked", "completed"].includes(
      task.status,
    )
  )
    throw new Error(
      "Pause or stop this worker and wait for confirmed exit before recovery.",
    );
  if (project?.mode !== "repository" || project.id !== task.projectId)
    throw new Error(
      "Recovery requires the task’s configured repository project.",
    );
  const repository = project.repositories?.find(
    (entry) => entry.id === (task.environmentRepositoryId || task.repositoryId),
  );
  if (
    !repository?.path ||
    (await realpath(repository.path)) !== task.repositoryPath
  )
    throw new Error(
      "Configured repository identity changed. Restore the original repository before recovery.",
    );
  if (task.workerSandbox && task.workerSandbox !== project.worker?.sandbox)
    throw new Error(
      "Worker permission configuration changed. Restore its original settings before lifecycle recovery.",
    );
  const expectedWorktree = path.join(
    await selectWorktreeRoot(args.stateDir, task),
    task.worktreeName || task.id,
  );
  if (
    !task.worktree ||
    path.resolve(task.worktree) !== task.worktree ||
    expectedWorktree !== task.worktree
  )
    throw new Error(
      "Retained worktree path does not match its owned workspace location.",
    );
  if (environment) {
    assertOwned({ taskId: task.id, stateDir: args.stateDir }, environment);
    if (
      environment.worktree !== task.worktree ||
      environment.repositoryPath !== task.repositoryPath ||
      environment.baseCommit !== task.baseCommit
    )
      throw new Error(
        "Retained environment repository, worktree or baseline identity changed.",
      );
  }
  if (
    task.runDir &&
    task.runDir !== path.join(args.stateDir, "runs", task.id, task.runId || "")
  )
    throw new Error("Worker run evidence directory identity changed.");
  const exit = task.runDir
    ? await json(path.join(task.runDir, "exit.json"))
    : null;
  let nativeEvidence = false;
  if (task.runDir)
    for (const file of [
      "owner.json",
      "started.json",
      "runtime.json",
      "runner.claim",
    ])
      if (
        await lstat(path.join(task.runDir, file)).catch((error) => {
          if (errorCode(error) === "ENOENT") return null;
          throw error;
        })
      )
        nativeEvidence = true;
  if (
    (task.harnessStarted ||
      task.spawnIntentAt ||
      task.runnerPid ||
      nativeEvidence) &&
    !(exit && exit.runId === task.runId && exit.stopConfirmed === true)
  )
    throw new Error(
      "Worker process exit is unconfirmed for this run. Preserve its evidence before recovery.",
    );
  if (task.runnerPid) {
    if (!task.runDir)
      throw new Error("Worker run evidence directory identity changed.");
    const owner = await json(path.join(task.runDir, "owner.json")),
      actual = (await snapshotProcesses()).get(task.runnerPid);
    if (!actual) {
      try {
        process.kill(task.runnerPid, 0);
        throw new Error(
          "Worker supervisor liveness is unavailable. Preserve it before recovery.",
        );
      } catch (error) {
        if (errorCode(error) !== "ESRCH") throw error;
      }
    }
    if (
      actual &&
      (!owner?.supervisorIdentity ||
        (actual.start === owner.supervisorIdentity.start &&
          actual.commandHash === owner.supervisorIdentity.commandHash)) &&
      !actual.state?.includes("Z")
    )
      throw new Error(
        "Worker supervisor still exists or its ownership is unknown. Wait for exit before recovery.",
      );
  }
  for (const hook of environment?.hooks || []) {
    if (hook.status !== "running") continue;
    if (
      hook.runDir !==
      path.join(args.stateDir, "runs", task.id, "environment", hook.id)
    )
      throw new Error("Lifecycle command evidence ownership changed.");
    const terminal = await json(path.join(hook.runDir, "exit.json"));
    if (terminal?.id !== hook.id || terminal.confirmed !== true)
      throw new Error(
        `Lifecycle ${hook.phase} command exit is unconfirmed. Recovery cannot stop or replay it.`,
      );
  }
  if (
    environment &&
    !["absent", "stopped"].includes((await runtimeState(environment)).kind)
  )
    throw new Error(
      "Foreground project runtime is active or its exit/ownership is unknown. Stop it through its declared lifecycle before recovery.",
    );
  return environment;
}
export async function reviewProjectRecovery(args: RecoveryContext) {
  const { task, project, mode } = args;
  const environment = await readEnvironmentEvidence(
    environmentFile(args.stateDir, task.id),
  );
  const retained = environment?.plan || null,
    current = project?.worker?.environment?.executionPlan || null;
  const differences = Object.keys({ ...retained, ...current })
    .filter((key) => !equalValue(retained?.[key], current?.[key]))
    .map((key) => ({
      field: key,
      retained: retained?.[key] ?? null,
      current: current?.[key] ?? null,
    }));
  const identity = {
    taskId: task.id,
    runId: task.runId || null,
    mode,
    environmentId: environment?.id || null,
    worktree: task.worktree,
    repositoryPath: task.repositoryPath,
    baseCommit: task.baseCommit,
    retainedPlanHash: retained ? executionPlanHash(retained) : null,
    currentPlanHash: current ? executionPlanHash(current) : null,
  };
  const reviewHash = executionPlanHash(identity),
    blockers = [];
  try {
    await recoveryChecks(args);
    if (!task.worktree || !task.repositoryPath || !task.baseCommit)
      throw new Error("Retained worktree identity is incomplete.");
    if (mode === "retire_missing") {
      const metadata = await lstat(task.worktree).catch((error) => {
        if (errorCode(error) === "ENOENT") return null;
        throw error;
      });
      if (metadata)
        throw new Error(
          "Worktree path still exists (including symlinks). Use normal safe disposal; no record was retired.",
        );
      if (
        (await realpath(path.dirname(task.worktree))) !==
        path.dirname(task.worktree)
      )
        throw new Error("Worktree parent identity is not canonical.");
      const { stdout } = await exec(
        "git",
        ["-C", task.repositoryPath, "worktree", "list", "--porcelain", "-z"],
        { timeout: 10000, maxBuffer: 1024 * 1024 },
      );
      if (stdout.split("\0").includes(`worktree ${task.worktree}`))
        throw new Error(
          "Worktree is still registered with Git. Review and reconcile it with project tooling before retiring this record.",
        );
    } else {
      if (!environment?.plan || !retained || !current)
        throw new Error(
          "A retained and a current source-backed execution plan are required.",
        );
      const metadata = await lstat(task.worktree);
      if (
        !metadata.isDirectory() ||
        metadata.isSymbolicLink() ||
        (await realpath(task.worktree)) !== task.worktree
      )
        throw new Error(
          "Retained worktree identity is not a canonical directory. No configuration was adopted.",
        );
      await verifyProjectWorktree({
        worktree: task.worktree,
        repositoryPath: task.repositoryPath,
        baseCommit: task.baseCommit,
      });
      assertPlan(current);
      const allowed = new Set([...recoveryPhases, "sources"]);
      const incompatible = differences.filter(
        (entry) => !allowed.has(entry.field),
      );
      if (incompatible.length)
        throw new Error(
          `Incompatible plan changes: ${incompatible.map((entry) => entry.field).join(", ")}. Setup, Start, environment and permissions remain pinned.`,
        );
      if (
        !Array.isArray(current.sources) ||
        retained.sources.some(
          (source) =>
            !current.sources.some((entry) => equalValue(entry, source)),
        )
      )
        throw new Error(
          "Existing source provenance changed or was removed. Restore its pinned evidence before recovery.",
        );
      // New provenance must be pinned and present. Existing non-executable guidance
      // may contain retained worker edits, just as it may during ordinary resume.
      for (const source of current.sources.filter(
        (source) =>
          !retained.sources.some((entry) => equalValue(entry, source)),
      ))
        await verifySources(
          task.worktree,
          task.baseCommit,
          {
            ...current,
            ready: {
              command: "source validation only",
              timeoutMs: 1000,
              source,
            },
          },
          ["ready"],
        );
      await verifySources(task.worktree, task.baseCommit, current);
      await verifyPermissionsSource(task.repositoryPath, current);
      if (
        environment.setupAttempted &&
        !environment.prepared &&
        !environment.hooks?.some(
          (h) => h.phase === "setup" && h.status === "succeeded",
        )
      ) {
        // Teardown can recover failed provisioning; a plan change never authorizes reseeding.
        if (
          differences.some(
            (entry) => !["teardown", "sources"].includes(entry.field),
          )
        )
          throw new Error(
            "Incomplete setup permits only reviewed teardown recovery; setup will not be replayed.",
          );
      }
    }
  } catch (error) {
    blockers.push(errorMessage(error));
  }
  return {
    ...identity,
    reviewHash,
    differences,
    allowed: blockers.length === 0,
    blockers,
    cleanupVerified: false,
  };
}
export async function applyProjectRecovery(
  args: RecoveryContext & { request: LifecycleRequest },
) {
  const { task, request } = args;
  const prior = await readEnvironmentEvidence(
    environmentFile(args.stateDir, task.id),
  );
  const applied = prior?.recoveryHistory?.find(
    (entry) => entry.actionId === request.id,
  );
  if (applied) {
    if (
      applied.reviewHash !== request.reviewHash ||
      applied.runId !== (task.runId || null) ||
      applied.currentPlanHash !==
        executionPlanHash(args.project?.worker.environment?.executionPlan)
    )
      throw new Error(
        "Recovery retry no longer matches its saved decision. Review current state again.",
      );
    const recheck = await reviewProjectRecovery(args);
    if (!recheck.allowed) throw new Error(recheck.blockers.join(" "));
    return prior;
  }
  const review = await reviewProjectRecovery(args);
  if (review.reviewHash !== request.reviewHash)
    throw new Error(
      "Recovery review is stale. Review retained and current evidence again; nothing was changed.",
    );
  if (!review.allowed) throw new Error(review.blockers.join(" "));
  if (args.mode === "retire_missing") return { review };
  const currentPlan = args.project?.worker.environment?.executionPlan;
  if (!prior?.plan || !currentPlan || !review.currentPlanHash)
    throw new Error(
      "A retained and a current source-backed execution plan are required.",
    );
  if ((prior.recoveryHistory?.length || 0) >= 100)
    throw new Error(
      "Retained recovery history limit reached; preserve its history for review.",
    );
  const entry = {
    actionId: request.id,
    runId: task.runId || null,
    reviewHash: request.reviewHash,
    decision: request.decision,
    at: now(),
    previousPlan: structuredClone(prior.plan),
    previousPlanHash: executionPlanHash(prior.plan),
    currentPlanHash: review.currentPlanHash,
    differences: review.differences,
  };
  prior.recoveryHistory = [...(prior.recoveryHistory || []), entry];
  prior.plan = structuredClone(currentPlan);
  prior.planHash = review.currentPlanHash;
  await persist({ stateDir: args.stateDir, taskId: task.id }, prior);
  return prior;
}
