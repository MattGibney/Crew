import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
  readdir,
  rename,
  rm,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { FoundationState } from "./store.mjs";
import { agentRecord, readAgentRecord } from "./agent-record.mjs";

type Agent = FoundationState["agents"][number];
interface AgentReference {
  id: string;
  directory: string;
  file: "agent.json";
  sha256: string;
}
type FoundationIndex = Omit<FoundationState, "schema" | "agents"> & {
  schema: 2;
  agents: AgentReference[];
};
interface PendingTransaction {
  schema: 1;
  transactionId: string;
  previousIndexSha256: string | null;
  nextState: FoundationState;
  coreSchemaVersion?: 1;
  deletedReferences?: AgentReference[];
}
interface EncodedState {
  index: FoundationIndex;
  bytes: Buffer;
  cores: Map<string, Buffer>;
}
const stateLimit = 32 * 1024 * 1024;
const journalLimit = stateLimit + 4096;
const digest = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const serialize = (value: unknown) =>
  Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const hashPattern = /^[a-f0-9]{64}$/;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const absent = (error: unknown) =>
  (error as NodeJS.ErrnoException).code === "ENOENT";

/** Derived from identity alone, never from a reporting relationship or supplied path.
 * Reserve the hash namespace and hash case-sensitive IDs to avoid folder aliases
 * on ordinary macOS case-insensitive volumes. */
function agentFolder(id: string): string {
  if (/^[a-z0-9][a-z0-9_-]{0,127}$/.test(id) && !id.startsWith("sha256-"))
    return id;
  return `sha256-${createHash("sha256").update(id).digest("hex")}`;
}

/** Private per-agent files plus a recoverable project-index commit. The existing
 * FoundationStore writer lease and mutation queue remain the sole writer authority. */
export class AgentFileStorage {
  private knownIndexHash: string | null | undefined;
  private knownReferences: AgentReference[] = [];
  private canonicalDirectory: string | undefined;

  constructor(
    private readonly directory: string,
    private readonly identity: { projectId: string; ownerUserId: string },
    private readonly validateState: (value: unknown) => void,
    private readonly ownsWriter: () => Promise<boolean>,
  ) {}

  private async writer(): Promise<void> {
    if (!(await this.ownsWriter()))
      throw new Error("Foundation writer ownership was lost.");
  }

  private async privateDirectory(path: string, create = false): Promise<void> {
    if (create) {
      try {
        await mkdir(path, { mode: 0o700 });
        await this.syncDirectory(resolve(path, ".."));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    const stat = await lstat(path);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (stat.mode & (path === this.directory ? 0o022 : 0o077)) !== 0 ||
      (process.getuid && stat.uid !== process.getuid()) ||
      (await realpath(path)) !==
        join(
          this.canonicalDirectory ?? this.directory,
          relative(this.directory, path),
        )
    )
      throw new Error(
        "Foundation agent directory ownership or canonical path is unsafe.",
      );
  }

  private async root(): Promise<void> {
    if (
      !isAbsolute(this.directory) ||
      resolve(this.directory) !== this.directory
    )
      throw new Error(
        "Foundation directory must be an absolute canonical path.",
      );
    const canonical = await realpath(this.directory);
    if (
      this.canonicalDirectory !== undefined &&
      canonical !== this.canonicalDirectory
    )
      throw new Error("Foundation canonical directory changed.");
    this.canonicalDirectory = canonical;
    await this.privateDirectory(this.directory);
  }

  private async agentDirectories(
    ref: AgentReference,
    create = false,
  ): Promise<string> {
    const agents = join(this.directory, "agents");
    await this.privateDirectory(agents, create);
    const path = join(this.directory, ref.directory);
    await this.privateDirectory(path, create);
    await this.privateDirectory(join(path, "assets"), create);
    return path;
  }

  private async read(path: string, limit = stateLimit): Promise<Buffer | null> {
    let file: FileHandle;
    try {
      file = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error) {
      if (absent(error)) return null;
      throw error;
    }
    try {
      const stat = await file.stat();
      const named = await lstat(path);
      if (
        !stat.isFile() ||
        named.isSymbolicLink() ||
        stat.dev !== named.dev ||
        stat.ino !== named.ino ||
        stat.nlink !== 1 ||
        (stat.mode & 0o077) !== 0 ||
        (process.getuid && stat.uid !== process.getuid()) ||
        stat.size > limit
      )
        throw new Error(
          "Foundation agent file ownership, type or size is unsafe.",
        );
      const bytes = await file.readFile();
      if (bytes.length > limit)
        throw new Error("Foundation agent file exceeds its size bound.");
      return bytes;
    } finally {
      await file.close();
    }
  }

  private async syncDirectory(path: string): Promise<void> {
    const file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      await file.sync();
    } finally {
      await file.close();
    }
  }

