// AI-015: native-only update coordination. No credentials or renderer Node bridge.
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  rm,
  realpath,
} from "node:fs/promises";
import { join, resolve, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { snapshotProcesses } from "../process-ownership.mjs";
const exec = promisify(execFile);
import { errorCode, parseJSON, record as objectRecord } from "./validation.mjs";
import type { UpdateReservation } from "./update-contracts.mjs";
export function newerVersion(candidate: unknown, current: unknown): boolean {
  const parse = (value: unknown) =>
    typeof value === "string"
      ? value.match(
          /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-z.-]+))?(?:\+[\da-z.-]+)?$/i,
        )
      : null;
  const a = parse(candidate),
    b = parse(current);
  if (!a || !b || a[4]) return false;
  for (let i = 1; i <= 3; i++) {
    if (Number(a[i]) !== Number(b[i])) return Number(a[i]) > Number(b[i]);
  }
  return Boolean(b[4]);
}
export async function signedUpdateSupport({
  packaged,
  executable = process.execPath,
  run = exec,
}: { packaged?: boolean; executable?: string; run?: typeof exec } = {}) {
  if (!packaged)
    return {
      supported: false,
      error: "Automatic updates require an installed, signed Crew release.",
    };
  try {
    const bundle = resolve(executable, "../../..");
    await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle], {
      timeout: 15000,
      maxBuffer: 65536,
    });
    const { stderr = "", stdout = "" } = await run(
      "/usr/bin/codesign",
      ["--display", "--verbose=4", bundle],
      { timeout: 5000, maxBuffer: 65536 },
    );
    if (
      !/^Authority=Developer ID Application:/m.test(stderr + stdout) ||
      !/^TeamIdentifier=[A-Z0-9]+$/m.test(stderr + stdout)
    )
      throw new Error("Unsigned");
    return { supported: true, error: null };
  } catch {
    return {
      supported: false,
      error:
        "This Crew build is unsigned or its Developer ID signature could not be verified. Install a signed release to enable automatic updates.",
    };
  }
}
export async function otherNativeInstances({
  executable = process.execPath,
  pid = process.pid,
  backendPid,
  backendPids = backendPid ? [backendPid] : [],
  run = exec,
}: {
  executable?: string;
  pid?: number;
  backendPid?: number;
  backendPids?: number[];
  run?: typeof exec;
} = {}) {
  const { stdout } = await run("/bin/ps", ["-axo", "pid=,ppid=,command="], {
    timeout: 5000,
    maxBuffer: 8 * 1024 * 1024,
  });
  const rows = stdout.split("\n").flatMap((line) => {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] }] : [];
  });
  if (!rows.some((row) => row.pid === pid))
    throw new Error("Native process ownership snapshot is unavailable.");
  const allowed = new Set([pid]);
  // Only this instance's currently owned backend tree may be stopped during an
  // idle restart. Detached supervisors from closed instances remain blockers.
  for (const backend of backendPids)
    if (
      Number.isSafeInteger(backend) &&
      rows.some((row) => row.pid === backend && row.ppid === pid)
    )
      allowed.add(backend);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows)
      if (allowed.has(row.ppid) && row.ppid !== pid && !allowed.has(row.pid)) {
        allowed.add(row.pid);
        changed = true;
      }
  }
  return rows
    .filter(
      (row) =>
        !allowed.has(row.pid) &&
        (row.command === executable ||
          row.command.startsWith(executable + " ")),
    )
    .map((row) => row.pid);
}
// Atomic nonempty directory publication avoids the empty-lock crash window.
// Deterministic tombstones prevent two dead-owner recoverers stealing a new lock.
export function createInstallLease({
  directory,
  snapshot = snapshotProcesses,
  pid = process.pid,
}: {
  directory: string;
  snapshot?: typeof snapshotProcesses;
  pid?: number;
}) {
  const target = join(directory, "installation.lock");
  const ownerAt = async (path: string) =>
    objectRecord(parseJSON(await readFile(join(path, "owner.json"), "utf8")));
  const active = async (owner: Record<string, unknown>) => {
    if (
      !owner ||
      typeof owner.pid !== "number" ||
      !Number.isSafeInteger(owner.pid) ||
      typeof owner.start !== "string" ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
        typeof owner.token === "string" ? owner.token : "",
      )
    )
      return true;
    const current = (await snapshot()).get(owner.pid);
    return Boolean(
      current && current.start === owner.start && !current.state?.includes("Z"),
    );
  };
  return {
    async acquire() {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const own = (await snapshot()).get(pid);
      if (!own)
        throw new Error("Cannot verify the update lock process identity.");
      const token = randomUUID(),
        candidate = join(directory, `candidate-${token}`),
        owner = { pid, start: own.start, token };
      await mkdir(candidate, { mode: 0o700 });
      await writeFile(join(candidate, "owner.json"), JSON.stringify(owner), {
        mode: 0o600,
      });
      let acquired = false;
      try {
        for (let attempt = 0; attempt < 4; attempt++) {
          try {
            await rename(candidate, target);
            acquired = true;
            break;
          } catch (error) {
            if (!["EEXIST", "ENOTEMPTY"].includes(errorCode(error) || ""))
              throw error;
          }
          let previous;
          try {
            previous = await ownerAt(target);
          } catch {
            throw new Error(
              "Another update has an unverified installation lock.",
            );
          }
          if (await active(previous))
            throw new Error("Another Crew instance is preparing an update.");
          try {
            await rename(target, join(directory, `stale-${previous.token}`));
          } catch (error) {
            if (
              !["ENOENT", "EEXIST", "ENOTEMPTY"].includes(
                errorCode(error) || "",
              )
            )
              throw error;
          }
        }
        if (!acquired)
          throw new Error(
            "Could not reserve the Crew installation. Retry after other instances quit.",
          );
      } finally {
        if (!acquired) await rm(candidate, { recursive: true, force: true });
      }
      return async () => {
        const current = await ownerAt(target);
        if (current.token !== token)
          throw new Error("Update lock ownership changed.");
        const released = join(directory, `released-${token}`);
        await rename(target, released);
        await rm(released, { recursive: true });
      };
    },
  };
}
// Squirrel.Mac relaunch has no configurable argv. Preserve the configured
// instance with one bounded, version-bound local handoff, never auth contents.
export function createRestartHandoff({
  directory,
  snapshot = snapshotProcesses,
  pid = process.pid,
  now = Date.now,
  executable = process.execPath,
}: {
  directory: string;
  snapshot?: typeof snapshotProcesses;
  pid?: number;
  now?: () => number;
  executable?: string;
}) {
  const target = join(directory, "restart.json");
  return {
    async write({
      configPath,
      version,
    }: {
      configPath: string;
      version: string;
    }) {
      if (!isAbsolute(configPath) || !/^\d+\.\d+\.\d+$/.test(version))
        throw new Error("Invalid update restart identity.");
      const owner = (await snapshot()).get(pid);
      if (!owner) throw new Error("Cannot verify restart process identity.");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const token = randomUUID(),
        temporary = join(directory, `restart-${token}.tmp`);
      await writeFile(
        temporary,
        JSON.stringify({
          configPath,
          version,
          executable: await realpath(resolve(executable)),
          pid,
          start: owner.start,
          at: now(),
          token,
        }),
        { mode: 0o600 },
      );
      await rename(temporary, target);
      return async () => {
        try {
          const record = objectRecord(
            parseJSON(await readFile(target, "utf8")),
          );
          if (record.token === token) await rm(target);
        } catch (error) {
          if (errorCode(error) !== "ENOENT") throw error;
        }
      };
    },
    async consume(version: string, explicitConfig: string | null) {
      let record;
      try {
        record = objectRecord(parseJSON(await readFile(target, "utf8")));
      } catch (error) {
        if (errorCode(error) === "ENOENT") return null;
        throw new Error("The update restart handoff is unreadable.");
      }
      if (
        !record ||
        record.version !== version ||
        typeof record.configPath !== "string" ||
        !isAbsolute(record.configPath) ||
        typeof record.pid !== "number" ||
        !Number.isSafeInteger(record.pid) ||
        typeof record.start !== "string" ||
        typeof record.token !== "string" ||
        !/^[a-f0-9-]{36}$/.test(record.token) ||
        typeof record.at !== "number" ||
        !Number.isFinite(record.at) ||
        now() - record.at < 0 ||
        now() - record.at > 10 * 60 * 1000
      )
        return null;
      // Legacy unbound records never activate a project. Replacing the app at
      // the same installation path preserves identity; another app copy does not.
      if (
        typeof record.executable !== "string" ||
        record.executable !== (await realpath(resolve(executable)))
      )
        return null;
      if (
        explicitConfig &&
        resolve(explicitConfig) !== resolve(record.configPath)
      )
        return null;
      const previous = (await snapshot()).get(record.pid);
      if (
        previous &&
        previous.start === record.start &&
        !previous.state?.includes("Z")
      )
        return null;
      const claimed = join(directory, `restart-claimed-${record.token}`);
      try {
        await rename(target, claimed);
      } catch (error) {
        if (errorCode(error) === "ENOENT") return null;
        throw error;
      }
      try {
        const actual = objectRecord(parseJSON(await readFile(claimed, "utf8")));
        if (actual.token !== record.token)
          throw new Error("The update restart handoff changed.");
        return record.configPath;
      } finally {
        await rm(claimed);
      }
    },
  };
}
// Native setup admission must freeze synchronously before the backend reserve
// await; a previous idle snapshot alone cannot prevent a concurrent setup save.
export function createNativeUpdateGate({
  busy = () => false,
}: { busy?: () => boolean } = {}) {
  let reserved = false;
  return {
    isReserved: () => reserved,
    assertSetupAllowed() {
      if (reserved)
        throw new Error(
          "Crew is preparing an update. Finish the restart before changing setup.",
        );
    },
    async reserve(prepare: () => Promise<UpdateReservation>) {
      if (reserved || busy())
        throw new Error("Crew setup or shutdown is in progress.");
      reserved = true;
      try {
        const result = await prepare();
        if (result?.reserved !== true) reserved = false;
        return result;
      } catch (error) {
        reserved = false;
        throw error;
      }
    },
    cancel() {
      reserved = false;
    },
  };
}
