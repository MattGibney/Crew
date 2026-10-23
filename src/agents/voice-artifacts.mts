import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import type { RuntimeBinding, Timestamp } from "./contracts.mjs";

export interface VoiceTranscriptArtifact {
  id: string;
  projectId: string;
  agentId: string;
  threadId: string;
  callId: string;
  voiceSessionId: string;
  realtimeSessionId: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  state: "active" | "closed" | "interrupted";
  items: {
    itemId: string;
    role: "user" | "assistant";
    text: string;
    done: boolean;
    /** First observed item order within this call, not a native timeline position. */
    ordinal: number;
    /** First observed time; existing artifacts keep their recorded observation. */
    observedAt: Timestamp;
  }[];
}

export interface VoiceTranscriptRecord {
  binding: RuntimeBinding;
  callId: string;
  voiceSessionId: string;
  realtimeSessionId: string;
  itemId: string;
  role: "user" | "assistant";
  text: string;
  done: boolean;
  delta: boolean;
  observedAt: Timestamp;
}

interface StoredArtifact {
  schema: 1;
  ownerUserId: string;
  sessionId: string;
  artifact: VoiceTranscriptArtifact;
}
interface FileReference {
  name: string;
  state: "active" | "closed" | "interrupted";
  order: string;
  call: string;
  artifact: string;
}

const PAGE_SIZE = 20;
const MAX_ITEMS = 2048;
const MAX_PENDING_ITEMS = 128;
const MAX_TEXT = 200_000;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_CALLS_PER_THREAD = 100_000;
const hash = (values: string[]) =>
  createHash("sha256").update(JSON.stringify(values)).digest("hex");
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const id = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 512 &&
  !/[\u0000-\u001f\u007f]/.test(value);
const timestamp = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const code = (error: unknown) => (object(error) ? error.code : undefined);
const exactKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => key in value);
const scopeKey = (projectId: string, agentId: string, threadId: string) =>
  hash([projectId, agentId, threadId]);
const callKey = (
  value: Pick<
    VoiceTranscriptArtifact,
    "projectId" | "agentId" | "threadId" | "callId"
  >,
) => hash([value.projectId, value.agentId, value.threadId, value.callId]);
const artifactKey = (
  value: Pick<
    VoiceTranscriptArtifact,
    | "projectId"
    | "agentId"
    | "threadId"
    | "callId"
    | "voiceSessionId"
    | "realtimeSessionId"
  >,
) =>
  hash([
    value.projectId,
    value.agentId,
    value.threadId,
    value.callId,
    value.voiceSessionId,
    value.realtimeSessionId,
  ]);
const prefix = { active: "a", closed: "c", interrupted: "i" } as const;
function reference(name: string): FileReference | null {
  const match = /^([aci])-(\d{13}-([a-f0-9]{64})-([a-f0-9]{64}))\.json$/.exec(
    name,
  );
  if (!match) return null;
  return {
    name,
    order: match[2]!,
    call: match[3]!,
    artifact: match[4]!,
    state:
      match[1] === "a" ? "active" : match[1] === "c" ? "closed" : "interrupted",
  };
}
function validateArtifact(value: unknown): value is VoiceTranscriptArtifact {
  if (
    !object(value) ||
    !exactKeys(value, [
      "id",
      "projectId",
      "agentId",
      "threadId",
      "callId",
      "voiceSessionId",
      "realtimeSessionId",
      "createdAt",
      "updatedAt",
      "state",
      "items",
    ]) ||
    ![
      value.id,
      value.projectId,
      value.agentId,
      value.threadId,
      value.callId,
      value.voiceSessionId,
      value.realtimeSessionId,
    ].every(id) ||
    !timestamp(value.createdAt) ||
    !timestamp(value.updatedAt) ||
    !["active", "closed", "interrupted"].includes(String(value.state)) ||
    !Array.isArray(value.items) ||
    value.items.length > MAX_ITEMS
  )
    return false;
  const ids = new Set<string>();
  return value.items.every((item, ordinal) => {
    if (
      !object(item) ||
      !exactKeys(item, [
        "itemId",
        "role",
        "text",
        "done",
        "ordinal",
        "observedAt",
      ]) ||
      !id(item.itemId) ||
      ids.has(item.itemId) ||
      (item.role !== "user" && item.role !== "assistant") ||
      typeof item.text !== "string" ||
      item.text.length > MAX_TEXT ||
      typeof item.done !== "boolean" ||
      item.ordinal !== ordinal ||
      !timestamp(item.observedAt)
    )
      return false;
    ids.add(item.itemId);
    return true;
  });
}

