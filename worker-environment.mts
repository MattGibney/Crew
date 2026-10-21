import type {
  EnvironmentEvidence,
  EnvironmentHook,
  HookEvidence,
} from "./execution/contracts.mjs";
import type { ProjectToolchain } from "./project-toolchain.mjs";
import { errorCode, errorMessage, isRecord } from "./execution/errors.mjs";
import {
  readEnvironmentEvidence,
  readCommandExit,
} from "./execution/evidence.mjs";
interface ReconcileOptions {
  stateDir: string;
  taskId: string;
  stop?: boolean;
}
interface HookOptions extends ReconcileOptions {
  worktree: string;
  hooks?: Record<string, EnvironmentHook | undefined>;
  phases: string[];
  existing?: EnvironmentEvidence | null;
  toolchain?: ProjectToolchain | null;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  pauseBoundary?: (() => Promise<unknown>) | null;
  cooperative?: boolean;
  onEvidence?: (environment: EnvironmentEvidence) => Promise<unknown>;
}
// AI-011: durable, bounded shell-free lifecycle hooks, scoped to one worktree.
import { spawn } from "node:child_process";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
const now = () => new Date().toISOString(),
  sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function json(file: string): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = JSON.parse(await readFile(file, "utf8"));
    return isRecord(value) ? value : null;
  } catch (e) {
    if (errorCode(e) === "ENOENT") return null;
    throw e;
  }
}
async function save(file: string, value: unknown) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await rename(tmp, file);
}
export function environmentFile(stateDir: string, taskId: string) {
  return path.join(stateDir, "runs", taskId, "environment.json");
}
export async function reconcileEnvironment({
  stateDir,
  taskId,
  stop = false,
}: ReconcileOptions) {
  const file = environmentFile(stateDir, taskId),
    environment = await readEnvironmentEvidence(file);
  if (!environment) return null;
  let pending = false;
  for (const hook of environment.hooks || []) {
    if (hook.status !== "running") continue;
    const expected = path.join(
      stateDir,
      "runs",
      taskId,
      "environment",
      hook.id,
    );
    if (hook.runDir !== expected)
      throw new Error("Environment ownership is invalid; nothing was removed.");
    if (stop)
      await save(path.join(expected, "control.json"), {
        id: hook.id,
        action: "stop",
        at: now(),
      });
    const exit = await readCommandExit(path.join(expected, "exit.json"));
    if (exit?.id === hook.id && exit.confirmed) {
      Object.assign(hook, {
        status: exit.status,
        exitCode: exit.exitCode,
        timedOut: exit.timedOut,
        canceled: exit.canceled,
        endedAt: exit.at,
        diagnostics: exit.diagnostics || null,
      });
      if (exit.status !== "succeeded") environment.status = "failed";
    } else pending = true;
  }
  if (pending) {
    environment.pending = true;
    await save(file, environment);
    return environment;
  }
  environment.pending = false;
  await save(file, environment);
  return environment;
}
export async function runEnvironmentHooks({
  stateDir,
  taskId,
  worktree,
  hooks = {},
  phases,
  existing = null,
  toolchain = null,
  env = process.env,
  signal,
  pauseBoundary,
  cooperative = false,
  onEvidence = async () => {},
}: HookOptions) {
  const file = environmentFile(stateDir, taskId),
    prior = await reconcileEnvironment({ stateDir, taskId });
  if (prior?.pending)
    throw new Error(
      "An earlier environment command has not confirmed it stopped. Wait for its bounded supervisor, then retry. No environment was removed or restarted.",
    );
  const environment: EnvironmentEvidence = prior ||
    existing || {
      id: `crew-${taskId}-${randomUUID().slice(0, 8)}`,
      taskId,
      worktree,
      createdAt: now(),
      status: "not-configured",
      hooks: [],
    };
  if (toolchain) environment.toolchain = toolchain;
  if (environment.taskId !== taskId || environment.worktree !== worktree)
    throw new Error("Environment ownership does not match this worker.");
  for (const phase of phases) {
    await pauseBoundary?.();
    const hook = hooks[phase];
    if (!hook) continue;
    if (signal?.aborted)
      throw new Error("Worker environment preparation canceled.");
    if (
      typeof hook.command !== "string" ||
      !hook.command ||
      hook.command.includes("\0") ||
      !Array.isArray(hook.args) ||
      hook.args.some((a) => typeof a !== "string" || a.includes("\0")) ||
      !Number.isInteger(hook.timeoutMs) ||
      hook.timeoutMs < 1000 ||
      hook.timeoutMs > 600000
    )
      throw new Error(`Invalid ${phase} environment hook.`);
    const id = randomUUID(),
      runDir = path.join(stateDir, "runs", taskId, "environment", id);
    await mkdir(runDir, { recursive: true, mode: 0o700 });
    const evidence: HookEvidence = {
      id,
      phase,
      runDir,
      status: "running",
      startedAt: now(),
      command: hook.command,
      args: hook.args,
      timeoutMs: hook.timeoutMs,
    };
    environment.status = phase === "cleanup" ? "cleaning" : "preparing";
    environment.hooks.push(evidence);
    await save(file, environment);
    await onEvidence(environment);
    const config = {
      ...hook,
      id,
      taskId,
      worktree,
      environmentId: environment.id,
      cooperative: cooperative === true,
    };
    await save(path.join(runDir, "config.json"), config);
    let spawnError: string | null = null,
      closed = false;
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("./environment-runner.mjs", import.meta.url)),
        path.join(runDir, "config.json"),
      ],
      { detached: true, stdio: "ignore", env },
    );
    child.once("error", (error) => {
      spawnError = String(errorCode(error) || "spawn failed");
      closed = true;
    });
    child.once("exit", () => {
      closed = true;
    });
    child.unref();
    evidence.supervisorPid = child.pid || null;
    const abort = () => {
      void save(path.join(runDir, "control.json"), {
        id,
        action: "stop",
        at: now(),
      }).catch(() => {});
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try {
      await save(file, environment);
      await onEvidence(environment);
      let exit;
      for (;;) {
        if (cooperative) {
          const blocked = await json(
            path.join(runDir, "cooperative-stop.json"),
          );
          if (blocked?.id === id && blocked.confirmed === false)
            throw new Error(
              "Declared stop action remains unconfirmed. No force signal was sent; its owned supervisor remains available for recovery.",
            );
        }
        exit = await readCommandExit(path.join(runDir, "exit.json"));
        if (exit?.id === id) break;
        if (spawnError)
          throw new Error(
            `Could not start ${phase} supervisor (${spawnError}).`,
          );
        if (closed)
          throw new Error(
            `${phase} supervisor exited without a stop confirmation. Preserve this environment and inspect its state.`,
          );
        await sleep(75);
      }
      if (!exit.confirmed)
        throw new Error(
          `${phase} command descendants have not confirmed they stopped. Preserve this environment and inspect its state.`,
        );
      Object.assign(evidence, {
        status: exit.status,
        exitCode: exit.exitCode,
        timedOut: exit.timedOut,
        canceled: exit.canceled,
        endedAt: exit.at,
        diagnostics: exit.diagnostics || null,
      });
      if (exit.status !== "succeeded")
        throw new Error(
          `${phase} environment hook ${exit.timedOut ? "timed out" : exit.canceled ? "was canceled" : `failed (exit ${exit.exitCode}${exit.error ? `, ${exit.error}` : ""})`}. Check the configured command before retrying.`,
        );
    } catch (error) {
      environment.status = "failed";
      if (evidence.status !== "running") evidence.status = "failed";
      evidence.error = errorMessage(error);
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
      await save(file, environment);
      await onEvidence(environment);
    }
  }
  environment.status = phases.includes("cleanup")
    ? "disposed"
    : hooks.ready
      ? "ready"
      : Object.keys(hooks).length
        ? "configured"
        : "not-configured";
  environment.updatedAt = now();
  await save(file, environment);
  await onEvidence(environment);
  return environment;
}
