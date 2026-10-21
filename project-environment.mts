import type {
  ExecutionPlan,
  ExecutionPhase,
  ScriptAction,
  EnvironmentEvidence,
  ProjectEnvironmentEvidence,
} from "./execution/contracts.mjs";
import type {
  EnvironmentContext,
  PrepareContext,
} from "./execution/project-context.mjs";
import {
  assertOwned,
  persist,
  runtimeState,
  executionPlanHash,
  save,
} from "./execution/project-state.mjs";
import { readEnvironmentEvidence as json } from "./execution/evidence.mjs";
import {
  verifyProjectWorktree,
  assertPlan,
  verifySources,
  verifyPermissionsSource,
} from "./execution/project-integrity.mjs";
import { applyLifecyclePlan } from "./execution/project-plan.mjs";
export { verifyProjectWorktree } from "./execution/project-integrity.mjs";
export { executionPlanHash } from "./execution/project-state.mjs";
export {
  reviewProjectRecovery,
  applyProjectRecovery,
} from "./execution/project-recovery.mjs";
import { errorCode, errorMessage } from "./execution/errors.mjs";
// AI-012: execute a project's declared scripts. No project-specific protocol or inferred endpoints.
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  readFile,
  writeFile,
  rename,
  mkdir,
  realpath,
  lstat,
} from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  runEnvironmentHooks,
  environmentFile,
  reconcileEnvironment,
} from "./worker-environment.mjs";
import {
  resolveProjectToolchain,
  applyProjectToolchain,
} from "./project-toolchain.mjs";
import { snapshotProcesses } from "./process-ownership.mjs";
import { selectWorktreeRoot } from "./worktree-paths.mjs";
const exec = promisify(execFile),
  sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)),
  now = () => new Date().toISOString();