/** Owner-readable records of validated public voice events, never model context.
 * The host MUST hold its FoundationStore single-writer ownership lock for this
 * object's entire lifetime (including open/recovery/dispose). There is no
 * independent multi-process writer lock. Callers authorize owner access and
 * validate current native call provenance before invoking this trusted port.
 * No audio, raw handoff payload, inferred coding turn, or flat transcript is stored.
 */
export class VoiceTranscriptArtifacts {
  private tail: Promise<void> = Promise.resolve();
  private pendingRecords = new Map<
    string,
    { event: VoiceTranscriptRecord; promise: Promise<void> }
  >();
  private pendingFailure: unknown = null;
  private disposed = false;
  private disposing = false;
  private rootIdentity = "";

  private constructor(
    private readonly options: {
      directory: string;
      projectId: string;
      ownerUserId: string;
    },
  ) {}

  static async open(options: {
    directory: string;
    projectId: string;
    ownerUserId: string;
  }): Promise<VoiceTranscriptArtifacts> {
    if (
      !isAbsolute(options.directory) ||
      !id(options.projectId) ||
      !id(options.ownerUserId)
    )
      throw new Error(
        "Voice artifacts require an absolute private directory and exact owner/project identity.",
      );
    const store = new VoiceTranscriptArtifacts({
      ...options,
      directory: resolve(options.directory),
    });
    await store.directory(store.options.directory, true);
    const stat = await lstat(store.options.directory);
    store.rootIdentity = `${stat.dev}:${stat.ino}`;
    const marker = join(store.options.directory, "identity.json");
    const expected = {
      schema: 1,
      projectId: options.projectId,
      ownerUserId: options.ownerUserId,
    };
    let existing: unknown;
    try {
      existing = await store.readJson(marker, 4096);
    } catch (error) {
      if (code(error) !== "ENOENT") throw error;
    }
    if (existing === undefined) {
      if ((await readdir(store.options.directory)).length)
        throw new Error(
          "Voice artifact storage has no verified owner identity.",
        );
      await store.writeJson(marker, expected, 4096);
    } else if (
      !object(existing) ||
      !exactKeys(existing, ["schema", "projectId", "ownerUserId"]) ||
      existing.schema !== 1 ||
      existing.projectId !== options.projectId ||
      existing.ownerUserId !== options.ownerUserId
    )
      throw new Error(
        "Voice artifact storage belongs to another project or owner.",
      );
    await store.directory(join(store.options.directory, "threads"), true);
    await store.syncDirectory(store.options.directory);
    await store.interruptActive();
    return store;
  }

