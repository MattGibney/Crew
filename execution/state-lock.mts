import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { snapshotProcesses } from "../process-ownership.mjs";
import { errorCode, isRecord } from "./errors.mjs";
interface LockOwner {
  pid: number;
  start: string;
  token: string;
  at: string;
}
const now = () => new Date().toISOString();
const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
let processIdentity: Promise<{ pid: number; start: string }> | null;
async function ownIdentity() {
  if (!processIdentity)
    processIdentity = snapshotProcesses()
      .then((rows) => {
        const identity = rows.get(process.pid);
        if (!identity)
          throw new Error("Cannot verify state-lock process identity.");
        return { pid: process.pid, start: identity.start };
      })
      .catch((error) => {
        processIdentity = null;
        throw error;
      });
  return processIdentity;
}
async function lockOwner(lockPath: string): Promise<Partial<LockOwner> | null> {
  try {
    const value: unknown = JSON.parse(
      await fs.readFile(path.join(lockPath, "owner.json"), "utf8"),
    );
    if (!isRecord(value)) return null;
    return {
      pid: typeof value.pid === "number" ? value.pid : undefined,
      start: typeof value.start === "string" ? value.start : undefined,
      token: typeof value.token === "string" ? value.token : undefined,
      at: typeof value.at === "string" ? value.at : undefined,
    };
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(String(errorCode(error)))) return null;
    throw error;
  }
}
async function ownerActive(
  owner: Partial<LockOwner> | null,
  { inspect = true }: { inspect?: boolean } = {},
) {
  if (
    !owner ||
    typeof owner.pid !== "number" ||
    !Number.isSafeInteger(owner.pid) ||
    typeof owner.start !== "string" ||
    typeof owner.token !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
      owner.token,
    )
  )
    return true; // unknown is never permission to steal
  if (owner.pid === process.pid)
    return owner.start === (await ownIdentity()).start;
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    if (errorCode(error) === "ESRCH") return false;
    return true;
  }
  if (!inspect) return true; // Fresh observer: retain conservatively without a process-table scan.
  try {
    const actual = (await snapshotProcesses()).get(owner.pid);
    return (
      !actual || (actual.start === owner.start && !actual.state?.includes("Z"))
    );
  } catch {
    return true;
  }
}
async function candidateObservers(dir: string, name: string, ownToken: string) {
  let unknown = false;
  for (const entry of await fs.readdir(dir)) {
    if (
      !entry.startsWith(`${name}.candidate-`) ||
      entry === `${name}.candidate-${ownToken}`
    )
      continue;
    const candidate = path.join(dir, entry);
    let owner;
    try {
      owner = await lockOwner(candidate);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    if (
      !owner ||
      entry !== `${name}.candidate-${owner.token}` ||
      typeof owner.pid !== "number" ||
      !Number.isSafeInteger(owner.pid) ||
      owner.pid <= 1 ||
      typeof owner.start !== "string" ||
      !owner.start.trim() ||
      typeof owner.token !== "string" ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
        owner.token,
      )
    ) {
      // Publication may still be in flight. Never delete incomplete evidence or
      // keep admitting writes that would accumulate unreclaimable barriers.
      if (
        await fs.stat(candidate).then(
          () => true,
          (error) => {
            if (errorCode(error) === "ENOENT") return false;
            throw error;
          },
        )
      )
        unknown = true;
      continue;
    }
    // Candidate paths are unique to this exact acquisition token. They cannot
    // be reused by a successor, so verified-dead candidates can be removed.
    const published = Date.parse(owner.at || ""),
      elapsed = Date.now() - published;
    const withinWindow =
      Number.isFinite(published) && elapsed >= 0 && elapsed < 5000;
    if (!(await ownerActive(owner, { inspect: !withinWindow })))
      await fs.rm(candidate, { recursive: true, force: true });
    else {
      // This is an admission barrier, never permission to delete a live or
      // unknown observer. Suspended observers must not accumulate retirements
      // beyond their original bounded acquisition window.
      if (!withinWindow) unknown = true;
    }
  }
  return unknown;
}
export async function withStateLock<T>(
  dir: string,
  name: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const lockPath = path.join(dir, name),
    token = randomUUID(),
    candidate = `${lockPath}.candidate-${token}`,
    owner = { ...(await ownIdentity()), token, at: now() };
  // Publish a complete, nonempty owner directory atomically. A process killed
  // before publication leaves only its private candidate, never an empty lock.
  await fs.mkdir(candidate, { mode: 0o700 });
  await fs.writeFile(
    path.join(candidate, "owner.json"),
    JSON.stringify(owner),
    { mode: 0o600 },
  );
  const deadline = Date.now() + 5000;
  let acquired = false;
  try {
    while (!acquired) {
      if (await candidateObservers(dir, name, token)) {
        if (Date.now() >= deadline)
          throw new Error(
            `State lock observer ownership unknown or acquisition overdue: ${name}; inspect retained candidate evidence before retrying`,
          );
        await pause(25);
        continue;
      }
      try {
        await fs.rename(candidate, lockPath);
        acquired = true;
      } catch (error) {
        if (
          !["EEXIST", "ENOTEMPTY", "ENOTDIR"].includes(String(errorCode(error)))
        )
          throw error;
        const previous = await lockOwner(lockPath);
        if (previous && !(await ownerActive(previous))) {
          // A deterministic nonempty tombstone prevents two stale observers from
          // renaming a newly acquired lock after the first observer recovered it.
          try {
            await fs.rename(lockPath, `${lockPath}.stale-${previous.token}`);
          } catch (recovery) {
            if (
              !["EEXIST", "ENOTEMPTY", "ENOENT"].includes(
                String(errorCode(recovery)),
              )
            )
              throw recovery;
          }
          continue;
        }
        if (Date.now() >= deadline)
          throw new Error(
            `State lock busy: ${name}; inspect its owner before retrying`,
          );
        await pause(25);
      }
    }
    return await fn();
  } finally {
    if (acquired) {
      const current = await lockOwner(lockPath);
      if (current?.token !== token)
        throw new Error(
          `State lock ownership changed: ${name}; no other lock was removed`,
        );
      // Move the entire lock away before deleting it: removing owner.json in
      // place would briefly create an empty directory another writer can replace.
      // Recovery and ordinary release retire into the SAME token-specific
      // barrier. A delayed observer of this owner must never rename its successor.
      await fs.rename(lockPath, `${lockPath}.stale-${token}`);
      // Each observer publishes its candidate before reading an owner and keeps
      // it until acquisition/failure. Capture retired barriers BEFORE checking
      // candidates: when none remain, nobody can still act on those old owners.
      // New candidates cannot observe an owner already retired before this scan.
      // Unknown candidates conservatively retain barriers and block future admission;
      // verified-dead candidates are reclaimed before acquisition, never by age.
      const retired = (await fs.readdir(dir)).filter((entry) =>
        entry.startsWith(`${name}.stale-`),
      );
      const observing = (await fs.readdir(dir)).some((entry) =>
        entry.startsWith(`${name}.candidate-`),
      );
      if (!observing)
        for (const entry of retired)
          await fs.rm(path.join(dir, entry), { recursive: true, force: true });
    } else await fs.rm(candidate, { recursive: true, force: true });
  }
}
