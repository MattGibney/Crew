import type {
  AccessRequest,
  AgentCreationPreset,
  Actor,
  ApprovalGrant,
  AuthorizationInput,
  AuthorizationSettlement,
  CallerContext,
  EnvironmentPolicy,
  ExecutionPermit,
  PermissionGroup,
  ServiceConnection,
} from "../agents/contracts.mjs";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { validateState, validateLegacyState } from "./validation.mjs";
import { migrateGroupDerivedAccess } from "./group-access.mjs";
import type { OwnerConnectionVerification } from "./owner-contracts.mjs";

/** Owner setup workflow only; none of these records grants runtime authority. */
export interface ConnectionSetupRecord extends OwnerConnectionVerification {
  connection: ServiceConnection;
  existing: boolean;
  expectedRevision: number | null;
  credentialRevision: number;
  inputFingerprint: string;
  /** Hash of original owner input, so a legitimate refresh does not break retry identity. */
  credentialInputFingerprint?: string;
  saveFingerprint: string | null;
}

export interface AccessAssignment {
  agentId: string;
  permissionGroupIds: string[];
  serviceConnectionIds: string[];
  revision: number;
}
export interface PresetApplicationReceipt {
  agentId: string;
  actor: Actor;
  presetId: string;
  presetRevision: number;
  appliedAt: string;
}
export interface AccessAttempt {
  permit: ExecutionPermit;
  admitted: boolean;
  result: AuthorizationSettlement | null;
}
export interface AccessReservation {
  id: string;
  input: AuthorizationInput;
  onceGrantId: string | null;
  state: "open" | "accepted" | "uncertain" | "released";
  attempts: AccessAttempt[];
}
export interface AccessAudit {
  id: string;
  at: string;
  actor: Actor | null;
  action: string;
  subjectId: string;
}
export interface AccessState {
  version: 2;
  /** Group-derived access migration, independent of legacy Crew scope conversion. */
  groupAccessVersion?: 1;
  pendingLegacySkillAgentIds?: string[];
  projectId: string;
  ownerUserId: string;
  groups: PermissionGroup[];
  presets: AgentCreationPreset[];
  creationDefaults: { revision: number; presetId: string | null };
  assignments: AccessAssignment[];
  /** Absent in earlier fresh-project journals; never inferred from assignments. */
  presetApplications?: PresetApplicationReceipt[];
  connectionSetups?: ConnectionSetupRecord[];
  connections: ServiceConnection[];
  environmentPolicies: EnvironmentPolicy[];
  requests: AccessRequest[];
  grants: ApprovalGrant[];
  reservations: AccessReservation[];
  closedSessions: CallerContext[];
  audit: AccessAudit[];
}

const LIMIT = 8 * 1024 * 1024;

/** One trusted controller owns a store. A leftover lease blocks recovery rather
 * than guessing whether another controller/executor is still alive. */
export class AccessStore {
  #listeners = new Set<() => void>();
  #tail: Promise<unknown> = Promise.resolve();
  #closed = false;
  #failed = false;
  #closing: Promise<void> | null = null;
  private constructor(
    private readonly directory: string,
    private state: AccessState,
  ) {}

  static async create(
    directory: string,
    projectId: string,
    ownerUserId: string,
  ): Promise<AccessStore> {
    if (!path.isAbsolute(directory))
      throw new Error("Access state needs an absolute private directory.");
    const state: AccessState = {
      version: 2,
      groupAccessVersion: 1,
      projectId,
      ownerUserId,
      groups: [],
      presets: [],
      creationDefaults: { revision: 1, presetId: null },
      assignments: [],
      presetApplications: [],
      connections: [],
      environmentPolicies: [],
      requests: [],
      grants: [],
      reservations: [],
      closedSessions: [],
      audit: [],
    };
    validateState(state);
    await mkdir(directory, { mode: 0o700 }); // Explicit fresh state only; never overwrite.
    const store = new AccessStore(await realpath(directory), state);
    await store.acquire();
    try {
      await store.persist(state);
    } catch (error) {
      await store.close();
      throw error;
    }
    return store;
  }

