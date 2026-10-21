// AI-009: Crew storage identity and conservative, journaled migration. No auth/model work.
import {
  access,
  readFile,
  writeFile,
  rename,
  mkdir,
  lstat,
  readlink,
  realpath,
  symlink,
  readdir,
  unlink,
  open,
} from "node:fs/promises";
import { join, dirname, resolve, relative, isAbsolute, sep } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { instanceKey } from "./lifecycle.mjs";
import {
  errorCode,
  errorMessage,
  parseJSON,
  record,
  string,
} from "./validation.mjs";
import { parseConfig } from "../config/shape.mjs";
import type { RawConfig } from "../config/contracts.mjs";
interface MigrationJournal {
  version: number;
  status: string;
  id: string;
  source: string;
  target: string;
  key: string;
  profileNeeded: boolean;
  at: string;
  originalHash?: string;
  stagedHash?: string;
}
export interface CrewStorage {
  configPath: string;
  key: string;
  desktopData: string;
  crewRoot: string;
  migrated: boolean;
  issue: string | null;
  oldConfigPath: string;
  legacyConfigPaths: string[];
  newConfigPath: string;
}
type ProcessAlive = (pid: number) => boolean;
const exists = async (p: string) => {
  try {
    await lstat(p);
    return true;
  } catch (e) {
    if (errorCode(e) === "ENOENT") return false;
    throw e;
  }
};
const json = async (p: string) => record(parseJSON(await readFile(p, "utf8")));
const atomic = async (p: string, v: unknown) => {
  const t = `${p}.${randomUUID()}.tmp`;
  await writeFile(t, JSON.stringify(v, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  await rename(t, p);
};
const hash = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const alive = (pid: number) => {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return errorCode(e) !== "ESRCH";
  }
};
const within = (root: string, p: string) => {
  const rel = relative(root, p);
  return (
    !rel || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))
  );
};
async function aliasMatches(source: string, target: string) {
  try {
    return (await realpath(source)) === (await realpath(target));
  } catch {
    return false;
  }
}
async function profileBusy(folder: string, processAlive: ProcessAlive) {
  try {
    const link = await readlink(join(folder, "SingletonLock"));
    const pid = Number(link.match(/-(\d+)$/)?.[1]);
    if (!pid) throw Error("Unrecognized desktop lock.");
    return processAlive(pid);
  } catch (e) {
    if (errorCode(e) === "ENOENT") return false;
    throw Error(
      "Desktop profile ownership is unavailable. Inspect its lock before migrating.",
    );
  }
}
async function assertStopped(configPath: string, processAlive: ProcessAlive) {
  const raw = parseConfig(await readFile(configPath, "utf8"));
  if (typeof raw.runtime?.dataDir !== "string")
    throw Error(
      "Previous config state folder is invalid. Repair it before migration.",
    );
  const data = resolve(dirname(configPath), raw.runtime.dataDir);
  for (const file of ["server.json", "orchestration/controller.lock"]) {
    try {
      const marker = await json(join(data, file));
      if (typeof marker.pid !== "number" || !Number.isInteger(marker.pid))
        throw Error("Runtime marker is malformed.");
      if (processAlive(marker.pid))
        throw Error(
          "The previous controller is still running. Quit its owning app or stop it with its original configuration, then retry.",
        );
    } catch (e) {
      if (errorCode(e) !== "ENOENT") throw e;
    }
  }
  return { raw, data };
}
async function assertNoTasks(data: string) {
  for (const name of ["tasks", "runs", "worktrees", "archive"]) {
    try {
      if ((await readdir(join(data, "orchestration", name))).length)
        throw Error(
          "Previous storage contains saved task/run/worktree evidence. Automatic relocation is blocked to preserve absolute Git/worktree references. Use the previous configuration for recovery; nothing has been deleted.",
        );
    } catch (e) {
      if (errorCode(e) !== "ENOENT") throw e;
    }
  }
}
function rewriteConfig(raw: RawConfig, source: string, target: string) {
  const next = structuredClone(raw),
    convert = (p: string | null) =>
      typeof p === "string" && isAbsolute(p) && within(source, p)
        ? join(target, relative(source, p))
        : p;
  next.runtime.dataDir = convert(next.runtime.dataDir) || next.runtime.dataDir;
  next.runtime.codexBinary = convert(next.runtime.codexBinary);
  for (const role of ["manager", "worker"] as const)
    next.project.prompts[role] =
      convert(next.project.prompts[role]) || next.project.prompts[role];
  for (const repo of next.project.repositories || [])
    if (repo.path && within(source, resolve(source, repo.path)))
      throw Error(
        "A repository is inside previous instance storage. Automatic relocation is blocked; use the previous configuration for recovery.",
      );
  return next;
}
async function ensureAlias(source: string, target: string) {
  if (await exists(source)) {
    if (!(await aliasMatches(source, target)))
      throw Error(
        "Previous location was recreated during migration. Both locations were preserved; inspect before retry.",
      );
    return;
  }
  await mkdir(dirname(source), { recursive: true, mode: 0o700 });
  await symlink(target, source, "dir");
}
export async function prepareCrewStorage({
  appData,
  configOverride = null,
  processAlive = alive,
  checkpoint = async () => {},
}: {
  appData: string;
  configOverride?: string | null;
  processAlive?: ProcessAlive;
  checkpoint?: (stage: string) => Promise<void>;
}): Promise<CrewStorage> {
  const crew = join(appData, "Crew"),
    legacyRoots = [
      join(appData, "Relay"),
      join(appData, "Local Voice Manager"),
    ];
  const targetDefault = join(crew, "instances/default/project.json");
  const legacyDefaults = legacyRoots.map((p) =>
    join(p, "instances/default/project.json"),
  );
  const available: string[] = [];
  for (const p of legacyDefaults) {
    if (
      !(await exists(p)) ||
      (await aliasMatches(dirname(p), dirname(targetDefault)))
    )
      continue;
    let duplicate = false;
    for (const q of available)
      if (await aliasMatches(dirname(p), dirname(q))) duplicate = true;
    if (!duplicate) available.push(p);
  }
  let oldDefault = available[0] || legacyDefaults[1],
    legacy = legacyRoots[legacyDefaults.indexOf(oldDefault)];
  const requested = resolve(configOverride || targetDefault),
    key = instanceKey(requested);
  const result: CrewStorage = {
    configPath: requested,
    key,
    desktopData: join(crew, "desktop", key),
    crewRoot: crew,
    migrated: false,
    issue: null,
    oldConfigPath: oldDefault,
    legacyConfigPaths: available,
    newConfigPath: targetDefault,
  };
  const recovery = (message: string) => ({
    ...result,
    desktopData: join(crew, "recovery", key),
    issue: message,
  });
  await mkdir(crew, { recursive: true, mode: 0o700 });
  const lockPath = join(crew, ".storage-migration.lock");
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch (e) {
    if (errorCode(e) !== "EEXIST") throw e;
    try {
      if (processAlive(Number((await json(lockPath)).pid)))
        return recovery(
          "Another Crew storage migration is running. Retry when it finishes.",
        );
      await unlink(lockPath);
      lock = await open(lockPath, "wx", 0o600);
    } catch {
      return recovery(
        "Storage migration ownership could not be confirmed. Inspect its lock; no data was replaced.",
      );
    }
  }
  await lock.writeFile(JSON.stringify({ pid: process.pid }));
  await lock.close();
  try {
    const journalPath = join(crew, "default-storage-migration.json");
    let journal: MigrationJournal | null = null;
    try {
      journal = decodeJournal(await json(journalPath));
    } catch (e) {
      if (errorCode(e) !== "ENOENT")
        throw Error(
          "Migration journal cannot be read. No new default will be initialized.",
        );
    }
    const pendingApplies =
      journal?.status !== "complete" &&
      journal &&
      (!configOverride ||
        requested === join(journal.source, "project.json") ||
        requested === join(journal.target, "project.json") ||
        (await aliasMatches(requested, join(journal.target, "project.json"))));
    if (pendingApplies && journal) {
      const retained = journal;
      if (
        !legacyDefaults.some((p) => dirname(p) === retained.source) ||
        journal.target !== dirname(targetDefault) ||
        !/^[a-f0-9]{24}$/.test(journal.key)
      )
        throw Error(
          "Migration journal paths do not match this application. Inspect before retry.",
        );
      oldDefault = join(journal.source, "project.json");
      legacy = legacyRoots[legacyDefaults.indexOf(oldDefault)];
    } else journal = null;
    if (!configOverride && !journal && available.length > 1)
      return recovery(
        "Multiple previous default configurations exist. Choose the prior configuration explicitly; nothing was merged or initialized.",
      );
    if (
      !configOverride &&
      !journal &&
      (await exists(oldDefault)) &&
      !(await aliasMatches(dirname(oldDefault), dirname(targetDefault)))
    ) {
      if (await exists(targetDefault))
        return recovery(
          "Both Crew and previous default configurations exist. They were not merged. Choose the Crew default or the previous configuration explicitly.",
        );
      const { raw, data } = await assertStopped(oldDefault, processAlive);
      await assertNoTasks(data);
      const originalBytes = await readFile(oldDefault);
      if (
        JSON.stringify(parseJSON(originalBytes.toString("utf8"))) !==
        JSON.stringify(raw)
      )
        throw Error(
          "Previous configuration changed while migration was planned. Retry.",
        );
      const migrated = rewriteConfig(
        raw,
        dirname(oldDefault),
        dirname(targetDefault),
      );
      let oldKey = instanceKey(oldDefault);
      for (const name of ["crew-storage.json", "relay-storage.json"])
        try {
          const m = await json(join(dirname(oldDefault), name));
          if (/^[a-f0-9]{24}$/.test(String(m.partitionKey)))
            oldKey = string(m.partitionKey, "Partition key");
        } catch (e) {
          if (errorCode(e) !== "ENOENT") throw e;
        }
      const oldProfile = join(legacy, "desktop", oldKey),
        newProfile = join(crew, "desktop", oldKey);
      if (
        (await profileBusy(oldProfile, processAlive)) ||
        (await profileBusy(newProfile, processAlive))
      )
        throw Error(
          "The previous desktop app is still running. Quit it, then retry migration.",
        );
      if (
        (await exists(oldProfile)) &&
        (await exists(newProfile)) &&
        !(await aliasMatches(oldProfile, newProfile))
      )
        throw Error(
          "Both previous and Crew desktop profiles exist. They were preserved; choose a configuration explicitly for recovery.",
        );
      journal = {
        version: 1,
        status: "planned",
        id: randomUUID(),
        source: dirname(oldDefault),
        target: dirname(targetDefault),
        key: oldKey,
        profileNeeded: await exists(oldProfile),
        at: new Date().toISOString(),
      };
      await atomic(join(crew, ".migrated-default-config.json"), migrated);
      journal.originalHash = hash(originalBytes);
      journal.stagedHash = hash(
        await readFile(join(crew, ".migrated-default-config.json")),
      );
      await atomic(join(journal.source, ".crew-migration-origin.json"), {
        id: journal.id,
      });
      await atomic(journalPath, journal);
      await checkpoint("planned");
    }
    if (journal) {
      result.key = journal.key;
      result.desktopData = join(crew, "desktop", journal.key);
      const oldProfile = join(legacy, "desktop", journal.key),
        newProfile = join(crew, "desktop", journal.key);
      if (
        (await profileBusy(oldProfile, processAlive)) ||
        (await profileBusy(newProfile, processAlive))
      )
        throw Error(
          "An instance is using the migration profile. Quit it and retry.",
        );
      const current = (await exists(oldDefault)) ? oldDefault : targetDefault;
      if (await exists(current)) {
        const currentHash = hash(await readFile(current));
        if (
          !journal.originalHash ||
          ![journal.originalHash, journal.stagedHash].includes(currentHash) ||
          hash(await readFile(join(crew, ".migrated-default-config.json"))) !==
            journal.stagedHash
        )
          throw Error(
            "Configuration changed after migration was planned. Neither copy was overwritten; inspect and recover the journal explicitly.",
          );
        const provenance = await json(
          join(dirname(current), ".crew-migration-origin.json"),
        );
        if (provenance.id !== journal.id)
          throw Error(
            "Configuration migration provenance changed; inspect before retry.",
          );
      }
      if (await exists(current)) {
        const { data } = await assertStopped(current, processAlive);
        await assertNoTasks(data);
      }
      if (journal.profileNeeded) {
        if (
          (await exists(oldProfile)) &&
          !(await aliasMatches(oldProfile, newProfile))
        ) {
          if (await exists(newProfile))
            throw Error(
              "Migration profile destination already exists. Nothing was overwritten.",
            );
          await mkdir(dirname(newProfile), { recursive: true, mode: 0o700 });
          await atomic(join(oldProfile, "crew-profile-origin.json"), {
            configPath: oldDefault,
            migrationId: journal.id,
          });
          await rename(oldProfile, newProfile);
        } else if (!(await exists(newProfile)))
          throw Error(
            "Migration profile is unavailable. Inspect the journal before retry.",
          );
        const provenance = await json(
          join(newProfile, "crew-profile-origin.json"),
        );
        if (provenance.migrationId !== journal.id)
          throw Error(
            "Migration profile provenance did not match. No new profile was created.",
          );
        await ensureAlias(oldProfile, newProfile);
      }
      await checkpoint("profile-moved");
      if (
        (await exists(journal.source)) &&
        !(await aliasMatches(journal.source, journal.target))
      ) {
        if (await exists(journal.target))
          throw Error(
            "Migration config destination already exists. Neither copy was overwritten.",
          );
        await mkdir(dirname(journal.target), { recursive: true, mode: 0o700 });
        await rename(journal.source, journal.target);
      } else if (!(await exists(journal.target)))
        throw Error(
          "Migration configuration is unavailable. Inspect the journal before retry.",
        );
      await checkpoint("instance-moved");
      const original = join(
        journal.target,
        "project.json.before-crew-migration.json",
      );
      if (!(await exists(original)))
        await writeFile(original, await readFile(targetDefault), {
          mode: 0o600,
          flag: "wx",
        });
      await atomic(
        targetDefault,
        await json(join(crew, ".migrated-default-config.json")),
      );
      await atomic(join(journal.target, "crew-storage.json"), {
        version: 1,
        partitionKey: journal.key,
        migratedFrom: oldDefault,
        at: new Date().toISOString(),
      });
      await ensureAlias(journal.source, journal.target);
      await atomic(journalPath, { ...journal, status: "complete" });
      result.migrated = true;
    }
    // Migrated defaults keep their Chromium partition key, so the saved voice survives.
    if (
      !configOverride ||
      requested === targetDefault ||
      (await aliasMatches(requested, targetDefault))
    ) {
      try {
        const meta = await json(
          join(dirname(targetDefault), "crew-storage.json"),
        );
        if (/^[a-f0-9]{24}$/.test(String(meta.partitionKey))) {
          result.key = string(meta.partitionKey, "Partition key");
          result.desktopData = join(crew, "desktop", result.key);
        }
      } catch (e) {
        if (errorCode(e) !== "ENOENT")
          throw Error(
            "Crew storage identity metadata is invalid. Inspect it before continuing.",
          );
      }
    }
    const targetProfile = result.desktopData,
      profiles = [];
    for (const p of legacyRoots.map((p) => join(p, "desktop", result.key)))
      if ((await exists(p)) && !(await aliasMatches(p, targetProfile)))
        profiles.push(p);
    if (profiles.length > 1 && !(await aliasMatches(profiles[0], profiles[1])))
      throw Error(
        "Multiple previous desktop profiles exist for this configuration. They were preserved; inspect them before retry.",
      );
    const sourceProfile = profiles[0] || join(legacy, "desktop", result.key);
    if (
      (await exists(sourceProfile)) &&
      !(await aliasMatches(sourceProfile, targetProfile))
    ) {
      if (
        (await profileBusy(sourceProfile, processAlive)) ||
        (await profileBusy(targetProfile, processAlive))
      )
        throw Error(
          "This configuration is open in the previous desktop app. Quit that instance, then retry. Other project instances can keep running.",
        );
      if (await exists(targetProfile))
        throw Error(
          "Both desktop profiles exist for this configuration. They were not merged; inspect them before retrying.",
        );
      await mkdir(dirname(targetProfile), { recursive: true, mode: 0o700 });
      await atomic(join(sourceProfile, "crew-profile-origin.json"), {
        configPath: requested,
      });
      await rename(sourceProfile, targetProfile);
      await ensureAlias(sourceProfile, targetProfile);
      result.migrated = true;
    }
    return result;
  } catch (error) {
    return recovery(errorMessage(error));
  } finally {
    await unlink(lockPath).catch(() => {});
  }
}

function decodeJournal(value: Record<string, unknown>): MigrationJournal {
  if (
    typeof value.version !== "number" ||
    typeof value.profileNeeded !== "boolean"
  )
    throw new Error("Migration journal is invalid.");
  return {
    version: value.version,
    status: string(value.status, "Migration status"),
    id: string(value.id, "Migration ID"),
    source: string(value.source, "Migration source"),
    target: string(value.target, "Migration target"),
    key: string(value.key, "Migration partition key"),
    profileNeeded: value.profileNeeded,
    at: string(value.at, "Migration time"),
    ...(value.originalHash === undefined
      ? {}
      : { originalHash: string(value.originalHash, "Original hash") }),
    ...(value.stagedHash === undefined
      ? {}
      : { stagedHash: string(value.stagedHash, "Staged hash") }),
  };
}