  private async atomicWrite(
    path: string,
    bytes: Buffer,
    replace = true,
  ): Promise<void> {
    await this.writer();
    const parent = resolve(path, "..");
    await this.privateDirectory(parent);
    const parentBefore = await lstat(parent);
    // Reject unsafe existing files before replacing their directory entries.
    const existing = await this.read(
      path,
      Math.max(journalLimit, bytes.length),
    );
    if (!replace && existing !== null)
      throw new Error("Foundation transaction destination already exists.");
    const temporary = join(parent, `.foundation-${randomUUID()}.tmp`);
    const file = await open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    const created = await file.stat();
    try {
      await file.writeFile(bytes);
      await file.sync();
      await file.close();
      await this.writer();
      await this.privateDirectory(parent);
      const parentAfter = await lstat(parent);
      if (
        parentBefore.dev !== parentAfter.dev ||
        parentBefore.ino !== parentAfter.ino
      )
        throw new Error("Foundation transaction directory changed.");
      await rename(temporary, path);
      await this.syncDirectory(parent);
    } finally {
      await file.close().catch(() => {});
      // Never erase a replaced/unowned temporary file during error cleanup.
      const current = await lstat(temporary).catch((error: unknown) => {
        if (absent(error)) return null;
        throw error;
      });
      if (current?.dev === created.dev && current.ino === created.ino)
        await unlink(temporary);
    }
  }

  private validate(value: unknown): asserts value is FoundationState {
    this.validateState(value);
    if (
      !record(value) ||
      value.schema !== 1 ||
      value.projectId !== this.identity.projectId ||
      value.ownerUserId !== this.identity.ownerUserId ||
      !Array.isArray(value.agents) ||
      value.agents.some(
        (agent: unknown) =>
          !record(agent) ||
          typeof agent.id !== "string" ||
          !agent.id ||
          agent.projectId !== this.identity.projectId,
      ) ||
      new Set(value.agents.map((agent: Agent) => agent.id)).size !==
        value.agents.length ||
      serialize(value).length > stateLimit
    )
      throw new Error("Invalid, mismatched or oversized foundation state.");
  }

  private encode(state: FoundationState, versioned = true): EncodedState {
    this.validate(state);
    const cores = new Map<string, Buffer>();
    const references = state.agents.map((agent): AgentReference => {
      const bytes = serialize(versioned ? agentRecord(agent) : agent);
      cores.set(agent.id, bytes);
      return {
        id: agent.id,
        directory: `agents/${agentFolder(agent.id)}`,
        file: "agent.json",
        sha256: digest(bytes),
      };
    });
    const index: FoundationIndex = { ...state, schema: 2, agents: references };
    const bytes = serialize(index);
    if (bytes.length > stateLimit)
      throw new Error("Foundation index exceeds its size bound.");
    return { index, bytes, cores };
  }

