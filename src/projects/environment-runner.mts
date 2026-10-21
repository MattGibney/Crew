import {
  parseCommandConfiguration,
  parseCommandEvent,
  parseStopControl,
  type StopControl,
} from "../workers/runner-protocol.mjs";
import type { StopEvidence } from "../processes/ownership.mjs";
import type { DiagnosticSnapshot } from "../http/diagnostics.mjs";
import { errorCode } from "../workers/errors.mjs";
// Durable bounded hook supervisor. Owns only the configured hook and captured descendants.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  OwnedProcessTree,
  snapshotProcesses,
} from "../processes/ownership.mjs";
import { waitOwnedNatural } from "../processes/cooperative.mjs";
const configPath = process.argv[2],
  config = parseCommandConfiguration(
    JSON.parse(await readFile(configPath, "utf8")),
  ),
  runDir = path.dirname(configPath);
const now = () => new Date().toISOString();
async function atomic(name: string, value: unknown) {
  const file = path.join(runDir, name),
    tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await rename(tmp, file);
}
const env: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_OPTIONAL_LOCKS: "0",
  CREW_TASK_ID: config.taskId,
  CREW_WORKTREE: config.worktree,
  CREW_ENV_ID: config.environmentId,
};
for (const key of ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL"])
  delete env[key];
let spawnError: string | null = null,
  closed = false,
  exitCode: number | null = null,
  stopReason: string | null = null,
  stopPromise: Promise<StopEvidence> | null = null,
  tree: OwnedProcessTree | null,
  diagnostics: DiagnosticSnapshot | null = null;
const child = spawn(
  process.execPath,
  [
    fileURLToPath(new URL("./environment-command.mjs", import.meta.url)),
    configPath,
  ],
  {
    cwd: config.worktree,
    env,
    detached: true,
    stdio: ["pipe", "pipe", "ignore"],
  },
);
let commandResolved: () => void = () => {};
const commandDone = new Promise<void>((resolve) => {
  commandResolved = resolve;
});
const closedPromise = new Promise<void>((resolve) => {
  child.once("error", (error) => {
    spawnError = String(errorCode(error) || "spawn failed");
    closed = true;
    commandResolved();
    resolve();
  });
  child.once("close", () => {
    closed = true;
    commandResolved();
    resolve();
  });
});
child.stdin.on("error", (error) => {
  spawnError =
    spawnError || String(errorCode(error) || "control channel failed");
  commandResolved();
});
const lines = createInterface({ input: child.stdout });
lines.on("line", (line) => {
  try {
    const event = parseCommandEvent(JSON.parse(line));
    if (event.type === "hook-diagnostics")
      diagnostics = event.diagnostics || null;
    if (event.type === "hook-exit") {
      diagnostics = event.diagnostics || diagnostics;
      exitCode = event.code ?? null;
      spawnError = event.error || null;
      commandResolved();
    }
  } catch {}
});
tree = child.pid ? new OwnedProcessTree(child.pid) : null;
await atomic("started.json", {
  id: config.id,
  supervisorPid: process.pid,
  supervisorIdentity: (await snapshotProcesses()).get(process.pid) || null,
  workerPid: child.pid || null,
  at: now(),
});
async function capture() {
  if (tree) {
    await tree.capture();
    await atomic("ownership.json", {
      id: config.id,
      records: [...tree.records.values()],
      at: now(),
    });
  }
}
await capture();
if (!closed) child.stdin.write("start\n");
const stop = (reason: string) => {
  stopReason = stopReason || reason;
  if (!stopPromise)
    stopPromise = (async () =>
      tree
        ? await tree.stop({ graceMs: 1500 })
        : { confirmed: true, remaining: [] })();
  return stopPromise;
};
const timeout = setTimeout(() => {
  if (config.cooperative === true) {
    stopReason = "cooperative-timeout";
    void atomic("cooperative-stop.json", {
      id: config.id,
      confirmed: false,
      reason:
        "Declared stop action exceeded its bound. No force signal was sent.",
      at: now(),
    });
  } else void stop("timeout");
}, config.timeoutMs);
const timer = setInterval(async () => {
  try {
    await capture();
    const request = parseStopControl(
      JSON.parse(await readFile(path.join(runDir, "control.json"), "utf8")),
    );
    if (request.id === config.id && request.action === "stop")
      void stop("canceled");
  } catch {}
}, 100);
process.on("SIGTERM", () => void stop("supervisor-stop"));
await commandDone;
clearTimeout(timeout);
clearInterval(timer);
if (config.cooperative === true) {
  await tree?.capture();
  child.stdin.end("release\n");
}
// Reap captured descendants even when the command exits first; foreground hooks cannot
// leave unowned background services behind when their bounded phase has ended.
const result = await (stopPromise ||
  (config.cooperative === true && tree
    ? waitOwnedNatural(tree, {
        onBlocked: (state) =>
          atomic("cooperative-stop.json", {
            id: config.id,
            ...state,
            at: now(),
          }),
      })
    : tree?.stop({ graceMs: 1000 })) ||
  Promise.resolve({ confirmed: true, remaining: [] }));
await closedPromise;
lines.close();
await atomic("exit.json", {
  id: config.id,
  exitCode,
  error: spawnError,
  status:
    exitCode === 0 && !spawnError && !stopReason && result.confirmed
      ? "succeeded"
      : "failed",
  timedOut: stopReason === "timeout",
  canceled: stopReason === "canceled",
  stopReason,
  confirmed: result.confirmed,
  remaining: result.remaining || [],
  diagnostics,
  at: now(),
});
