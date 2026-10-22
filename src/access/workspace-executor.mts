import { spawn } from "node:child_process";
import { mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { homedir } from "node:os";
import { nativeSeatbeltPolicy } from "./native-boundary.mjs";
import { WorkspaceProcessRecorder } from "./workspace-process-evidence.mjs";
export { reconcileMacWorkspaceCommand } from "./workspace-process-evidence.mjs";
export type { WorkspaceProcessSettlement } from "./workspace-process-evidence.mjs";

/** Supplied only by the trusted #88 environment authority after current group and
 * resource admission. No roots, executable paths or network policy from model JSON. */
export interface WorkspaceExecutionPolicy {
  workspaceDirectory: string;
  privateDirectory: string;
  writable: boolean;
  /** Exact host-approved tool installations and Git metadata when needed. Never
   * personal configuration roots, broker storage, native auth or credential files. */
  readableRoots: string[];
  writableRoots: string[];
  executableDirectories: string[];
}
export interface WorkspaceCommandResult {
  state: "exited" | "timed_out" | "not_started";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  /** Timeout/output-limit termination cannot prove that side effects did not occur. */
  mayHaveExecuted: boolean;
  /** Fresh absence of the launched group and observed descendants. Root exit alone
   * does not establish this; arbitrary unobserved daemonization is outside scope. */
  processesSettled: boolean;
  /** Opaque controller-private receipt for a later read-only process check. */
  processEvidenceRef: string | null;
}
const inside = (root: string, candidate: string) => {
  const value = relative(root, candidate);
  return value === "" || (!value.startsWith("..") && !isAbsolute(value));
};

/** Real project inspection/edit/test execution, separated from the native model
 * process and vault. Native subscription/config directories are never mounted.
 * Networking is denied in this first executor; provider work uses gateway tools.
 * The host owns invocation identity, permission checks, admission and receipts. */
export async function runMacWorkspaceCommand(
  policy: WorkspaceExecutionPolicy,
  input: {
    command: string;
    relativeCwd?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  },
): Promise<WorkspaceCommandResult> {
  if (process.platform !== "darwin")
    throw new Error("The current workspace executor requires macOS.");
  if (
    !input.command ||
    Buffer.byteLength(input.command) > 64 * 1024 ||
    input.command.includes("\0")
  )
    throw new Error("Invalid workspace command.");
  const timeout = input.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 120_000)
    throw new Error(
      "Command timeout must be between 100 and 120000 milliseconds.",
    );
  const roots = [
    policy.workspaceDirectory,
    policy.privateDirectory,
    ...policy.readableRoots,
    ...policy.writableRoots,
    ...policy.executableDirectories,
  ];
  if (roots.some((root) => !isAbsolute(root)))
    throw new Error("Trusted absolute workspace roots required.");
  const canonical = await Promise.all(roots.map((root) => realpath(root)));
  if (
    canonical.some(
      (root, index) =>
        root !== roots[index] ||
        root === "/" ||
        root === homedir() ||
        root === dirname(homedir()) ||
        root === join(homedir(), ".codex") ||
        root === join(homedir(), ".ssh") ||
        root === join(homedir(), "Library"),
    )
  )
    throw new Error("Broad or noncanonical workspace roots are not allowed.");
  if (
    [
      policy.workspaceDirectory,
      ...policy.readableRoots,
      ...policy.writableRoots,
      ...policy.executableDirectories,
    ].some(
      (root) =>
        inside(root, policy.privateDirectory) ||
        inside(policy.privateDirectory, root),
    )
  )
    throw new Error(
      "Command roots must not overlap the private controller directory.",
    );
  const cwd = await realpath(
    join(policy.workspaceDirectory, input.relativeCwd ?? "."),
  );
  if (!inside(policy.workspaceDirectory, cwd))
    throw new Error(
      "Command working directory escapes its assigned workspace.",
    );
  if (input.signal?.aborted)
    return {
      state: "not_started",
      exitCode: null,
      stdout: "",
      stderr: "Command cancelled before launch.",
      truncated: false,
      mayHaveExecuted: false,
      processesSettled: true,
      processEvidenceRef: null,
    };
  const scratch = await mkdtemp(join(policy.privateDirectory, "execution-"));
  await mkdir(join(scratch, "home"), { mode: 0o700 });
  await mkdir(join(scratch, "tmp"), { mode: 0o700 });
  const profile = join(scratch, "workspace.sb");
  await writeFile(
    profile,
    nativeSeatbeltPolicy({
      root: scratch,
      executable: "/bin/sh",
      ports: [],
      readRoots: [
        policy.workspaceDirectory,
        ...policy.readableRoots,
        ...policy.executableDirectories,
      ],
      writeRoots: policy.writable
        ? [policy.workspaceDirectory, ...policy.writableRoots]
        : [],
    }),
    { mode: 0o600 },
  );
  const environment = {
    PATH: [...policy.executableDirectories, "/usr/bin", "/bin"].join(":"),
    HOME: join(scratch, "home"),
    CFFIXED_USER_HOME: join(scratch, "home"),
    TMPDIR: join(scratch, "tmp"),
    LANG: "en_US.UTF-8",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
  const processRecorder = await WorkspaceProcessRecorder.prepare(
    policy.privateDirectory,
  );
  // Cancellation may arrive while the private directory/policy is being written.
  // No await is permitted between this check and spawning the command.
  if (input.signal?.aborted)
    return {
      state: "not_started",
      exitCode: null,
      stdout: "",
      stderr: "Command cancelled before launch.",
      truncated: false,
      mayHaveExecuted: false,
      processesSettled: true,
      processEvidenceRef: null,
    };
  return new Promise((resolve) => {
    const child = spawn(
      "/usr/bin/sandbox-exec",
      ["-f", profile, "/bin/sh", "-c", input.command],
      {
        cwd,
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      },
    );
    if (child.pid) processRecorder.launched(child.pid);
    const limit = 32 * 1024;
    let stdout = Buffer.alloc(0),
      stderr = Buffer.alloc(0),
      truncated = false,
      expired = false,
      settled = false;
    const append = (stream: "stdout" | "stderr", chunk: Buffer) => {
      const previous = stream === "stdout" ? stdout : stderr;
      const room = limit - previous.length;
      if (chunk.length > room) truncated = true;
      const next = Buffer.concat([previous, chunk.subarray(0, room)]);
      if (stream === "stdout") stdout = next;
      else stderr = next;
    };
    child.stdout.on("data", (chunk) => append("stdout", Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => append("stderr", Buffer.from(chunk)));
    const stopOwnedGroup = () => {
      expired = true;
      // This freshly spawned detached group is still held by this live ChildProcess;
      // no PID discovery/adoption or stale persisted process identity is used.
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* Exit event remains authoritative. */
        }
      }
    };
    const timer = setTimeout(stopOwnedGroup, timeout);
    input.signal?.addEventListener("abort", stopOwnedGroup, { once: true });
    if (input.signal?.aborted) stopOwnedGroup();
    const finish = async (
      state: WorkspaceCommandResult["state"],
      exitCode: number | null,
      started: boolean,
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", stopOwnedGroup);
      child.stdout.destroy();
      child.stderr.destroy();
      const processEvidence = started
        ? await processRecorder.finish(policy.privateDirectory)
        : { processesSettled: true, processEvidenceRef: null };
      resolve({
        state,
        exitCode,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        truncated,
        mayHaveExecuted: started,
        processesSettled: processEvidence.processesSettled,
        processEvidenceRef: processEvidence.processEvidenceRef,
      });
    };
    child.once("error", () => finish("not_started", null, false));
    child.once("close", (code) =>
      finish(expired ? "timed_out" : "exited", code, true),
    );
    // A command may intentionally launch an independent background service. Do not
    // wait indefinitely for its inherited pipes or claim that root exit stopped it.
    child.once("exit", (code, signal) => {
      processRecorder.rootExited(code, signal);
      setTimeout(
        () => finish(expired ? "timed_out" : "exited", code, true),
        25,
      );
    });
  });
}