  private index(value: unknown): FoundationIndex {
    if (
      !record(value) ||
      value.schema !== 2 ||
      value.projectId !== this.identity.projectId ||
      value.ownerUserId !== this.identity.ownerUserId ||
      !Array.isArray(value.agents)
    )
      throw new Error("Invalid or mismatched foundation index.");
    const ids = new Set<string>();
    const paths = new Set<string>();
    for (const ref of value.agents) {
      if (
        !record(ref) ||
        Object.keys(ref).length !== 4 ||
        typeof ref.id !== "string" ||
        !ref.id ||
        ref.directory !== `agents/${agentFolder(ref.id)}` ||
        ref.file !== "agent.json" ||
        typeof ref.sha256 !== "string" ||
        !hashPattern.test(ref.sha256) ||
        ids.has(ref.id) ||
        paths.has(ref.directory)
      )
        throw new Error(
          "Invalid, duplicate or unsafe foundation agent reference.",
        );
      ids.add(ref.id);
      paths.add(ref.directory);
    }
    return value as unknown as FoundationIndex;
  }

  private async readCore(
    ref: AgentReference,
    create = false,
  ): Promise<Buffer | null> {
    const path = await this.agentDirectories(ref, create);
    return this.read(join(path, ref.file));
  }

  private async stateFromIndex(
    index: FoundationIndex,
  ): Promise<FoundationState> {
    const agents: Agent[] = [];
    for (const ref of index.agents) {
      const bytes = await this.readCore(ref);
      if (bytes === null || digest(bytes) !== ref.sha256)
        throw new Error(
          "Foundation agent core is missing or its hash does not match.",
        );
      const agent: unknown = readAgentRecord(
        JSON.parse(bytes.toString("utf8")),
      );
      if (
        !record(agent) ||
        agent.id !== ref.id ||
        agent.projectId !== index.projectId
      )
        throw new Error("Foundation agent identity does not match its index.");
      agents.push(agent as unknown as Agent);
    }
    const state = { ...index, schema: 1, agents };
    this.validate(state);
    return state;
  }

  private pending(value: unknown): PendingTransaction {
    if (
      !record(value) ||
      Object.keys(value).some(
        (key) =>
          ![
            "schema",
            "transactionId",
            "previousIndexSha256",
            "nextState",
            "coreSchemaVersion",
            "deletedReferences",
          ].includes(key),
      ) ||
      (value.coreSchemaVersion !== undefined &&
        value.coreSchemaVersion !== 1) ||
      value.schema !== 1 ||
      typeof value.transactionId !== "string" ||
      !/^[a-zA-Z0-9-]{1,128}$/.test(value.transactionId) ||
      !(
        value.previousIndexSha256 === null ||
        (typeof value.previousIndexSha256 === "string" &&
          hashPattern.test(value.previousIndexSha256))
      )
    )
      throw new Error("Invalid foundation pending transaction.");
    this.validate(value.nextState);
    if (value.deletedReferences !== undefined) {
      const refs = this.index({
        schema: 2,
        ...this.identity,
        agents: value.deletedReferences,
      }).agents;
      const live = new Set(value.nextState.agents.map((agent) => agent.id));
      const deleted = new Set(
        value.nextState.deletedAgents?.map((agent) => agent.id),
      );
      if (refs.some((ref) => live.has(ref.id) || !deleted.has(ref.id)))
        throw new Error(
          "Agent deletion requires a retained deletion identity.",
        );
    }
    return value as unknown as PendingTransaction;
  }

  private async removePending(expected: Buffer): Promise<void> {
    await this.writer();
    await this.root();
    const path = join(this.directory, "foundation.pending.json");
    const current = await this.read(path, journalLimit);
    if (current === null || !current.equals(expected))
      throw new Error("Foundation pending transaction changed before cleanup.");
    await unlink(path);
    await this.syncDirectory(this.directory);
  }