// Settings edits are applied only when the controller enters a lifecycle action.
// The original plan and each replaced revision remain durable audit evidence.
function scriptArgs(plan: ExecutionPlan, action: ScriptAction) {
  return ["-lc", action.command];
}
async function bounded(
  args: EnvironmentContext,
  environment: ProjectEnvironmentEvidence,
  phase: ExecutionPhase,
  action: ScriptAction | null | undefined,
  signal = args.signal,
) {
  if (!action) return;
  await runEnvironmentHooks({
    stateDir: args.stateDir,
    taskId: args.taskId,
    worktree: environment.worktree,
    hooks: {
      [phase]: {
        command: "/bin/zsh",
        args: scriptArgs(environment.plan, action),
        timeoutMs: action.timeoutMs,
        planHash: environment.planHash,
        source: action.source || null,
        configurationSource:
          environment.originalPlan &&
          executionPlanHash(environment.originalPlan[phase] ?? null) !==
            executionPlanHash(action)
            ? "crew-settings"
            : "crew-config",
      },
    },
    phases: [phase],
    existing: environment,
    env: applyProjectToolchain(environment.toolchain),
    signal,
    pauseBoundary: args.pauseBoundary,
    cooperative: args.cooperative === true,
    onEvidence: async (value) => {
      Object.assign(environment, value);
      await args.onEvidence?.(value);
    },
  });
}
async function startRuntime(
  args: EnvironmentContext,
  environment: ProjectEnvironmentEvidence,
) {
  const state = await runtimeState(environment);
  if (state.kind === "live") return;
  if (state.kind === "unknown")
    throw new Error(
      "Previous project runtime shutdown/ownership is unresolved. Preserve it for recovery.",
    );
  if (args.signal?.aborted) throw new Error("Project startup canceled.");
  const restarting = Boolean(environment.runtime),
    action = restarting
      ? environment.plan.resume || environment.plan.start
      : environment.plan.start;
  if (!action) throw new Error("Project Start action is unavailable.");
  if (environment.runtime)
    environment.runtimeHistory = [
      ...(environment.runtimeHistory || []),
      structuredClone(environment.runtime),
    ];
  const id = randomUUID(),
    dir = path.join(args.stateDir, "runs", args.taskId, "project-runtime", id);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  environment.runtime = {
    id,
    runDir: dir,
    status: "starting",
    createdAt: now(),
    planHash: environment.planHash,
    action: structuredClone(action),
    configurationSource:
      environment.originalPlan &&
      executionPlanHash(
        environment.originalPlan[
          restarting && environment.plan.resume ? "resume" : "start"
        ] ?? null,
      ) !== executionPlanHash(action)
        ? "crew-settings"
        : "crew-config",
  };
  environment.servicesStarted = true;
  await persist(args, environment);
  await save(path.join(dir, "config.json"), {
    id,
    environmentId: environment.id,
    worktree: environment.worktree,
    command: "/bin/zsh",
    args: scriptArgs(environment.plan, action),
    planHash: environment.planHash,
    source: action.source || null,
    configurationSource: environment.runtime.configurationSource,
  });
  let error: string | null = null;
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL("./project-runtime-runner.mjs", import.meta.url)),
      path.join(dir, "config.json"),
    ],
    {
      detached: true,
      stdio: "ignore",
      env: applyProjectToolchain(environment.toolchain),
    },
  );
  child.once("error", (e) => {
    error = String(errorCode(e) || "spawn failed");
  });
  child.unref();
  for (let i = 0; i < 100; i++) {
    const current = await runtimeState(environment);
    if (current.kind === "live") {
      await sleep(300);
      if ((await runtimeState(environment)).kind !== "live")
        throw new Error(
          "Project Start action must remain in the foreground; it exited during startup.",
        );
      environment.runtime.status = "running";
      await persist(args, environment);
      return;
    }
    if (current.kind === "stopped" || error)
      throw new Error(
        "Project Start action exited before runtime ownership was established.",
      );
    await sleep(100);
  }
  throw new Error(
    "Project runtime ownership was not established. Preserve this environment.",
  );
}
export async function inspectProjectEnvironment(args: EnvironmentContext) {
  const environment = await json(environmentFile(args.stateDir, args.taskId));
  if (environment?.kind !== "project-execution") return environment;
  assertOwned(args, environment);
  if (!environment.runtime) return environment;
  const current = await runtimeState(environment, args.processes),
    status =
      current.kind === "live"
        ? "running"
        : current.kind === "stopped"
          ? "stopped"
          : Date.now() - Date.parse(environment.runtime.createdAt) < 15000
            ? "starting"
            : "unknown";
  if (environment.runtime.status !== status) {
    environment.runtime.status = status;
    if (
      ["ready", "running"].includes(environment.status || "") &&
      status !== "running"
    ) {
      environment.status = "failed";
      environment.detail =
        "Owned foreground project action stopped or lost ownership confirmation. Worktree and data were retained.";
    }
    await persist(args, environment);
  }
  return environment;
}
export async function prepareProjectEnvironment(args: PrepareContext) {
  args = { ...args, plan: structuredClone(args.plan) };
  const worktree = await verifyProjectWorktree(args);
  assertPlan(args.plan);
  await verifyPermissionsSource(args.repositoryPath, args.plan);
  const prior = await reconcileEnvironment({
    stateDir: args.stateDir,
    taskId: args.taskId,
  });
  if (prior?.pending)
    throw new Error("A previous project command has not confirmed it stopped.");
  const environment = prior || {
    id: `crew-${randomUUID().replace(/-/g, "")}`,
    kind: "project-execution",
    taskId: args.taskId,
    worktree,
    repositoryPath: await realpath(args.repositoryPath),
    baseCommit: args.baseCommit,
    plan: structuredClone(args.plan),
    planHash: executionPlanHash(args.plan),
    hooks: [],
    status: "preparing",
    createdAt: now(),
  };
  assertOwned(args, environment);
  if (environment.worktree !== worktree)
    throw new Error(
      "Retained worktree identity changed; existing data was retained.",
    );
  if (environment.repositoryPath !== (await realpath(args.repositoryPath)))
    throw new Error(
      "Retained repository identity changed; existing data was retained.",
    );
  if (environment.baseCommit !== args.baseCommit)
    throw new Error(
      "Retained baseline commit changed; existing data was retained.",
    );
  await applyLifecyclePlan(args, environment, [
    ...(!environment.prepared ? (["setup"] as const) : []),
    environment.runtime && args.plan.resume ? "resume" : "start",
    "ready",
  ]);
  // Preserve effective pinned environment while adopting configured lifecycle commands.
  args.plan = structuredClone(environment.plan);
  environment.planHash = executionPlanHash(environment.plan);
  await persist(args, environment);
  await args.pauseBoundary?.();
  const setupRetry =
    Boolean(args.setupRetry?.requestId) &&
    !environment.setupRetryHistory?.some(
      (entry) => entry.requestId === args.setupRetry?.requestId,
    );
  if (setupRetry && !environment.plan.setup)
    throw new Error(
      "Retry failed setup requires a configured Setup command; retained partial data was preserved.",
    );
  if (
    !environment.prepared &&
    environment.setupAttempted &&
    !environment.hooks.some(
      (h) => h.phase === "setup" && h.status === "succeeded",
    ) &&
    !setupRetry
  )
    throw new Error(
      "Earlier setup did not complete. Its retained data will not be reseeded; review it before starting a fresh worker.",
    );
  // Resolve before provisioning; resume checks the exact retained version, never upgrades it.
  try {
    environment.toolchain = await resolveProjectToolchain({
      worktree,
      baseCommit: args.baseCommit,
      plan: environment.plan,
      retained: environment.toolchain,
      cacheRoot: args.toolchainCacheRoot,
      env: args.env,
    });
  } catch (error) {
    environment.status = "failed";
    environment.detail = `Toolchain preparation failed: ${errorMessage(error)}`;
    await persist(args, environment);
    throw error;
  }
  await persist(args, environment);
  await args.pauseBoundary?.();
  if (!environment.prepared) {
    const completed = environment.hooks.some(
      (h) => h.phase === "setup" && h.status === "succeeded",
    );
    if (environment.setupAttempted && !completed && !setupRetry)
      throw new Error(
        "Earlier setup did not complete. Its retained data will not be reseeded; review it before starting a fresh worker.",
      );
    if (!completed && environment.plan.setup) {
      if (setupRetry)
        environment.setupRetryHistory = [
          ...(environment.setupRetryHistory || []),
          {
            requestId: args.setupRetry?.requestId || "",
            ...args.setupRetry,
            at: now(),
            planHash: environment.planHash,
          },
        ];
      environment.setupAttempted = true;
      await persist(args, environment);
      await bounded(args, environment, "setup", environment.plan.setup);
    }
    environment.prepared = true;
    await persist(args, environment);
  }
  await args.pauseBoundary?.();
  if (environment.plan.start) await startRuntime(args, environment);
  if (args.signal?.aborted) {
    await stopProjectEnvironment(args);
    throw new Error("Project startup canceled.");
  }
  await args.pauseBoundary?.();
  if (environment.plan.ready) {
    await bounded(args, environment, "ready", environment.plan.ready);
    if (
      environment.plan.start &&
      (await runtimeState(environment)).kind !== "live"
    )
      throw new Error(
        "Project Start action stopped before its declared readiness check completed.",
      );
    environment.readinessKind = "app-verified";
    environment.status = "ready";
  } else {
    environment.readinessKind = "setup-complete";
    environment.status = environment.plan.start ? "running" : "ready";
  }
  environment.readyAt = now();
  return persist(args, environment);
}
export async function stopProjectEnvironment(args: EnvironmentContext) {
  args = { ...args, plan: args.plan ? structuredClone(args.plan) : null };
  const environment = await json(environmentFile(args.stateDir, args.taskId));
  if (environment?.kind !== "project-execution") return environment;
  assertOwned(args, environment);
  const cooperative = args.cooperative === true;
  const pending = await reconcileEnvironment({
    stateDir: args.stateDir,
    taskId: args.taskId,
    stop: !cooperative,
  });
  if (pending?.pending)
    throw new Error(
      "Project setup/check command is still finishing; no stop completion was claimed.",
    );
  Object.assign(environment, pending || {});
  await applyLifecyclePlan(args, environment, ["stop"]);
  const state = await runtimeState(environment);
  if (state.kind === "unknown")
    throw new Error(
      "Project runtime ownership is unresolved; no stop completion was claimed.",
    );
  if (cooperative) {
    if (["live", "starting"].includes(state.kind) && !environment.plan.stop)
      throw new Error(
        "This project has no declared graceful stop action. No force signal was sent; resolve its runtime before updating.",
      );
    if (environment.runtime)
      await save(path.join(environment.runtime.runDir, "control.json"), {
        id: environment.runtime.id,
        environmentId: environment.id,
        action: "stop",
        cooperative: true,
        at: now(),
      });
    if (environment.status !== "stopped" && environment.plan.stop) {
      await verifySources(
        environment.worktree,
        environment.baseCommit,
        environment.plan,
        ["stop"],
      );
      await bounded(
        { ...args, pauseBoundary: null, cooperative: true },
        environment,
        "stop",
        environment.plan.stop,
        undefined,
      );
    }
    if (environment.runtime) {
      const until = Date.now() + 15000;
      for (;;) {
        if ((await runtimeState(environment)).kind === "stopped") break;
        if (Date.now() > until)
          throw new Error(
            "Graceful project shutdown remains unconfirmed. No force signal was sent.",
          );
        await sleep(100);
      }
    }
  } else {
    if (["live", "starting"].includes(state.kind) && environment.runtime) {
      await save(path.join(environment.runtime.runDir, "control.json"), {
        id: environment.runtime.id,
        environmentId: environment.id,
        action: "stop",
        at: now(),
      });
      const until = Date.now() + 15000;
      for (;;) {
        if ((await runtimeState(environment)).kind === "stopped") break;
        if (Date.now() > until)
          throw new Error(
            "Project foreground shutdown has not been confirmed.",
          );
        await sleep(100);
      }
    }
    if (environment.status !== "stopped" && environment.plan.stop) {
      await verifySources(
        environment.worktree,
        environment.baseCommit,
        environment.plan,
        ["stop"],
      );
      await bounded(
        args,
        environment,
        "stop",
        environment.plan.stop,
        undefined,
      );
    }
  }
  environment.status = "stopped";
  if (environment.runtime) environment.runtime.status = "stopped";
  return persist(args, environment);
}
export async function disposeProjectEnvironment(args: EnvironmentContext) {
  args = { ...args, plan: args.plan ? structuredClone(args.plan) : null };
  const environment = await json(environmentFile(args.stateDir, args.taskId));
  if (environment?.kind !== "project-execution") return environment;
  assertOwned(args, environment);
  const pending = await reconcileEnvironment({
    stateDir: args.stateDir,
    taskId: args.taskId,
  });
  if (pending?.pending)
    throw new Error("A project command has no stop confirmation.");
  if (!["absent", "stopped"].includes((await runtimeState(environment)).kind))
    throw new Error(
      "Stop the owned foreground project action before teardown.",
    );
  await applyLifecyclePlan(args, environment, ["teardown"]);
  if (
    (environment.servicesStarted || environment.setupAttempted) &&
    !environment.plan.teardown
  )
    throw new Error(
      "This project has no declared teardown action. Ask the manager how to preserve or remove its resources; nothing was removed.",
    );
  await verifyProjectWorktree({ ...args, ...environment });
  if (environment.plan.teardown)
    await verifySources(
      environment.worktree,
      environment.baseCommit,
      environment.plan,
      ["teardown"],
    );
  if (environment.plan.teardown)
    await bounded(
      args,
      environment,
      "teardown",
      environment.plan.teardown,
      undefined,
    );
  environment.status = "disposed";
  return persist(args, environment);
}