  private async directory(path: string, create = false) {
    if (create) await mkdir(path, { recursive: true, mode: 0o700 });
    const stat = await lstat(path);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.mode & 0o077 ||
      (process.getuid && stat.uid !== process.getuid()) ||
      (await realpath(path)) !== path
    )
      throw new Error(
        "Voice artifact directory is not canonical owner-private storage.",
      );
    if (
      path === this.options.directory &&
      this.rootIdentity &&
      `${stat.dev}:${stat.ino}` !== this.rootIdentity
    )
      throw new Error("Voice artifact storage identity changed.");
  }

  private async readJson(path: string, maximum = MAX_BYTES): Promise<unknown> {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.mode & 0o077 ||
        stat.size > maximum ||
        (process.getuid && stat.uid !== process.getuid())
      )
        throw new Error(
          "Voice artifact file is unsafe or exceeds its size limit.",
        );
      try {
        return JSON.parse(await file.readFile("utf8"));
      } catch {
        throw new Error("Voice artifact JSON is malformed.");
      }
    } finally {
      await file.close();
    }
  }

  private async syncDirectory(path: string) {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      await file.sync();
    } finally {
      await file.close();
    }
  }

  private async writeJson(path: string, value: unknown, maximum = MAX_BYTES) {
    const serialized = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(serialized) > maximum)
      throw new Error(
        "Voice artifact exceeds its size limit; no transcript was truncated or replaced.",
      );
    try {
      const stat = await lstat(path);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1 ||
        stat.mode & 0o077 ||
        (process.getuid && stat.uid !== process.getuid())
      )
        throw new Error("Voice artifact target is unsafe.");
    } catch (error) {
      if (code(error) !== "ENOENT") throw error;
    }
    const temporary = `${path}.${randomUUID()}.tmp`;
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
        await file.writeFile(serialized);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, path);
      await this.syncDirectory(resolve(path, ".."));
    } finally {
      await unlink(temporary).catch((error) => {
        if (code(error) !== "ENOENT") throw error;
      });
    }
  }

  private run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.disposed || this.disposing)
      return Promise.reject(new Error("Voice artifact storage is disposed."));
    const result = this.tail.then(async () => {
      await this.directory(this.options.directory);
      await this.directory(join(this.options.directory, "threads"));
      return operation();
    });
    this.tail = result.then(
      () => {},
      (error: unknown) => {
        this.pendingFailure ??= error;
      },
    );
    return result;
  }

  private binding(binding: RuntimeBinding, callId?: string) {
    if (
      !binding ||
      ![
        binding.projectId,
        binding.agentId,
        binding.threadId,
        binding.sessionId,
      ].every(id) ||
      binding.projectId !== this.options.projectId ||
      (callId !== undefined && !id(callId))
    )
      throw new Error(
        "Voice artifact binding does not identify this exact project and call.",
      );
  }

  private async threadDirectory(
    agentId: string,
    threadId: string,
    create = false,
  ): Promise<string | null> {
    if (!id(agentId) || !id(threadId))
      throw new Error("Voice history requires an exact agent and thread.");
    const path = join(
      this.options.directory,
      "threads",
      scopeKey(this.options.projectId, agentId, threadId),
    );
    try {
      await this.directory(path, create);
      if (create)
        await this.syncDirectory(join(this.options.directory, "threads"));
    } catch (error) {
      if (!create && code(error) === "ENOENT") return null;
      throw error;
    }
    return path;
  }

  private async references(path: string): Promise<FileReference[]> {
    const files: FileReference[] = [];
    const calls = new Set<string>();
    for (const name of await readdir(path)) {
      // Incomplete atomic-write files are never displayed or treated as committed.
      if (/\.json\.[a-f0-9-]{36}\.tmp$/.test(name)) continue;
      const ref = reference(name);
      if (!ref || calls.has(ref.call))
        throw new Error("Voice artifact file identity is ambiguous.");
      calls.add(ref.call);
      files.push(ref);
    }
    if (files.length > MAX_CALLS_PER_THREAD)
      throw new Error("Voice artifact call-count limit exceeded.");
    return files.sort((a, b) =>
      a.order < b.order ? 1 : a.order > b.order ? -1 : 0,
    );
  }

  private async readArtifact(
    path: string,
    ref: FileReference,
  ): Promise<StoredArtifact> {
    const value = await this.readJson(join(path, ref.name));
    if (
      !object(value) ||
      !exactKeys(value, ["schema", "ownerUserId", "sessionId", "artifact"]) ||
      value.schema !== 1 ||
      value.ownerUserId !== this.options.ownerUserId ||
      !id(value.sessionId) ||
      !validateArtifact(value.artifact)
    )
      throw new Error("Voice artifact data is malformed.");
    const artifact = value.artifact;
    if (
      artifact.projectId !== this.options.projectId ||
      artifact.id !== `voice-${artifactKey(artifact)}` ||
      ref.artifact !== artifactKey(artifact) ||
      ref.call !== callKey(artifact) ||
      !ref.order.startsWith(`${Date.parse(artifact.createdAt)}-`) ||
      path !==
        join(
          this.options.directory,
          "threads",
          scopeKey(artifact.projectId, artifact.agentId, artifact.threadId),
        ) ||
      (ref.state !== "active" && ref.state !== artifact.state)
    )
      throw new Error(
        "Voice artifact identity conflicts with its storage reference.",
      );
    return value as unknown as StoredArtifact;
  }

  private async finish(
    path: string,
    ref: FileReference,
    stored: StoredArtifact,
    interrupted: boolean,
  ) {
    if (stored.artifact.state === "active") {
      stored.artifact.state = interrupted ? "interrupted" : "closed";
      stored.artifact.updatedAt = new Date().toISOString();
      await this.writeJson(join(path, ref.name), stored);
    }
    const target = `${prefix[stored.artifact.state]}-${ref.order}.json`;
    if (target !== ref.name) {
      await rename(join(path, ref.name), join(path, target));
      await this.syncDirectory(path);
    }
  }

  private async interruptActive() {
    const threads = join(this.options.directory, "threads");
    await this.directory(this.options.directory);
    await this.directory(threads);
    for (const name of await readdir(threads)) {
      if (!/^[a-f0-9]{64}$/.test(name))
        throw new Error("Voice artifact thread directory is malformed.");
      const path = join(threads, name);
      await this.directory(path);
      // File names carry lifecycle state; closed call content is not loaded at startup.
      for (const ref of await this.references(path))
        if (ref.state === "active")
          await this.finish(
            path,
            ref,
            await this.readArtifact(path, ref),
            true,
          );
    }
  }

  record(input: VoiceTranscriptRecord): Promise<void> {
    if (this.disposed || this.disposing)
      return Promise.reject(new Error("Voice artifact storage is disposed."));
    this.binding(input.binding, input.callId);
    if (
      ![input.voiceSessionId, input.realtimeSessionId, input.itemId].every(
        id,
      ) ||
      (input.role !== "user" && input.role !== "assistant") ||
      typeof input.text !== "string" ||
      input.text.length > MAX_TEXT ||
      typeof input.done !== "boolean" ||
      typeof input.delta !== "boolean" ||
      (input.done && input.delta) ||
      !timestamp(input.observedAt)
    )
      return Promise.reject(
        new Error(
          "Only bounded, identified native transcript snapshots or deltas can be recorded.",
        ),
      );
    const event = structuredClone(input);
    const pendingKey = JSON.stringify([
      event.binding.projectId,
      event.binding.agentId,
      event.binding.threadId,
      event.binding.sessionId,
      event.callId,
      event.voiceSessionId,
      event.realtimeSessionId,
      event.itemId,
    ]);
    const previous = this.pendingRecords.get(pendingKey);
    if (previous) {
      if (previous.event.role !== event.role)
        return Promise.reject(
          new Error("A native voice item cannot change speaker role."),
        );
      if (previous.event.done) {
        if (event.done && event.text !== previous.event.text)
          return Promise.reject(
            new Error("Conflicting completed native voice transcript."),
          );
        return previous.promise;
      }
      const text = event.delta ? previous.event.text + event.text : event.text;
      if (text.length > MAX_TEXT)
        return Promise.reject(
          new Error(
            "Voice transcript item limit reached; no text was truncated.",
          ),
        );
      previous.event = event.delta
        ? { ...previous.event, text }
        : { ...event, observedAt: previous.event.observedAt };
      return previous.promise;
    }
    if (this.pendingRecords.size >= MAX_PENDING_ITEMS)
      return Promise.reject(
        new Error(
          "Voice artifact write queue is full; this call may be incomplete.",
        ),
      );
    const queued = { event, promise: Promise.resolve() };
    this.pendingRecords.set(pendingKey, queued);
    queued.promise = this.run(async () => {
      this.pendingRecords.delete(pendingKey);
      const event = queued.event;
      const path = (await this.threadDirectory(
        event.binding.agentId,
        event.binding.threadId,
        true,
      ))!;
      const identity = {
        ...event.binding,
        callId: event.callId,
        voiceSessionId: event.voiceSessionId,
        realtimeSessionId: event.realtimeSessionId,
      };
      const refs = await this.references(path);
      const ref = refs.find((entry) => entry.call === callKey(identity));
      const createdAt = new Date().toISOString();
      const stored: StoredArtifact = ref
        ? await this.readArtifact(path, ref)
        : {
            schema: 1,
            ownerUserId: this.options.ownerUserId,
            sessionId: event.binding.sessionId,
            artifact: {
              id: `voice-${artifactKey(identity)}`,
              projectId: event.binding.projectId,
              agentId: event.binding.agentId,
              threadId: event.binding.threadId,
              callId: event.callId,
              voiceSessionId: event.voiceSessionId,
              realtimeSessionId: event.realtimeSessionId,
              createdAt,
              updatedAt: createdAt,
              state: "active",
              items: [],
            },
          };
      const artifact = stored.artifact;
      if (
        artifact.id !== `voice-${artifactKey(identity)}` ||
        stored.sessionId !== event.binding.sessionId
      )
        throw new Error(
          "Voice call identity cannot be rebound to another native or runtime session.",
        );
      const existing = artifact.items.find(
        (item) => item.itemId === event.itemId,
      );
      if (existing && existing.role !== event.role)
        throw new Error("A native voice item cannot change speaker role.");
      if (existing?.done) {
        if (!event.done) return; // Late partials never replace the complete native snapshot.
        if (existing.text !== event.text)
          throw new Error("Conflicting completed native voice transcript.");
        return;
      }
      // Native completion may follow its call-closed notification. It may finish
      // an already observed item, but cannot create items or reactivate the call.
      if (artifact.state !== "active" && (!existing || !event.done))
        throw new Error(
          "An ended voice artifact cannot accept new or incomplete transcript data.",
        );
      if (!existing && event.delta)
        throw new Error(
          "A voice delta requires its identified initial snapshot.",
        );
      if (!existing && artifact.items.length >= MAX_ITEMS)
        throw new Error(
          "Voice artifact item limit reached; no items were evicted.",
        );
      if (!ref && refs.length >= MAX_CALLS_PER_THREAD)
        throw new Error("Voice artifact call-count limit reached.");
      const text = event.delta ? existing!.text + event.text : event.text;
      if (text.length > MAX_TEXT)
        throw new Error(
          "Voice transcript item limit reached; no text was truncated.",
        );
      const item = {
        itemId: event.itemId,
        role: event.role,
        text,
        done: event.done,
        ordinal: existing?.ordinal ?? artifact.items.length,
        observedAt: existing?.observedAt ?? event.observedAt,
      };
      if (existing) artifact.items[existing.ordinal] = item;
      else artifact.items.push(item);
      artifact.updatedAt = new Date().toISOString();
      await this.writeJson(
        join(
          path,
          ref?.name ??
            `a-${Date.parse(createdAt)}-${callKey(identity)}-${artifactKey(identity)}.json`,
        ),
        stored,
      );
    }).finally(() => {
      if (this.pendingRecords.get(pendingKey) === queued)
        this.pendingRecords.delete(pendingKey);
    });
    return queued.promise;
  }

  closeCall(
    binding: RuntimeBinding,
    callId: string,
    interrupted = false,
  ): Promise<void> {
    this.binding(binding, callId);
    const exact = structuredClone(binding);
    return this.run(async () => {
      const path = await this.threadDirectory(exact.agentId, exact.threadId);
      if (!path) return; // Calls without any typed transcript create no empty artifact.
      const ref = (await this.references(path)).find(
        (entry) => entry.call === callKey({ ...exact, callId }),
      );
      if (!ref) return;
      const stored = await this.readArtifact(path, ref);
      if (stored.sessionId !== exact.sessionId)
        throw new Error(
          "Voice closure does not identify the recorded runtime session.",
        );
      await this.finish(path, ref, stored, interrupted);
    });
  }

  list(
    agentId: string,
    threadId: string,
    cursor?: string,
  ): Promise<{
    artifacts: VoiceTranscriptArtifact[];
    nextCursor: string | null;
  }> {
    return this.run(async () => {
      const scope = scopeKey(this.options.projectId, agentId, threadId);
      let after: string | null = null;
      if (cursor !== undefined) {
        if (
          typeof cursor !== "string" ||
          cursor.length > 1024 ||
          !/^[A-Za-z0-9_-]+$/.test(cursor)
        )
          throw new Error("Invalid voice history cursor.");
        const value: unknown = JSON.parse(
          Buffer.from(cursor, "base64url").toString("utf8"),
        );
        if (
          !object(value) ||
          !exactKeys(value, ["scope", "after"]) ||
          value.scope !== scope ||
          typeof value.after !== "string" ||
          !/^\d{13}-[a-f0-9]{64}-[a-f0-9]{64}$/.test(value.after)
        )
          throw new Error(
            "Voice history cursor belongs to another thread or is malformed.",
          );
        after = value.after;
      }
      const path = await this.threadDirectory(agentId, threadId);
      if (!path) return { artifacts: [], nextCursor: null };
      const refs = (await this.references(path)).filter(
        (ref) => !after || ref.order < after,
      );
      const page = refs.slice(0, PAGE_SIZE);
      const artifacts: VoiceTranscriptArtifact[] = [];
      for (const ref of page)
        artifacts.push((await this.readArtifact(path, ref)).artifact);
      return {
        artifacts,
        nextCursor:
          refs.length > PAGE_SIZE
            ? Buffer.from(
                JSON.stringify({ scope, after: page.at(-1)!.order }),
              ).toString("base64url")
            : null,
      };
    });
  }

  async flush(): Promise<void> {
    await this.tail;
    if (this.pendingFailure !== null) {
      const error = this.pendingFailure;
      this.pendingFailure = null;
      throw error;
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    if (this.disposing)
      throw new Error("Voice artifact disposal is already pending.");
    this.disposing = true;
    try {
      await this.flush();
      await this.interruptActive();
    } finally {
      this.disposed = true;
    }
  }
}
