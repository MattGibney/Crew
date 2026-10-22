import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

export interface WorkspaceProcessSettlement {
  /** Confirms absence of the launched group and observed descendants only.
   * Sampling cannot establish arbitrary unobserved daemonization or resource cleanup. */
  processesSettled: boolean;
  processEvidenceRef: string | null;
  checkedAt: string | null;
}

interface ProcessIdentity {
  pid: number;
  ppid: number;
  pgid: number;
  start: string;
  commandHash: string;
}
interface ProcessEvidence {
  version: 1;
  ref: string;
  launch: { pid: number; pgid: number; at: string } | null;
  rootExit: { at: string; code: number | null; signal: string | null } | null;
  observationsComplete: boolean;
  observed: ProcessIdentity[];
}

const exec = promisify(execFile);
const refPattern =
  /^workspace-process:([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
const maxIdentities = 4096;
const maxEvidenceBytes = 1024 * 1024;
const validPid = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) > 1;
const validTime = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value));
const identityKey = (row: ProcessIdentity) => `${row.pid}:${row.start}`;

async function evidenceDirectory(privateDirectory: string): Promise<string> {
  if (
    !isAbsolute(privateDirectory) ||
    (await realpath(privateDirectory)) !== privateDirectory
  )
    throw new Error("Canonical private evidence directory required.");
  const directory = join(privateDirectory, "workspace-process-evidence");
  const stat = await lstat(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    stat.uid !== process.getuid?.() ||
    (await realpath(directory)) !== directory
  )
    throw new Error("Private process evidence is unavailable.");
  return directory;
}

/** Raw process arguments remain only in this local snapshot and are immediately
 * reduced to hashes. Neither ps output nor its diagnostics leave this helper. */
async function processSnapshot(): Promise<Map<number, ProcessIdentity>> {
  const { stdout } = await exec(
    "/bin/ps",
    ["-axww", "-o", "pid=,ppid=,pgid=,lstart=,command="],
    {
      timeout: 5000,
      maxBuffer: 8 * 1024 * 1024,
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
    },
  );
  const rows = new Map<number, ProcessIdentity>();
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const match =
      /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(.*)$/.exec(
        line,
      );
    if (!match) throw new Error("Incomplete process observation.");
    const pid = Number(match[1]);
    if (rows.has(pid)) throw new Error("Ambiguous process observation.");
    rows.set(pid, {
      pid,
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      start: match[4]!.replace(/\s+/g, " "),
      commandHash: createHash("sha256").update(match[5]!).digest("hex"),
    });
  }
  // An empty/truncated success must never turn into proof of process absence.
  if (!rows.has(process.pid))
    throw new Error("Incomplete process observation.");
  return rows;
}

function observe(
  evidence: ProcessEvidence,
  rows: Map<number, ProcessIdentity>,
): void {
  if (!evidence.launch) return;
  const known = new Map(
    evidence.observed.map((row) => [identityKey(row), row]),
  );
  const current = new Set<number>();
  for (const row of rows.values()) {
    if (row.pgid === evidence.launch.pgid || known.has(identityKey(row)))
      current.add(row.pid);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows.values()) {
      if (!current.has(row.pid) && current.has(row.ppid)) {
        current.add(row.pid);
        changed = true;
      }
    }
  }
  for (const pid of current) {
    const row = rows.get(pid)!;
    if (known.size >= maxIdentities && !known.has(identityKey(row))) {
      evidence.observationsComplete = false;
      break;
    }
    known.set(identityKey(row), row);
  }
  evidence.observed = [...known.values()];
}

function settlement(
  evidence: ProcessEvidence,
  rows: Map<number, ProcessIdentity>,
): WorkspaceProcessSettlement {
  // A changed command hash with the same PID/start can be exec(), so remains
  // unsettled. A different start is PID reuse, not the original owned process.
  const groupPresent = [...rows.values()].some(
    (row) => row.pgid === evidence.launch?.pgid,
  );
  const descendantPresent = evidence.observed.some(
    (owned) => rows.get(owned.pid)?.start === owned.start,
  );
  return {
    processesSettled: Boolean(
      evidence.launch &&
      evidence.rootExit &&
      evidence.observationsComplete &&
      !groupPresent &&
      !descendantPresent,
    ),
    processEvidenceRef: evidence.ref,
    checkedAt: new Date().toISOString(),
  };
}