  private async recover(pendingBytes: Buffer): Promise<void> {
    const pending = this.pending(JSON.parse(pendingBytes.toString("utf8")));
    const next = this.encode(
      pending.nextState,
      pending.coreSchemaVersion === 1,
    );
    const currentBytes = await this.read(
      join(this.directory, "foundation.json"),
    );
    const currentHash = currentBytes === null ? null : digest(currentBytes);
    const desiredHash = digest(next.bytes);
    if (
      currentHash !== pending.previousIndexSha256 &&
      currentHash !== desiredHash
    )
      throw new Error(
        "Foundation index differs from both pending transaction boundaries; recovery is required.",
      );
    let previous: AgentReference[] = [];
    if (currentBytes !== null) {
      const current: unknown = JSON.parse(currentBytes.toString("utf8"));
      if (record(current) && current.schema === 1) this.validate(current);
      else previous = this.index(current).agents;
    }
    if (currentHash !== desiredHash) {
      for (const deleted of pending.deletedReferences ?? []) {
        const original = previous.find((ref) => ref.id === deleted.id);
        if (!original || JSON.stringify(original) !== JSON.stringify(deleted))
          throw new Error(
            "Deleted agent reference does not match the previous index.",
          );
      }
    }
    if (currentHash === desiredHash) {
      // The index was committed only after every core was durable. A missing or
      // altered core here is corruption, never an invitation to silently reset it.
      await this.stateFromIndex(next.index);
    } else {
      const old = new Map(previous.map((ref) => [ref.id, ref]));
      for (const ref of next.index.agents) {
        const bytes = await this.readCore(ref, !old.has(ref.id));
        const hash = bytes === null ? null : digest(bytes);
        const original = old.get(ref.id);
        if (
          hash !== ref.sha256 &&
          (original === undefined ? hash !== null : hash !== original.sha256)
        )
          throw new Error(
            "Foundation core changed outside the pending transaction.",
          );
        if (hash !== ref.sha256)
          await this.atomicWrite(
            join(this.directory, ref.directory, ref.file),
            next.cores.get(ref.id)!,
          );
        old.delete(ref.id);
      }
      // Removing a reference does not authorize deleting or ignoring a damaged
      // retained agent directory. Its files remain for explicit future recovery.
      for (const ref of old.values()) {
        const bytes = await this.readCore(ref);
        if (bytes === null || digest(bytes) !== ref.sha256)
          throw new Error(
            "Retained foundation agent core is missing or changed.",
          );
      }
      await this.writer();
      const beforeCommit = await this.read(
        join(this.directory, "foundation.json"),
      );
      if (
        (beforeCommit === null ? null : digest(beforeCommit)) !==
        pending.previousIndexSha256
      )
        throw new Error(
          "Foundation index changed during transaction recovery.",
        );
      await this.atomicWrite(
        join(this.directory, "foundation.json"),
        next.bytes,
      );
    }
    for (const ref of pending.deletedReferences ?? [])
      await this.deleteAgentDirectory(ref);
    await this.removePending(pendingBytes);
  }

  /** Only a durable owner-requested deletion transaction reaches this method.
   * rm unlinks symlinks inside assets instead of traversing their targets. A
   * partially removed directory is valid only while replaying this journal. */
  private async deleteAgentDirectory(ref: AgentReference): Promise<void> {
    await this.writer();
    await this.root();
    const agents = join(this.directory, "agents");
    await this.privateDirectory(agents);
    const path = join(this.directory, ref.directory);
    try {
      await this.privateDirectory(path);
    } catch (error) {
      if (absent(error)) return;
      throw error;
    }
    const core = await this.read(join(path, ref.file));
    if (core !== null && digest(core) !== ref.sha256)
      throw new Error("Deleted agent core changed before removal.");
    await rm(path, { recursive: true, force: true });
    await this.syncDirectory(agents);
  }

