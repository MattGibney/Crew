import { spawn } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { lstat, mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { homedir } from "node:os";
import { nativeSeatbeltPolicy } from "./native-boundary.mjs";
import { WorkspaceProcessRecorder } from "./workspace-process-evidence.mjs";
import type { WorkspaceBackgroundStatus } from "./workspace-process-evidence.mjs";
export {
  inspectMacWorkspaceProcess,
  stopMacWorkspaceProcess,
} from "./workspace-process-evidence.mjs";
export type {
  WorkspaceBackgroundStatus,
  WorkspaceStopResult,
} from "./workspace-process-evidence.mjs";
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
  /** Explicit nonsecret values from the pinned, owner-approved template. */
  environment?: Record<string, string>;
  /** Runtime-owned prepared home; never the host user's HOME or copied auth. */
  runtimeHome?: { path: string; device: number; inode: number };
  /** Explicit BROAD host-daemon authority. The daemon can bypass workspace file
   * restrictions; this does not provide hostile-worker or VM isolation. */
  hostDocker?: {
    socketPath: string;
    device: number;
    inode: number;
    hostAccessAcknowledged: true;
  };
  /** Outbound internet access remains opt-in. Workspace TCP/UDP server ports
   * and loopback connections are unrestricted; port arrays are legacy metadata. */
  network?: {
    outbound: boolean;
    localhostPorts: number[];
    inboundPorts?: number[];
  };
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

async function prepareExecution(
  policy: WorkspaceExecutionPolicy,
  input: { command: string; relativeCwd?: string },
) {
  if (process.platform !== "darwin")
    throw new Error("The current workspace executor requires macOS.");
  if (
    !input.command ||
    Buffer.byteLength(input.command) > 64 * 1024 ||
    input.command.includes("\0")
  )
    throw new Error("Invalid workspace command.");
  const suppliedEnvironment = policy.environment ?? {};
  if (
    Object.keys(suppliedEnvironment).length > 64 ||
    Object.entries(suppliedEnvironment).some(
      ([key, value]) =>
        !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) ||
        typeof value !== "string" ||
        value.includes("\0") ||
        Buffer.byteLength(value) > 8192 ||
        /^(?:PATH|HOME|CFFIXED_USER_HOME|TMPDIR|ENV|BASH_ENV|NODE_OPTIONS|NODE_PATH|DOCKER_.*|SHELL|CDPATH|GIT_CONFIG.*|GIT_ASKPASS|SSH_.*|.*PROXY|DYLD_.*|LD_.*|NPM_CONFIG_USERCONFIG|NPM_CONFIG_GLOBALCONFIG)$/i.test(
          key,
        ) ||
        /(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|AUTHORIZATION|AUTH_TOKEN)/i.test(
          key,
        ),
    )
  )
    throw new Error(
      "Only bounded, explicit nonsecret environment values are allowed.",
    );
  if (
    policy.network &&
    (typeof policy.network.outbound !== "boolean" ||
      !Array.isArray(policy.network.localhostPorts) ||
      policy.network.localhostPorts.length > 32 ||
      policy.network.localhostPorts.some(
        (port) => !Number.isSafeInteger(port) || port < 1024 || port > 65535,
      ))
  )
    throw new Error("Invalid approved workspace network capability.");
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
  const stats = await Promise.all(roots.map((root) => lstat(root)));
  if (stats.some((stat) => !stat.isDirectory() || stat.isSymbolicLink()))
    throw new Error("Trusted directory roots required.");
  if (
    canonical.some(
      (root, index) =>
        root !== roots[index] ||
        root === "/" ||
        root === homedir() ||
        root === dirname(homedir()) ||
        inside(join(homedir(), ".codex"), root) ||
        inside(join(homedir(), ".ssh"), root) ||
        root === join(homedir(), "Library") ||
        // The trusted controller uses Library in packaged Crew. Only its fresh
        // execution scratch is mounted; command/tool roots remain forbidden.
        (index !== 1 && inside(join(homedir(), "Library"), root)),
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
  const runtimeHome = policy.runtimeHome;
  const hostDocker = policy.hostDocker;
  const assertDirectoryIdentity = (
    path: string,
    device: number,
    inode: number,
  ) => {
    const stat = lstatSync(path);
    if (
      !isAbsolute(path) ||
      realpathSync(path) !== path ||
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0 ||
      stat.dev !== device ||
      stat.ino !== inode
    )
      throw new Error("Prepared runtime home identity is unavailable.");
  };
  if (runtimeHome) {
    assertDirectoryIdentity(
      runtimeHome.path,
      runtimeHome.device,
      runtimeHome.inode,
    );
    if (
      [
        policy.workspaceDirectory,
        policy.privateDirectory,
        ...policy.readableRoots,
        ...policy.executableDirectories,
      ].some(
        (path) =>
          inside(path, runtimeHome.path) || inside(runtimeHome.path, path),
      ) ||
      runtimeHome.path === "/" ||
      runtimeHome.path === homedir() ||
      inside(runtimeHome.path, homedir()) ||
      [
        join(homedir(), "Library"),
        join(homedir(), ".codex"),
        join(homedir(), ".ssh"),
      ].some((path) => inside(path, runtimeHome.path))
    )
      throw new Error(
        "Prepared runtime home must be separate from host and controller storage.",
      );
  }
  const assertDockerIdentity = () => {
    if (!hostDocker) return;
    if (
      hostDocker.hostAccessAcknowledged !== true ||
      !runtimeHome ||
      !isAbsolute(hostDocker.socketPath) ||
      realpathSync(hostDocker.socketPath) !== hostDocker.socketPath
    )
      throw new Error(
        "Host Docker requires explicit broad-access acknowledgement and an isolated prepared home.",
      );
    const stat = lstatSync(hostDocker.socketPath);
    if (
      !stat.isSocket() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid?.() ||
      stat.dev !== hostDocker.device ||
      stat.ino !== hostDocker.inode
    )
      throw new Error(
        "Approved host Docker socket identity changed or is unavailable.",
      );
  };
  assertDockerIdentity();
  let dockerConfig: { path: string; device: number; inode: number } | undefined;
  if (hostDocker && runtimeHome) {
    const path = join(runtimeHome.path, ".docker");
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const stat = await lstat(path);
    dockerConfig = { path, device: stat.dev, inode: stat.ino };
    assertDirectoryIdentity(path, stat.dev, stat.ino);
  }
  const assertPreparedIdentity = () => {
    if (runtimeHome)
      assertDirectoryIdentity(
        runtimeHome.path,
        runtimeHome.device,
        runtimeHome.inode,
      );
    if (dockerConfig)
      assertDirectoryIdentity(
        dockerConfig.path,
        dockerConfig.device,
        dockerConfig.inode,
      );
    assertDockerIdentity();
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
      workspaceFileDescriptors: true,
      readRoots: [
        policy.workspaceDirectory,
        ...policy.readableRoots,
        ...policy.executableDirectories,
      ],
      writeRoots: [
        ...(policy.writable ? [policy.workspaceDirectory] : []),
        ...policy.writableRoots,
        ...(runtimeHome ? [runtimeHome.path] : []),
      ],
      workspaceHostDockerSocket: hostDocker?.socketPath,
      workspaceNetwork: policy.network,
    }),
    { mode: 0o600 },
  );
  const environment = {
    ...suppliedEnvironment,
    PATH: [...policy.executableDirectories, "/usr/bin", "/bin"].join(":"),
    HOME: runtimeHome?.path ?? join(scratch, "home"),
    CFFIXED_USER_HOME: runtimeHome?.path ?? join(scratch, "home"),
    ...(hostDocker && dockerConfig
      ? {
          DOCKER_HOST: `unix://${hostDocker.socketPath}`,
          DOCKER_CONFIG: dockerConfig.path,
        }
      : {}),
    TMPDIR: join(scratch, "tmp"),
    LANG: "en_US.UTF-8",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
  return { cwd, profile, environment, assertPreparedIdentity };
}

const cancelledResult = (): WorkspaceCommandResult => ({
  state: "not_started",
  exitCode: null,
  stdout: "",
  stderr: "Command cancelled before launch.",
  truncated: false,
  mayHaveExecuted: false,
  processesSettled: true,
  processEvidenceRef: null,
});

/** Real project execution with template-owned capabilities; no ambient environment.
 * The host owns invocation identity, fresh authority, admission and receipts. */
export async function runMacWorkspaceCommand(
  policy: WorkspaceExecutionPolicy,
  input: {
    command: string;
    relativeCwd?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  },
): Promise<WorkspaceCommandResult> {
  const timeout = input.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 120_000)
    throw new Error(
      "Command timeout must be between 100 and 120000 milliseconds.",
    );
  if (input.signal?.aborted) return cancelledResult();
  const { cwd, profile, environment, assertPreparedIdentity } =
    await prepareExecution(policy, input);
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
  assertPreparedIdentity();
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

export interface WorkspaceBackgroundResult extends Omit<
  WorkspaceBackgroundStatus,
  "state"
> {
  state: WorkspaceBackgroundStatus["state"] | "not_started";
  stdout: string;
  stderr: string;
  truncated: boolean;
  mayHaveExecuted: boolean;
}

/** Launches a managed background command. Running means observed process identity,
 * not application readiness. The controller must retain and freshly authorize its
 * opaque receipt for status/stop; it must not accept a model-supplied host PID. */
export async function startMacWorkspaceProcess(
  policy: WorkspaceExecutionPolicy,
  input: { command: string; relativeCwd?: string; signal?: AbortSignal },
): Promise<WorkspaceBackgroundResult> {
  const notStarted = (): WorkspaceBackgroundResult => ({
    state: "not_started",
    stdout: "",
    stderr: "Command did not start.",
    truncated: false,
    mayHaveExecuted: false,
    processesSettled: true,
    processEvidenceRef: null,
    checkedAt: null,
    processes: [],
    listeningPorts: [],
    portsObserved: true,
  });
  if (input.signal?.aborted) return notStarted();
  const { cwd, profile, environment, assertPreparedIdentity } =
    await prepareExecution(policy, input);
  const recorder = await WorkspaceProcessRecorder.prepare(
    policy.privateDirectory,
  );
  if (input.signal?.aborted) return notStarted();
  assertPreparedIdentity();
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
  let launchError = false;
  let stdout = Buffer.alloc(0),
    stderr = Buffer.alloc(0),
    truncated = false;
  const append = (stream: "stdout" | "stderr", chunk: Buffer) => {
    const previous = stream === "stdout" ? stdout : stderr;
    const room = 32 * 1024 - previous.length;
    if (chunk.length > room) truncated = true;
    const next = Buffer.concat([
      previous,
      chunk.subarray(0, Math.max(room, 0)),
    ]);
    if (stream === "stdout") stdout = next;
    else stderr = next;
  };
  child.stdout.on("data", (chunk) => append("stdout", Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => append("stderr", Buffer.from(chunk)));
  const abort = () => {
    // Only this fresh live ChildProcess group, never a receipt adopted after restart.
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        /* Receipt remains authoritative. */
      }
    }
  };
  const release = () => {
    input.signal?.removeEventListener("abort", abort);
    child.stdout.destroy();
    child.stderr.destroy();
  };
  child.once("error", () => {
    launchError = true;
    release();
  });
  child.once("exit", (code, signal) => {
    recorder.rootExited(code, signal);
    release();
    void recorder.finish(policy.privateDirectory).catch(() => {
      /* Retained receipt remains unsettled. */
    });
  });
  if (child.pid) recorder.launched(child.pid);
  input.signal?.addEventListener("abort", abort, { once: true });
  if (input.signal?.aborted) abort();
  await new Promise((resolve) => setTimeout(resolve, 100));
  if (launchError || !child.pid) return notStarted();
  const status = await recorder.checkpoint(policy.privateDirectory);
  return {
    ...status,
    stdout: stdout.toString("utf8"),
    stderr: stderr.toString("utf8"),
    truncated,
    mayHaveExecuted: true,
  };
}
