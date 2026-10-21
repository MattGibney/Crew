import {
  parseCommandConfiguration,
  parseCommandEvent,
  parseStopControl,
  type StopControl,
} from "./execution/runner-protocol.mjs";
import type { StopEvidence } from "./process-ownership.mjs";
import type { DiagnosticSnapshot } from "./diagnostics.mjs";
import { errorCode } from "./execution/errors.mjs";
// AI-012: persistent owned foreground project script; no controller/window lifetime coupling.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { readFile, writeFile, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { OwnedProcessTree, snapshotProcesses } from "./process-ownership.mjs";
import { waitOwnedNatural } from "./cooperative-process.mjs";
const configPath = process.argv[2],
  config = parseCommandConfiguration(
    JSON.parse(await readFile(configPath, "utf8")),
  ),
  dir = path.dirname(configPath),
  now = () => new Date().toISOString();
async function save(name: string, value: unknown) {
  const file = path.join(dir, name),
    temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await rename(temp, file);
}
let closed = false,
  spawnError: string | null = null,
  commandCode: number | null = null,
  resolveCommand: () => void = () => {},
  stopPromise: Promise<StopEvidence> | null = null,
  stopRequest: StopControl | null = null,
  diagnostics: DiagnosticSnapshot | null = null;
const commandDone = new Promise<void>((r) => {
  resolveCommand = r;
});
const runtimeEnv = { ...process.env };
for (const key of ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL"])
  delete runtimeEnv[key];
const child = spawn(
  process.execPath,
  [
    fileURLToPath(new URL("./environment-command.mjs", import.meta.url)),
    configPath,
  ],
  {
    cwd: config.worktree,
    env: runtimeEnv,
    detached: true,
    stdio: ["pipe", "pipe", "ignore"],
  },
);
const childDone = new Promise<void>((r) => {
  child.once("error", (e) => {
    spawnError = String(errorCode(e) || "spawn failed");
    closed = true;
    resolveCommand();
    r();
  });
  child.once("close", () => {
    closed = true;
    resolveCommand();
    r();
  });
});
child.stdin.on("error", (e) => {
  spawnError = String(errorCode(e) || "control failed");
  resolveCommand();
});
const lines = createInterface({ input: child.stdout });
lines.on("line", (line) => {
  try {
    const e = parseCommandEvent(JSON.parse(line));
    if (e.type === "hook-started")
      void save("command-started.json", {
        id: config.id,
        environmentId: config.environmentId,
        pid: e.pid,
        at: now(),
      });
    if (e.type === "hook-diagnostics") diagnostics = e.diagnostics || null;
    if (e.type === "hook-exit") {
      diagnostics = e.diagnostics || diagnostics;
      commandCode = e.code ?? null;
      spawnError = e.error || null;
      resolveCommand();
    }
  } catch {}
});
const tree = child.pid ? new OwnedProcessTree(child.pid) : null;
await save("started.json", {
  id: config.id,
  environmentId: config.environmentId,
  pid: process.pid,
  identity: (await snapshotProcesses()).get(process.pid) || null,
  workerPid: child.pid || null,
  at: now(),
});
if (tree) await tree.capture();
if (!closed) child.stdin.write("start\n");
let cooperative = false;
async function acceptControl() {
  const control = parseStopControl(
    JSON.parse(await readFile(path.join(dir, "control.json"), "utf8")),
  );
  if (
    control.id !== config.id ||
    control.environmentId !== config.environmentId ||
    control.action !== "stop"
  )
    return;
  stopRequest = control;
  if (control.cooperative === true) {
    if (!cooperative) {
      cooperative = true;
      stopPromise = waitOwnedNatural(tree, {
        onBlocked: (state) =>
          save("cooperative-stop.json", {
            id: config.id,
            environmentId: config.environmentId,
            ...state,
            at: now(),
          }),
        isSuperseded: () => !cooperative,
      });
    }
  } else {
    if (cooperative) {
      cooperative = false;
      stopPromise = null;
    }
    void stop();
  }
}
const stop = () => {
  if (!stopPromise)
    stopPromise = tree
      ? tree.stop({ graceMs: 2500 })
      : Promise.resolve({ confirmed: Boolean(spawnError), remaining: [] });
  return stopPromise;
};
let checking = false;
const timer = setInterval(async () => {
  if (checking) return;
  checking = true;
  try {
    if (tree)
      await save("ownership.json", {
        id: config.id,
        records: await tree.capture(),
        at: now(),
      });
    await acceptControl();
  } catch {
  } finally {
    checking = false;
  }
}, 150);
process.on("SIGTERM", () => {
  stopRequest = { id: config.id, action: "stop", reason: "supervisor signal" };
  if (cooperative) {
    cooperative = false;
    stopPromise = null;
  }
  void stop();
});
await commandDone;
clearInterval(timer);
await acceptControl().catch(() => {});
if (cooperative) {
  await tree?.capture();
  child.stdin.end("release\n");
}
let observedStop = stopPromise;
let ownership = await (observedStop || stop());
if (stopPromise && stopPromise !== observedStop) ownership = await stopPromise;
await childDone;
lines.close();
await save("exit.json", {
  id: config.id,
  environmentId: config.environmentId,
  stopConfirmed: ownership.confirmed,
  remaining: ownership.remaining || [],
  exitCode: commandCode,
  error: spawnError,
  requestedStop: Boolean(stopRequest),
  diagnostics,
  at: now(),
});
