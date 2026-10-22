// #106: deliberate recovery of abandoned controller leases, never agent data.
import { constants } from "node:fs";
import {
  lstat,
  open,
  mkdir,
  realpath,
  rename,
  readdir,
} from "node:fs/promises";
import { join, dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
const leases = [
  "foundation/foundation.lock",
  "access/controller.lock",
  "environments/environments.lock",
  "native-transport/transport.lock",
];
export class ProjectRecoveryError extends Error {
  readonly code = "project_recovery";
}
const refuse = (message: string): never => {
  throw new ProjectRecoveryError(message);
};
function absent(pid: number) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}
async function privateDirectory(directory: string) {
  const info = await lstat(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.mode & 0o077 ||
    info.uid !== process.getuid?.() ||
    (await realpath(directory)) !== directory
  )
    refuse(
      "Project recovery needs the original private state directory. Nothing was reset.",
    );
}
async function readLease(path: string, limit = 4096) {
  await privateDirectory(dirname(path));
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.mode & 0o077 ||
      info.uid !== process.getuid?.() ||
      info.size > limit
    )
      refuse("An ownership record could not be verified. Nothing was reset.");
    return { info, bytes: await file.readFile() };
  } finally {
    await file.close();
  }
}

/** Called only by the authenticated owner's explicit recovery action, while
 * this desktop profile holds its single-instance lease and no project opens.
 * Environments are not stopped, disposed, or claimed settled by this operation.
 * Reopening then reconciles their retained execution records normally. */
async function inspectInterruptedProject(
  directory: string,
  requireIdentified: boolean,
  requireSettled: boolean,
) {
  await privateDirectory(directory);
  const records = [];
  for (const relative of leases) {
    const path = join(directory, relative);
    try {
      records.push({ relative, path, ...(await readLease(path)) });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  let identified = 0;
  for (const record of records) {
    // Pre-#106 transport leases were empty. They require corroborating dead
    // controller records plus a separate OS open-file check below.
    if (
      !record.bytes.length &&
      record.relative === "native-transport/transport.lock"
    )
      continue;
    let value;
    try {
      value = JSON.parse(record.bytes.toString("utf8"));
    } catch {
      refuse(
        "An ownership record is unreadable. Saved project data was retained.",
      );
    }
    if (
      !Number.isSafeInteger(value?.pid) ||
      value.pid <= 1 ||
      typeof value.token !== "string"
    )
      refuse(
        "An ownership record has no verifiable controller. Saved project data was retained.",
      );
    if (!absent(value.pid))
      refuse(
        "A recorded Crew controller is still running or cannot be verified. Quit that instance before recovering this project.",
      );
    identified++;
  }
  if (requireIdentified && records.length && !identified)
    refuse(
      "Crew cannot verify who held this project. Saved data was retained for recovery.",
    );
  const processDirectory = join(directory, "native-processes");
  try {
    await privateDirectory(processDirectory);
    for (const name of await readdir(processDirectory)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const record = await readLease(join(processDirectory, name));
      const value = JSON.parse(record.bytes.toString("utf8"));
      if (
        value?.schema !== 1 ||
        !Number.isSafeInteger(value.pid) ||
        value.pid <= 1 ||
        !absent(value.pid)
      )
        refuse(
          "A recorded native agent is still running or cannot be verified. Its retained session was not replaced.",
        );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (requireSettled) {
    try {
      const saved = await readLease(
        join(directory, "environments", "environments.json"),
        16 * 1024 * 1024,
      );
      const value = JSON.parse(saved.bytes.toString("utf8"));
      if (
        value?.schema !== 1 ||
        !Array.isArray(value.operations) ||
        value.operations.some(
          (operation: { state?: unknown; executionSettled?: unknown }) =>
            !operation ||
            operation.state === "running" ||
            operation.state === "uncertain" ||
            operation.executionSettled !== true,
        )
      )
        refuse(
          "An environment command has unresolved execution evidence. Recover the project and check it before quitting.",
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  // Also catches surviving native peers and command processes with project
  // state open. A failed/unsupported OS query must never count as absence.
  try {
    await execute("/usr/sbin/lsof", ["-t", "+D", directory], {
      timeout: 10000,
      maxBuffer: 65536,
    });
    refuse(
      "A process still has this project's state open. Close its other Crew instance before recovering.",
    );
  } catch (error) {
    if (error instanceof ProjectRecoveryError) throw error;
    const result = error as {
      code?: unknown;
      stdout?: string;
      stderr?: string;
    };
    if (result.code !== 1 || result.stdout?.trim() || result.stderr?.trim())
      refuse(
        "Crew could not verify that the interrupted project is unused. Nothing was reset.",
      );
  }
  return records;
}

/** Failed setup alone must not trap an otherwise idle application in Quit.
 * This checks retained processes and command settlement afresh, without opening
 * a runtime, removing locks or treating an agent-set status as OS evidence. */
export async function verifyUnavailableProjectIdle(
  directory: string,
): Promise<void> {
  await inspectInterruptedProject(directory, false, true);
}

export async function recoverInterruptedProject(
  directory: string,
): Promise<void> {
  const records = await inspectInterruptedProject(directory, true, false);
  if (!records.length) return;
  const archive = join(directory, "recovery", `${Date.now()}-${randomUUID()}`);
  await mkdir(archive, { recursive: true, mode: 0o700 });
  await privateDirectory(dirname(archive));
  await privateDirectory(archive);
  const manifest = await open(join(archive, "manifest.json"), "wx", 0o600);
  try {
    await manifest.writeFile(
      JSON.stringify({
        schema: 1,
        recoveredAt: new Date().toISOString(),
        leases: records.map((row) => ({
          path: row.relative,
          sha256: createHash("sha256").update(row.bytes).digest("hex"),
        })),
      }),
    );
    await manifest.sync();
  } finally {
    await manifest.close();
  }
  for (const record of records) {
    const current = await readLease(record.path);
    if (
      current.info.ino !== record.info.ino ||
      current.info.dev !== record.info.dev ||
      !current.bytes.equals(record.bytes)
    )
      refuse(
        "Project ownership changed during recovery. Retry after its controller has closed.",
      );
    const target = join(archive, record.relative);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await rename(record.path, target);
  }
}
