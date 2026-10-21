// AI-017: read-only update safety observations. Never reconcile or signal runners.
import path from "node:path";
import { snapshotProcesses } from "./process-ownership.mjs";

import type { ProcessSnapshot } from "./process-ownership.mjs";
import type {
  ActivityView,
  TaskActivity,
  ProcessVerdict,
  HookVerdict,
} from "./shared/update.mjs";
import {
  createEvidenceReader,
  evidenceObject,
  evidenceList,
} from "./backend/evidence-reader.mjs";
import {
  processVerdict as verdict,
  processLive as live,
} from "./backend/evidence-processes.mjs";
const taskId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{8,80}$/.test(value);
const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
function sameDirectory(saved: unknown, expected: string): boolean {
  return (
    saved === undefined ||
    saved === null ||
    (typeof saved === "string" && path.resolve(saved) === expected)
  );
}

export async function inspectUpdateEvidence({
  stateDir,
  view,
  processes,
}: {
  stateDir: string;
  view: ActivityView;
  processes?:
    ProcessSnapshot | (() => ProcessSnapshot | Promise<ProcessSnapshot>);
}): Promise<ActivityView> {
  const cloned = structuredClone(view);
  if (!cloned || !Array.isArray(cloned.tasks)) return cloned;
  let rows: ProcessSnapshot | null;
  let json: Awaited<ReturnType<typeof createEvidenceReader>>;
  try {
    json = await createEvidenceReader(stateDir);
    rows =
      processes === undefined
        ? await snapshotProcesses()
        : typeof processes === "function"
          ? await processes()
          : processes;
  } catch {
    rows = null;
    json = async () => {
      throw new Error("Evidence unavailable");
    };
  }
  async function workerRun(
    task: TaskActivity,
    runId: string | null | undefined,
    current: boolean,
  ): Promise<ProcessVerdict> {
    if (!(rows instanceof Map)) return "unknown";
    const unstarted = current && !task.harnessStarted && !task.spawnIntentAt;
    if (!uuid(runId))
      return unstarted && !task.runDir && task.execution?.live !== true
        ? "absent"
        : "unknown";
    const expected = path.resolve(stateDir, "runs", task.id, runId);
    if (current && !sameDirectory(task.runDir, expected)) return "unknown";
    const location = ["runs", task.id, runId];
    const [owner, started, ownership, exit] = await Promise.all(
      ["owner.json", "started.json", "ownership.json", "exit.json"].map(
        (name) => json(...location, name),
      ),
    );
    if (
      [owner, started, ownership, exit].some(
        (item) => item && item.runId !== runId,
      )
    )
      return "unknown";
    if (
      unstarted &&
      !owner &&
      !started &&
      !ownership &&
      !exit &&
      task.execution?.live !== true
    )
      return "absent";
    const records = [
      ...evidenceList(ownership?.records),
      ...evidenceList(evidenceObject(exit?.ownership).tracked),
    ];
    const exitOwnership = evidenceObject(exit?.ownership);
    const closed = exit?.connectionClosed === true;
    // Connection closure leaves agent-started services alone. Re-observe their
    // captured identities; a historical remaining list is not permanent liveness.
    if (closed) records.push(...evidenceList(exitOwnership.remaining));
    if (owner?.supervisorIdentity) records.push(owner.supervisorIdentity);
    else if (started?.identity) records.push(started.identity);
    // Legacy started.json has only a PID: a live process with no captured
    // identity is uncertain, never grounds for claiming it stopped.
    const pid =
      owner?.supervisorPid || started?.pid || (current ? task.runnerPid : null);
    const uncaptured =
      typeof pid === "number" &&
      Number.isSafeInteger(pid) &&
      live(rows.get(pid)) &&
      !records.some((record) => evidenceObject(record).pid === pid);
    return verdict({
      records,
      terminal: closed || exit?.stopConfirmed === true,
      processes: rows,
      contradictory:
        uncaptured ||
        (closed &&
          exit?.stopConfirmed !== true &&
          !(
            evidenceList(ownership?.records).length +
            evidenceList(exitOwnership.tracked).length +
            evidenceList(exitOwnership.remaining).length
          )) ||
        (!closed && Boolean(evidenceList(exitOwnership.remaining).length)),
    });
  }
  async function worker(task: TaskActivity): Promise<ProcessVerdict> {
    if (!(rows instanceof Map)) return "unknown";
    let current: ProcessVerdict;
    try {
      current = await workerRun(task, task.runId, true);
    } catch {
      current = "unknown";
    }
    if (task.retainedResourceRuns === undefined) return current;
    if (
      !Array.isArray(task.retainedResourceRuns) ||
      task.retainedResourceRuns.length > 256
    )
      return current === "live" ? "live" : "unknown";
    const states: ProcessVerdict[] = [current],
      seen = new Set([task.runId]);
    for (const raw of task.retainedResourceRuns) {
      let retained: Record<string, unknown>;
      try {
        retained = evidenceObject(raw);
      } catch {
        states.push("unknown");
        continue;
      }
      if (!uuid(retained.runId)) {
        states.push("unknown");
        continue;
      }
      if (seen.has(retained.runId)) continue;
      seen.add(retained.runId);
      try {
        states.push(await workerRun(task, retained.runId, false));
      } catch {
        states.push("unknown");
      }
    }
    if (states.includes("live")) return "live";
    if (states.includes("unknown")) return "unknown";
    return states.includes("stopped") ? "stopped" : "absent";
  }
  async function environment(
    task: TaskActivity,
  ): Promise<{ hooks: HookVerdict[]; runtime: ProcessVerdict }> {
    const disk = await json("runs", task.id, "environment.json");
    if (!disk && !task.environment) return { hooks: [], runtime: "absent" };
    if (
      !disk ||
      !task.environment ||
      disk.taskId !== task.id ||
      disk.id !== task.environment.id ||
      disk.kind !== task.environment.kind ||
      typeof disk.worktree !== "string" ||
      !path.isAbsolute(disk.worktree) ||
      disk.worktree !== task.worktree ||
      disk.worktree !== task.environment.worktree
    )
      throw new Error("Environment identity mismatch");
    const project = disk.kind === "project-execution";
    const generatedId = /^crew-[a-f0-9]{32}$/.test(
      typeof disk.id === "string" ? disk.id : "",
    );
    const legacyHookId =
      typeof disk.id === "string" &&
      disk.id.startsWith(`crew-${task.id}-`) &&
      /^[a-f0-9]{8}$/.test(disk.id.slice(`crew-${task.id}-`.length));
    // Project plans and controller-created toolchain hook environments use a
    // compact UUID; legacy hook producers embed the exact owning task ID.
    if (
      project
        ? !generatedId
        : disk.kind !== undefined || !(generatedId || legacyHookId)
    )
      throw new Error("Environment identity mismatch");
    if (!Array.isArray(disk.hooks) || disk.hooks.length > 128)
      throw new Error("Environment evidence exceeds limits");
    const hooks: HookVerdict[] = [];
    for (const rawHook of disk.hooks) {
      const hook = evidenceObject(rawHook);
      const entry: HookVerdict = {
        id: typeof hook.id === "string" ? hook.id : null,
        phase: typeof hook.phase === "string" ? hook.phase : null,
        state: "unknown",
      };
      hooks.push(entry);
      if (
        !uuid(hook?.id) ||
        typeof hook.phase !== "string" ||
        hook.phase.length > 80
      )
        continue;
      const expected = path.resolve(
        stateDir,
        "runs",
        task.id,
        "environment",
        hook.id,
      );
      if (!sameDirectory(hook.runDir, expected)) continue;
      const location = ["runs", task.id, "environment", hook.id];
      try {
        const [started, ownership, exit] = await Promise.all(
          ["started.json", "ownership.json", "exit.json"].map((name) =>
            json(...location, name),
          ),
        );
        if (
          [started, ownership, exit].some((item) => item && item.id !== hook.id)
        )
          continue;
        const records = [...evidenceList(ownership?.records)];
        if (started?.supervisorIdentity)
          records.push(started.supervisorIdentity);
        const pid = started?.supervisorPid || hook.supervisorPid;
        const uncaptured =
          typeof pid === "number" &&
          Number.isSafeInteger(pid) &&
          live(rows?.get(pid)) &&
          !records.some((record) => evidenceObject(record).pid === pid);
        entry.state = verdict({
          records,
          terminal: exit?.confirmed === true,
          processes: rows,
          contradictory:
            uncaptured || Boolean(evidenceList(exit?.remaining).length),
        });
        if (!started && !ownership && !exit && hook.status === "pending")
          entry.state = "pending";
      } catch {
        /* This hook remains unknown; inspect independent hooks too. */
      }
    }
    if (!disk.runtime) return { hooks, runtime: "absent" };
    const runtime = evidenceObject(disk.runtime);
    if (
      !project ||
      !uuid(runtime.id) ||
      !sameDirectory(
        runtime.runDir,
        path.resolve(stateDir, "runs", task.id, "project-runtime", runtime.id),
      )
    )
      return { hooks, runtime: "unknown" };
    const location = ["runs", task.id, "project-runtime", runtime.id];
    const [started, ownership, exit] = await Promise.all(
      ["started.json", "ownership.json", "exit.json"].map((name) =>
        json(...location, name),
      ),
    );
    if (
      [started, ownership, exit].some(
        (item) => item && item.id !== runtime.id,
      ) ||
      [started, exit].some((item) => item && item.environmentId !== disk.id)
    )
      return { hooks, runtime: "unknown" };
    const records = [...evidenceList(ownership?.records)];
    if (started?.identity) records.push(started.identity);
    const uncaptured =
      typeof started?.pid === "number" &&
      Number.isSafeInteger(started.pid) &&
      live(rows?.get(started.pid)) &&
      !records.some((record) => evidenceObject(record).pid === started?.pid);
    return {
      hooks,
      runtime: verdict({
        records,
        terminal: exit?.stopConfirmed === true,
        processes: rows,
        contradictory:
          uncaptured || Boolean(evidenceList(exit?.remaining).length),
      }),
    };
  }
  for (const [index, task] of cloned.tasks.entries()) {
    task.updateEvidence = { worker: "unknown", hooks: [], runtime: "unknown" };
    if (index >= 256 || !taskId(task.id)) continue;
    try {
      task.updateEvidence.worker = await worker(task);
    } catch {
      /* Fail closed. */
    }
    try {
      Object.assign(task.updateEvidence, await environment(task));
    } catch {
      /* Fail closed. */
    }
  }
  return cloned;
}