  static async open(
    directory: string,
    projectId: string,
    ownerUserId: string,
  ): Promise<AccessStore> {
    if (!path.isAbsolute(directory))
      throw new Error("Access state needs an absolute private directory.");
    const info = await lstat(directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.mode & 0o077 ||
      info.uid !== process.getuid?.()
    )
      throw new Error(
        "Access directory must be private and owned by the controller.",
      );
    const store = new AccessStore(await realpath(directory), {} as AccessState);
    await store.acquire();
    try {
      const file = await open(
        path.join(directory, "access.json"),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      let value: unknown;
      try {
        const stat = await file.stat();
        if (
          !stat.isFile() ||
          stat.nlink !== 1 ||
          stat.size > LIMIT ||
          stat.mode & 0o077 ||
          stat.uid !== process.getuid?.()
        )
          throw new Error("Invalid access state file.");
        value = JSON.parse(await file.readFile("utf8"));
      } finally {
        await file.close();
      }
      const legacy = (value as { version?: unknown })?.version === 1;
      const original = structuredClone(value);
      if (legacy) {
        validateLegacyState(value);
        const converted = value as AccessState;
        converted.version = 2;
        for (const group of converted.groups) {
          group.grants.crew = [
            ...new Set(group.grants.crew.map((grant) => grant.action)),
          ].map((action) => ({ action }));
          group.revision += 1;
          group.updatedAt = new Date().toISOString();
          converted.audit.push({
            id: randomUUID(),
            at: group.updatedAt,
            actor: null,
            action: "group.converted-to-membership-capabilities",
            subjectId: group.id,
          });
        }
      }
      const groupAccessMigration =
        (value as AccessState).groupAccessVersion !== 1;
      // Validate the retained format before interpreting any grants.
      validateState(value);
      migrateGroupDerivedAccess(value);
      validateState(value);
      if (value.projectId !== projectId || value.ownerUserId !== ownerUserId)
        throw new Error(
          "Access state belongs to a different project or owner.",
        );
      if (legacy || groupAccessMigration) {
        // Exclusive immutable recovery snapshot, retained separately from current authority.
        const backupPath = path.join(
          directory,
          legacy
            ? "access-v1-before-group-capabilities.json"
            : "access-before-group-derived-access.json",
        );
        const snapshot = JSON.stringify(original);
        let backup;
        try {
          backup = await open(backupPath, "wx", 0o600);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          const retained = await open(
            backupPath,
            constants.O_RDONLY | constants.O_NOFOLLOW,
          );
          try {
            const info = await retained.stat();
            if (
              !info.isFile() ||
              info.nlink !== 1 ||
              info.size > LIMIT ||
              info.mode & 0o077 ||
              info.uid !== process.getuid?.() ||
              (await retained.readFile("utf8")) !== snapshot
            )
              throw new Error(
                "Conflicting migration snapshot; preserve it for recovery.",
              );
          } finally {
            await retained.close();
          }
        }
        if (backup) {
          try {
            await backup.writeFile(snapshot);
            await backup.sync();
          } finally {
            await backup.close();
          }
        }
        await store.persist(value);
      }
      store.state = value;
      return store;
    } catch {
      await store.close();
      throw new Error(
        "Access state cannot be opened. Preserve it and restore valid owner/project state.",
      );
    }
  }

  private async acquire(): Promise<void> {
    const lease = await open(
      path.join(this.directory, "controller.lock"),
      "wx",
      0o600,
    ).catch(() => {
      throw new Error(
        "Access store is held. Verify the prior controller has exited before owner recovery; do not delete live leases.",
      );
    });
    try {
      await lease.writeFile(
        JSON.stringify({ pid: process.pid, token: randomUUID() }),
      );
      await lease.sync();
    } finally {
      await lease.close();
    }
  }

  private async persist(state: AccessState): Promise<void> {
    validateState(state);
    const text = JSON.stringify(state);
    if (Buffer.byteLength(text) > LIMIT)
      throw new Error(
        "Access state storage bound reached. Owner maintenance required; no records were discarded.",
      );
    const temporary = path.join(this.directory, `.${randomUUID()}.tmp`);
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(text);
      await file.sync();
      await file.close();
      await rename(temporary, path.join(this.directory, "access.json"));
      const directory = await open(this.directory, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      await file.close().catch(() => {});
      await rm(temporary, { force: true });
    }
  }

  transaction<T>(run: (draft: AccessState) => Promise<T> | T): Promise<T> {
    const operation = this.#tail.then(async () => {
      if (this.#closed || this.#failed)
        throw new Error("Access store unavailable; no execution admitted.");
      const draft = structuredClone(this.state);
      const result = await run(draft);
      if (JSON.stringify(draft) !== JSON.stringify(this.state)) {
        try {
          await this.persist(draft);
        } catch {
          this.#failed = true;
          throw new Error(
            "Access state could not be committed; execution is held for recovery.",
          );
        }
        this.state = draft;
        for (const listener of this.#listeners)
          queueMicrotask(() => {
            try {
              listener();
            } catch {}
          });
      }
      return structuredClone(result);
    });
    this.#tail = operation.catch(() => {});
    return operation;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.#listeners.clear();
    this.#closing = this.#tail.then(async () => {
      await rm(path.join(this.directory, "controller.lock"));
    });
    return this.#closing;
  }
}
