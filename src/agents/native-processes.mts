import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { withStateLock } from "../orchestration/state-lock.mjs";
import type { CallerContext } from "./contracts.mjs";

interface NativeProcessRecord {
  schema: 1;
  caller: CallerContext;
  pid: number;
  recordedAt: string;
}
const code = (error: unknown) =>
  error && typeof error === "object" && "code" in error ? error.code : null;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const validId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 512 &&
  !/[\u0000-\u001f\u007f]/.test(value);
function validCaller(value: unknown): value is CallerContext {
  return (
    object(value) &&
    Object.keys(value).length === 3 &&
    validId(value.projectId) &&
    validId(value.agentId) &&
    validId(value.sessionId)
  );
}
function identity(caller: CallerContext): string {
  if (!validCaller(caller))
    throw new Error("Invalid native launch caller identity.");
  return JSON.stringify([caller.projectId, caller.agentId, caller.sessionId]);
}
function validPid(pid: unknown): pid is number {
  return (
    typeof pid === "number" &&
    Number.isSafeInteger(pid) &&
    pid > 1 &&
    pid <= 0x7fffffff
  );
}
function validRecord(value: unknown): value is NativeProcessRecord {
  return (
    object(value) &&
    Object.keys(value).length === 4 &&
    value.schema === 1 &&
    validCaller(value.caller) &&
    validPid(value.pid) &&
    typeof value.recordedAt === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.recordedAt) &&
    Number.isFinite(Date.parse(value.recordedAt))
  );
}

/** Private append-only launch evidence. Never adopts a process, signals it, or
 * infers that resources/descendants stopped. A live reused PID remains blocked. */
export class NativeProcessRegistry {
  constructor(readonly directory: string) {
    if (!isAbsolute(directory))
      throw new Error(
        "Native process evidence needs an absolute private directory.",
      );
  }

  private async directoryReady(create: boolean): Promise<void> {
    if (create) await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (info.mode & 0o077) !== 0 ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw new Error(
        "Native process evidence directory is not owner-private.",
      );
  }

  private file(caller: CallerContext): string {
    return join(
      this.directory,
      `${createHash("sha256").update(identity(caller)).digest("hex")}.json`,
    );
  }

  private async read(
    caller: CallerContext,
  ): Promise<NativeProcessRecord | null> {
    let file;
    try {
      file = await open(
        this.file(caller),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
    } catch (error) {
      if (code(error) === "ENOENT") return null;
      throw error;
    }
    try {
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        (stat.mode & 0o077) !== 0 ||
        (process.getuid && stat.uid !== process.getuid()) ||
        stat.size > 16 * 1024
      )
        throw new Error("Native process evidence file is unsafe.");
      const value: unknown = JSON.parse(await file.readFile("utf8"));
      if (!validRecord(value) || identity(value.caller) !== identity(caller))
        throw new Error("Native process evidence does not match this session.");
      return value;
    } finally {
      await file.close();
    }
  }

  /** Call with the PID returned by this host's successful spawn, never model input.
   * One session cannot replace earlier launch evidence with a different PID. */
  async recordStarted(caller: CallerContext, pid: number): Promise<void> {
    identity(caller);
    if (!validPid(pid)) throw new Error("Native launch PID is invalid.");
    await this.directoryReady(true);
    await withStateLock(this.directory, "native-processes.lock", async () => {
      await this.directoryReady(false);
      const existing = await this.read(caller);
      if (existing) {
        if (existing.pid !== pid)
          throw new Error(
            "This session already records another native launch; retained evidence was not replaced.",
          );
        return;
      }
      const record: NativeProcessRecord = {
        schema: 1,
        caller: structuredClone(caller),
        pid,
        recordedAt: new Date().toISOString(),
      };
      const target = this.file(caller);
      const temporary = `${target}.${randomUUID()}.tmp`;
      try {
        const file = await open(
          temporary,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          0o600,
        );
        try {
          await file.writeFile(`${JSON.stringify(record)}\n`);
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(temporary, target);
        const directory = await open(
          this.directory,
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      } finally {
        await unlink(temporary).catch((error) => {
          if (code(error) !== "ENOENT") throw error;
        });
      }
    });
  }

  /** Signal zero is only an OS existence probe: it delivers no process signal.
   * ESRCH is the sole success. Missing, malformed, permission-denied or live
   * evidence remains unavailable, even if the recorded PID was later reused. */
  async confirmExited(
    caller: CallerContext,
  ): Promise<{ confirmed: boolean; detail: string }> {
    let record: NativeProcessRecord | null;
    try {
      identity(caller);
      await this.directoryReady(false);
      record = await this.read(caller);
    } catch {
      return {
        confirmed: false,
        detail:
          "Owned native launch evidence is missing, unreadable or unsafe; exit cannot be confirmed.",
      };
    }
    if (!record)
      return {
        confirmed: false,
        detail: "No durable owned native launch is recorded for this session.",
      };
    try {
      process.kill(record.pid, 0);
      return {
        confirmed: false,
        detail:
          "The recorded native PID still exists. Recovery remains blocked; no process was signalled.",
      };
    } catch (error) {
      if (code(error) === "ESRCH")
        return {
          confirmed: true,
          detail:
            "The OS confirms the durably recorded native launch PID is absent. Descendant or environment-resource state is not inferred.",
        };
      return {
        confirmed: false,
        detail:
          "The OS could not verify the recorded native PID is absent. Recovery remains blocked.",
      };
    }
  }
}