  async load(): Promise<FoundationState | null> {
    await this.writer();
    await this.root();
    const pending = await this.read(
      join(this.directory, "foundation.pending.json"),
      journalLimit,
    );
    if (pending !== null) await this.recover(pending);
    const bytes = await this.read(join(this.directory, "foundation.json"));
    if (bytes === null) {
      const agents = join(this.directory, "agents");
      try {
        await this.privateDirectory(agents);
        if ((await readdir(agents)).length)
          throw new Error(
            "Foundation index is missing but retained agent folders exist; recovery is required.",
          );
      } catch (error) {
        if (!absent(error)) throw error;
      }
      if (
        (await readdir(this.directory)).some((name) =>
          /^foundation\.legacy-[a-f0-9]{64}\.json$/.test(name),
        )
      )
        throw new Error(
          "Foundation index is missing but a retained legacy backup exists; recovery is required.",
        );
      this.knownIndexHash = null;
      this.knownReferences = [];
      return null;
    }
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (record(value) && value.schema === 1) {
      this.validate(value);
      const backup = join(
        this.directory,
        `foundation.legacy-${digest(bytes)}.json`,
      );
      const existing = await this.read(backup);
      if (existing === null) await this.atomicWrite(backup, bytes, false);
      else if (!existing.equals(bytes))
        throw new Error(
          "Foundation migration backup differs from its original bytes.",
        );
      this.knownIndexHash = digest(bytes);
      this.knownReferences = [];
      await this.persist(value);
      return structuredClone(value);
    }
    const index = this.index(value);
    const state = await this.stateFromIndex(index);
    this.knownIndexHash = digest(bytes);
    this.knownReferences = index.agents;
    // Upgrade only after validating every core and the entire assembled state.
    // The normal journal makes version-zero to version-one conversion resumable.
    if (!this.encode(state).bytes.equals(bytes)) await this.persist(state);
    return state;
  }

  async persist(input: FoundationState): Promise<void> {
    const state = structuredClone(input);
    const next = this.encode(state);
    await this.writer();
    await this.root();
    if (this.knownIndexHash === undefined) await this.load();
    if (
      (await this.read(
        join(this.directory, "foundation.pending.json"),
        journalLimit,
      )) !== null
    )
      throw new Error(
        "Foundation has a prepared transaction; reopen to recover it before writing.",
      );
    const current = await this.read(join(this.directory, "foundation.json"));
    if ((current === null ? null : digest(current)) !== this.knownIndexHash)
      throw new Error("Foundation index changed outside its writer.");
    const old = new Map(this.knownReferences.map((ref) => [ref.id, ref]));
    const nextIds = new Set(next.index.agents.map((ref) => ref.id));
    const removed = this.knownReferences.filter((ref) => !nextIds.has(ref.id));
    const deletedIds = new Set(state.deletedAgents?.map((entry) => entry.id));
    for (const ref of this.knownReferences) {
      const bytes = await this.readCore(ref);
      if (bytes === null || digest(bytes) !== ref.sha256)
        throw new Error(
          "Foundation agent core is missing or changed outside its writer.",
        );
      if (removed.some((entry) => entry.id === ref.id)) {
        const agent = readAgentRecord(
          JSON.parse(bytes.toString("utf8")),
        ) as Agent;
        if (
          !deletedIds.has(ref.id) ||
          !agent.archivedAt ||
          agent.runtime.session.observedState !== "stopped" ||
          agent.runtime.session.activeTurnId !== null
        )
          throw new Error(
            "Permanent deletion requires an archived, stopped agent and an explicit deletion record.",
          );
      }
    }
    for (const ref of next.index.agents) {
      if (old.has(ref.id)) continue;
      const bytes = await this.readCore(ref, true);
      if (bytes !== null && digest(bytes) !== ref.sha256)
        throw new Error(
          "An unindexed foundation agent folder already contains different state.",
        );
    }
    if (current !== null && current.equals(next.bytes)) return;
    const pending: PendingTransaction = {
      schema: 1,
      transactionId: randomUUID(),
      previousIndexSha256: this.knownIndexHash ?? null,
      nextState: state,
      coreSchemaVersion: 1,
      ...(removed.length ? { deletedReferences: removed } : {}),
    };
    // Compact envelope keeps journal overhead bounded by a few hundred bytes
    // relative to the already-enforced logical-state serialization budget.
    const pendingBytes = Buffer.from(`${JSON.stringify(pending)}\n`);
    if (pendingBytes.length > journalLimit)
      throw new Error("Foundation pending transaction exceeds its size bound.");
    await this.atomicWrite(
      join(this.directory, "foundation.pending.json"),
      pendingBytes,
      false,
    );
    // From this point onward failures retain the prepared journal. load() replays
    // the exact next snapshot; no caller can roll back or reset uncertain writes.
    await this.recover(pendingBytes);
    this.knownIndexHash = digest(next.bytes);
    this.knownReferences = next.index.agents;
  }
}
