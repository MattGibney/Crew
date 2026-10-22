import {
  parseCommandConfiguration,
  parseCommandEvent,
  parseStopControl,
  type StopControl,
} from "../workers/runner-protocol.mjs";
import type { StopEvidence } from "../processes/ownership.mjs";
import type { DiagnosticSnapshot } from "../http/diagnostics.mjs";
import { errorCode } from "../workers/errors.mjs";
// Stable owned root: wait for ancestry capture before executing a hook; keep the
// root alive after command completion until its supervisor reaps descendants.
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createDiagnosticsRecorder } from "../http/diagnostics.mjs";
const config = parseCommandConfiguration(
  JSON.parse(await readFile(process.argv[2], "utf8")),
);
const keepalive = setInterval(() => {}, 1000);
await new Promise<unknown>((resolve) => process.stdin.once("data", resolve));
const child = spawn(config.command, config.args, {
  cwd: config.worktree,
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"],
});
const diagnostics = createDiagnosticsRecorder();
child.stdout.on("data", (chunk) => diagnostics.push("stdout", chunk));
child.stderr.on("data", (chunk) => diagnostics.push("stderr", chunk));
let previous = "";
const diagnosticTimer = setInterval(() => {
  const value = diagnostics.snapshot();
  if (value.text !== previous) {
    previous = value.text;
    process.stdout.write(
      JSON.stringify({ type: "hook-diagnostics", diagnostics: value }) + "\n",
    );
  }
}, 250);
let sent = false,
  releaseRequested = false;
function release() {
  if (!sent) return;
  clearInterval(keepalive);
  process.stdin.destroy();
}
process.stdin.on("data", (chunk) => {
  if (String(chunk).split(/\r?\n/).includes("release")) {
    releaseRequested = true;
    release();
  }
});
function finished(code: number | null, error: string | null = null) {
  if (sent) return;
  sent = true;
  clearInterval(diagnosticTimer);
  process.stdout.write(
    JSON.stringify({
      type: "hook-exit",
      code,
      error,
      diagnostics: diagnostics.finish(),
    }) + "\n",
  );
  if (releaseRequested) release();
}
child.once("spawn", () =>
  process.stdout.write(
    JSON.stringify({ type: "hook-started", pid: child.pid }) + "\n",
  ),
);
child.once("error", (error) =>
  finished(null, String(errorCode(error) || "spawn failed")),
);
child.once("close", (code) => finished(code));
