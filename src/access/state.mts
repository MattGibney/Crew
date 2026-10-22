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
import { validateState } from "./validation.mjs";

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
  version: 1;
  projectId: string;
  ownerUserId: string;
  groups: PermissionGroup[];
  presets: AgentCreationPreset[];
  creationDefaults: { revision: number; presetId: string | null };
  assignments: AccessAssignment[];
  /** Absent in earlier fresh-project journals; never inferred from assignments. */
  presetApplications?: PresetApplicationReceipt[];
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
      version: 1,
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
      validateState(value);
      if (value.projectId !== projectId || value.ownerUserId !== ownerUserId)
        throw new Error(
          "Access state belongs to a different project or owner.",
        );
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