function validEvidence(value: unknown, ref: string): value is ProcessEvidence {
  if (!value || typeof value !== "object") return false;
  const item = value as ProcessEvidence;
  return (
    item.version === 1 &&
    item.ref === ref &&
    typeof item.observationsComplete === "boolean" &&
    Boolean(
      item.launch &&
      validPid(item.launch.pid) &&
      item.launch.pgid === item.launch.pid &&
      validTime(item.launch.at),
    ) &&
    (item.rootExit === null ||
      Boolean(
        item.rootExit &&
        validTime(item.rootExit.at) &&
        Date.parse(item.rootExit.at) >= Date.parse(item.launch!.at) &&
        (item.rootExit.code === null ||
          Number.isSafeInteger(item.rootExit.code)) &&
        (item.rootExit.signal === null ||
          /^SIG[A-Z0-9]+$/.test(item.rootExit.signal)),
      )) &&
    Array.isArray(item.observed) &&
    item.observed.length <= maxIdentities &&
    item.observed.every((row) =>
      Boolean(
        row &&
        validPid(row.pid) &&
        Number.isSafeInteger(row.ppid) &&
        row.ppid >= 0 &&
        validPid(row.pgid) &&
        typeof row.start === "string" &&
        row.start.length <= 64 &&
        validTime(row.start) &&
        typeof row.commandHash === "string" &&
        /^[a-f0-9]{64}$/.test(row.commandHash),
      ),
    )
  );
}

/** Fresh, read-only confirmation. No command replay, process signals, filesystem
 * writes, or inference that root exit implies its children exited. Missing,
 * incomplete or malformed evidence remains unsettled. The caller retains the ref. */
export async function reconcileMacWorkspaceCommand(
  privateDirectory: string,
  processEvidenceRef: string,
): Promise<WorkspaceProcessSettlement> {
  const match =
    typeof processEvidenceRef === "string"
      ? refPattern.exec(processEvidenceRef)
      : null;
  const failure: WorkspaceProcessSettlement = {
    processesSettled: false,
    processEvidenceRef: match ? processEvidenceRef : null,
    checkedAt: null,
  };
  if (process.platform !== "darwin" || !match) return failure;
  try {
    const directory = await evidenceDirectory(privateDirectory);
    const file = await open(
      join(directory, `${match[1]}.json`),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    let contents: string;
    try {
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        stat.size > maxEvidenceBytes ||
        (stat.mode & 0o077) !== 0 ||
        stat.uid !== process.getuid?.() ||
        stat.nlink !== 1
      )
        return failure;
      contents = await file.readFile("utf8");
    } finally {
      await file.close();
    }
    const evidence: unknown = JSON.parse(contents);
    if (!validEvidence(evidence, processEvidenceRef)) return failure;
    return settlement(evidence, await processSnapshot());
  } catch {
    return failure;
  }
}

/** One invocation owns this writer; only the controller can mount its directory. */
export class WorkspaceProcessRecorder {
  private evidence: ProcessEvidence;
  private directory: string;
  private observing: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private persistenceFailed = false;

  private constructor(directory: string) {
    this.directory = directory;
    this.evidence = {
      version: 1,
      ref: `workspace-process:${randomUUID()}`,
      launch: null,
      rootExit: null,
      observationsComplete: true,
      observed: [],
    };
  }

  static async prepare(
    privateDirectory: string,
  ): Promise<WorkspaceProcessRecorder> {
    try {
      await mkdir(join(privateDirectory, "workspace-process-evidence"), {
        mode: 0o700,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    return new WorkspaceProcessRecorder(
      await evidenceDirectory(privateDirectory),
    );
  }

  launched(pid: number): void {
    this.evidence.launch = { pid, pgid: pid, at: new Date().toISOString() };
    this.capture(true);
    this.timer = setInterval(() => this.capture(), 100);
    this.timer.unref();
  }

  rootExited(code: number | null, signal: NodeJS.Signals | null): void {
    this.evidence.rootExit = { at: new Date().toISOString(), code, signal };
  }

  private async persist(): Promise<void> {
    const name = this.evidence.ref.slice("workspace-process:".length);
    const temporary = join(this.directory, `${name}.${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify(this.evidence));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, join(this.directory, `${name}.json`));
    } catch {
      this.persistenceFailed = true;
      this.evidence.observationsComplete = false;
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }

  private capture(persistLaunch = false): void {
    if (this.observing) return;
    this.observing = (async () => {
      // Save the fresh group before waiting on observation. If the controller
      // disappears, absent root-exit evidence remains an explicit unknown.
      if (persistLaunch) await this.persist();
      try {
        observe(this.evidence, await processSnapshot());
      } catch {
        this.evidence.observationsComplete = false;
      }
      await this.persist();
    })().finally(() => {
      this.observing = null;
    });
  }

  async finish(privateDirectory: string): Promise<WorkspaceProcessSettlement> {
    if (this.timer) clearInterval(this.timer);
    await this.observing;
    this.capture();
    await this.observing;
    if (this.persistenceFailed)
      return {
        processesSettled: false,
        processEvidenceRef: null,
        checkedAt: null,
      };
    return reconcileMacWorkspaceCommand(privateDirectory, this.evidence.ref);
  }
}
