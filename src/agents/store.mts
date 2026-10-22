import { constants } from "node:fs";
import {
  mkdir,
  open,
  lstat,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { Ajv } from "ajv";
import type {
  Agent,
  AgentContent,
  AgentMessage,
  ExecutionReservation,
  HelpRequest,
  Job,
  JsonObject,
  MessageReceipt,
  PreparationReadiness,
  ProjectAgentSettings,
} from "./contracts.mjs";

export interface FoundationState {
  schema: 1;
  projectId: string;
  ownerUserId: string;
  agents: Agent[];
  projectSettings: ProjectAgentSettings;
  provisioning: {
    agentId: string;
    presetId: string;
    presetRevision: number;
    creator: import("./contracts.mjs").Actor;
    state: "pending" | "ready" | "failed";
    error: string | null;
  }[];
  jobs: Job[];
  messages: AgentMessage[];
  /** Compact intent identity survives removal of acknowledged message bodies. */
  intentFingerprints: Record<string, string>;
  receipts: MessageReceipt[];
  /** Native realtime promotion identity only; never a second transcript store. */
  voiceTurns: {
    agentId: string;
    sessionId: string;
    threadId: string;
    voiceSessionId: string;
    realtimeSessionId: string;
    turnId: string;
    nativeItemId: string;
    ownerUserId: string;
    observedAt: string;
  }[];
  helpRequests: HelpRequest[];
  ownerInbox: { helpRequestId: string; content: AgentContent[] }[];
  nativeApprovals: {
    agentId: string;
    sessionId: string;
    threadId: string;
    approvalId: string;
    turnId: string;
    request: JsonObject;
    state: "pending" | "responding" | "uncertain";
  }[];
  nativeStartAttempts: {
    sessionId: string;
    agentId: string;
    dispatched: boolean;
  }[];
  preparation: {
    reason: "quit" | "restart" | "update";
    readiness: PreparationReadiness[];
    requestedAt: string;
  } | null;
  reservation: ExecutionReservation | null;
}

// Runtime validation is deliberately independent of TypeScript's erased types.
type Schema = Record<string, unknown>;
const text = (maxLength = 200_000): Schema => ({ type: "string", maxLength });
const id: Schema = {
  type: "string",
  minLength: 1,
  maxLength: 512,
  pattern: "^[^\\u0000-\\u001f\\u007f]+$",
};
const timestamp: Schema = {
  type: "string",
  pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?Z$",
};
const choice = (...values: (string | number | boolean)[]): Schema => ({
  enum: values,
});
const nullable = (value: Schema): Schema => ({
  anyOf: [value, { type: "null" }],
});
const array = (items: Schema, maxItems = 100_000): Schema => ({
  type: "array",
  items,
  maxItems,
});
const object = (
  properties: Record<string, Schema>,
  optional: string[] = [],
): Schema => ({
  type: "object",
  properties,
  required: Object.keys(properties).filter((key) => !optional.includes(key)),
  additionalProperties: false,
});
const revision: Schema = {
  type: "integer",
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER,
};
const actor = {
  oneOf: [
    object({ type: choice("user"), userId: id }),
    object({ type: choice("agent"), agentId: id }),
  ],
};
const references = array(object({ id, revision }), 1000);
const json: Schema = { $ref: "#/$defs/json" };
const runtimeError = nullable(
  object({
    code: choice(
      "unsupported",
      "missing_thread",
      "identity_mismatch",
      "configuration_rejected",
      "isolation_blocked",
      "disconnected",
      "native_approval_required",
      "cancelled",
      "runtime_error",
    ),
    message: text(2000),
  }),
);
const content = array(
  {
    oneOf: [
      object({ type: choice("text"), text: text() }),
      object({
        type: choice("image"),
        fileRef: id,
        caption: nullable(text(10_000)),
      }),
      object({
        type: choice("file"),
        fileRef: id,
        name: text(1000),
        mediaType: text(200),
      }),
      object({ type: choice("data"), value: json }),
    ],
  },
  100,
);
const links = array(object({ label: text(1000), url: text(4096) }), 100);
const assignment = object({
  assignedBy: actor,
  assignedToAgentId: nullable(id),
  instruction: nullable(text()),
});
const progress = object({
  status: choice(
    "not_started",
    "in_progress",
    "blocked",
    "ready",
    "completed",
    "cancelled",
  ),
  label: nullable(text(1000)),
  detail: nullable(text()),
  percent: nullable({ type: "number", minimum: 0, maximum: 100 }),
  reportedByAgentId: nullable(id),
  reportedAt: nullable(timestamp),
});
const agent = object({
  id,
  projectId: id,
  createdAt: timestamp,
  updatedAt: timestamp,
  archivedAt: nullable(timestamp),
  profile: object({
    revision,
    name: text(1000),
    pictureRef: nullable(id),
    personality: text(),
    systemPrompt: text(),
  }),
  skills: array(object({ skillId: id, enabled: { type: "boolean" } }), 1000),
  access: object({
    permissionGroupIds: array(id, 1000),
    serviceConnectionIds: array(id, 1000),
    inheritPersonalServiceCredentials: choice(false),
  }),
  runtime: object({
    provider: choice("codex"),
    modelAccessId: id,
    configRef: id,
    threadId: nullable(id),
    session: object(
      {
        sessionId: nullable(id),
        desiredState: choice("started", "stopped"),
        observedState: choice(
          "stopped",
          "starting",
          "started",
          "stopping",
          "error",
          "unknown",
        ),
        activeTurnId: nullable(id),
        startedAt: nullable(timestamp),
        lastObservedAt: nullable(timestamp),
        lastError: runtimeError,
        appliedConfiguration: nullable(
          object(
            {
              profileRevision: revision,
              instructionsDigest: { type: "string", pattern: "^[a-f0-9]{64}$" },
              permissionGroups: references,
              serviceConnections: references,
              skills: references,
              runtimeConfigRevision: revision,
              appliedAt: timestamp,
            },
            ["instructionsDigest"],
          ),
        ),
        instructionPreparation: nullable(
          object({
            state: choice("compacting", "completed", "failed", "uncertain"),
            threadId: id,
            turnId: nullable(id),
            itemId: nullable(id),
            startedAt: timestamp,
            completedAt: nullable(timestamp),
            error: runtimeError,
          }),
        ),
      },
      ["instructionPreparation"],
    ),
  }),
  scratchpad: object({ markdown: text(), revision, updatedAt: timestamp }),
  reportsTo: actor,
  resources: array(
    object({
      id,
      kind: text(200),
      location: text(4096),
      metadata: { type: "object", additionalProperties: json },
    }),
    1000,
  ),
});
const job = object({
  id,
  projectId: id,
  createdAt: timestamp,
  updatedAt: timestamp,
  assignment,
  progress,
  assignmentHistory: array(
    object({
      id,
      recordedAt: timestamp,
      changedBy: actor,
      previousAgentId: nullable(id),
      assignedAgentId: nullable(id),
      instruction: nullable(text()),
    }),
  ),
  work: {
    oneOf: [
      object({
        type: choice("ticket"),
        ticket: object({
          provider: choice("linear", "github"),
          connectionId: id,
          externalId: id,
          url: text(4096),
        }),
      }),
      object({
        type: choice("local"),
        title: text(1000),
        objective: text(),
        updates: array(
          object({
            id,
            recordedByAgentId: id,
            recordedAt: timestamp,
            kind: text(200),
            text: text(),
            links,
          }),
        ),
        outcome: nullable(
          object({
            summary: text(),
            links,
            recordedByAgentId: id,
            recordedAt: timestamp,
          }),
        ),
      }),
    ],
  },
});
const sender = {
  oneOf: [
    ...actor.oneOf,
    object({
      type: choice("system"),
      source: choice("schedule", "preparation"),
      sourceId: id,
    }),
  ],
};
const message = object({
  id,
  projectId: id,
  sender,
  visibility: choice("public", "private"),
  recipientAgentId: id,
  jobId: nullable(id),
  replyToMessageId: nullable(id),
  kind: choice("message", "assignment", "help_request", "result"),
  content,
  deliveryMode: choice("queue", "steer"),
  createdAt: timestamp,
  delivery: object({
    state: choice("queued", "sending", "delivered", "uncertain", "failed"),
    attempts: array(
      object({
        id,
        sessionId: id,
        threadId: id,
        turnId: nullable(id),
        attemptedAt: timestamp,
        outcome: choice("pending", "acknowledged", "not_sent", "uncertain"),
        runtimeMessageRef: nullable(id),
      }),
    ),
    runtimeMessageRef: nullable(id),
    deliveredAt: nullable(timestamp),
    error: runtimeError,
  }),
});
const readiness = object({
  preparationId: id,
  requiredAfter: timestamp,
  agentId: id,
  sessionId: id,
  state: choice("pending", "ready", "blocked"),
  continuationSavedAt: nullable(timestamp),
  detail: nullable(text(2000)),
});
const reason = choice("quit", "restart", "update");
const validate = new Ajv({
  strict: true,
  allErrors: false,
}).compile<FoundationState>({
  ...object({
    schema: choice(1),
    projectId: id,
    ownerUserId: id,
    agents: array(agent),
    jobs: array(job),
    messages: array(message),
    intentFingerprints: {
      type: "object",
      propertyNames: id,
      additionalProperties: { type: "string", pattern: "^[a-f0-9]{64}$" },
      maxProperties: 100_000,
    },
    receipts: array(
      object({
        messageId: id,
        sender,
        visibility: choice("public", "private"),
        turnId: id,
        recipientAgentId: id,
        jobId: nullable(id),
        sessionId: id,
        threadId: id,
        attemptId: id,
        runtimeMessageRef: nullable(id),
        acknowledgedAt: timestamp,
      }),
    ),
    voiceTurns: array(
      object({
        agentId: id,
        sessionId: id,
        threadId: id,
        voiceSessionId: id,
        realtimeSessionId: id,
        turnId: id,
        nativeItemId: id,
        ownerUserId: id,
        observedAt: timestamp,
      }),
    ),
    helpRequests: array(
      object({
        id,
        projectId: id,
        requesterAgentId: id,
        target: actor,
        jobId: nullable(id),
        messageId: id,
        replyToHelpRequestId: nullable(id),
        state: choice("open", "answered", "escalated", "cancelled"),
        responseMessageId: nullable(id),
        createdAt: timestamp,
      }),
    ),
    projectSettings: object({
      projectId: id,
      revision,
      primaryAgentId: nullable(id),
    }),
    provisioning: array(
      object({
        agentId: id,
        presetId: id,
        presetRevision: revision,
        creator: actor,
        state: choice("pending", "ready", "failed"),
        error: nullable(text()),
      }),
    ),
    ownerInbox: array(object({ helpRequestId: id, content })),
    nativeApprovals: array(
      object({
        agentId: id,
        sessionId: id,
        threadId: id,
        approvalId: id,
        turnId: id,
        request: { type: "object", additionalProperties: json },
        state: choice("pending", "responding", "uncertain"),
      }),
    ),
    preparation: nullable(
      object({ reason, readiness: array(readiness), requestedAt: timestamp }),
    ),
    nativeStartAttempts: array(
      object({ sessionId: id, agentId: id, dispatched: { type: "boolean" } }),
    ),
    reservation: nullable(
      object({ id, projectId: id, reason, acquiredAt: timestamp }),
    ),
  }),
  $defs: {
    json: {
      anyOf: [
        { type: "null" },
        { type: "boolean" },
        { type: "number" },
        { type: "string", maxLength: 200_000 },
        { type: "array", items: json, maxItems: 10_000 },
        { type: "object", additionalProperties: json, maxProperties: 10_000 },
      ],
    },
  },
});

function validateJson(
  value: unknown,
  ancestors = new Set<object>(),
  depth = 0,
): void {
  if (depth > 40) throw new Error("Foundation data exceeds its nesting limit.");
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return;
  if (
    typeof value !== "object" ||
    ancestors.has(value) ||
    (!Array.isArray(value) &&
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null) ||
    Object.getOwnPropertySymbols(value).length > 0
  )
    throw new Error("Foundation records must contain plain JSON data.");
  ancestors.add(value);
  for (const child of Object.values(value))
    validateJson(child, ancestors, depth + 1);
  ancestors.delete(value);
}

/** Private chat-intent digest, unrelated to the gateway's operation fingerprint. */
export function messageIntentFingerprint(
  intent: Pick<
    AgentMessage,
    | "sender"
    | "recipientAgentId"
    | "jobId"
    | "replyToMessageId"
    | "kind"
    | "content"
    | "deliveryMode"
  >,
): string {
  const fields = {
    sender: intent.sender,
    recipientAgentId: intent.recipientAgentId,
    jobId: intent.jobId,
    replyToMessageId: intent.replyToMessageId,
    kind: intent.kind,
    content: intent.content,
    deliveryMode: intent.deliveryMode,
  };
  validateJson(fields);
  const canonical = (value: unknown): string => {
    if (value === null || typeof value !== "object")
      return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    const objectValue = value as Record<string, unknown>;
    return `{${Object.keys(objectValue)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(objectValue[key])}`)
      .join(",")}}`;
  };
  return createHash("sha256").update(canonical(fields)).digest("hex");
}

function validateState(
  value: unknown,
  projectId: string,
  ownerUserId: string,
): asserts value is FoundationState {
  validateJson(value);
  if (
    !validate(value) ||
    value.projectId !== projectId ||
    value.ownerUserId !== ownerUserId
  )
    throw new Error("Invalid or mismatched foundation state.");
  const agents = new Map(value.agents.map((entry) => [entry.id, entry]));
  const jobs = new Set(value.jobs.map((entry) => entry.id));
  const help = new Map(value.helpRequests.map((entry) => [entry.id, entry]));
  const messages = new Set([
    ...value.messages.map((entry) => entry.id),
    ...value.receipts.map((entry) => entry.messageId),
    ...value.helpRequests.map((entry) => entry.messageId),
  ]);
  const assert = (valid: boolean): void => {
    if (!valid) throw new Error("Invalid foundation record reference.");
  };
  const checkAgent = (agentId: string | null): void =>
    assert(agentId === null || agents.has(agentId));
  const checkActor = (actorValue: Agent["reportsTo"]): void =>
    actorValue.type === "user"
      ? assert(actorValue.userId === ownerUserId)
      : checkAgent(actorValue.agentId);
  const checkJob = (jobId: string | null): void =>
    assert(jobId === null || jobs.has(jobId));
  const checkMessage = (messageId: string | null): void =>
    assert(messageId === null || messages.has(messageId));
  assert(
    agents.size === value.agents.length &&
      jobs.size === value.jobs.length &&
      help.size === value.helpRequests.length,
  );
  assert(
    new Set(value.messages.map((entry) => entry.id)).size ===
      value.messages.length,
  );
  assert(
    new Set(value.receipts.map((entry) => entry.messageId)).size ===
      value.receipts.length,
  );
  assert(value.projectSettings.projectId === projectId);
  checkAgent(value.projectSettings.primaryAgentId);
  for (const entry of value.provisioning) {
    checkAgent(entry.agentId);
    checkActor(entry.creator);
  }
  assert(
    new Set(value.provisioning.map((entry) => entry.agentId)).size ===
      value.provisioning.length,
  );
  for (const entry of value.agents) {
    assert(entry.projectId === projectId);
    const preparation = entry.runtime.session.instructionPreparation;
    if (preparation) {
      assert(preparation.threadId === entry.runtime.threadId);
      assert(preparation.itemId === null || preparation.turnId !== null);
      if (preparation.state === "completed")
        assert(
          Boolean(
            preparation.turnId && preparation.itemId && preparation.completedAt,
          ) && preparation.error === null,
        );
    }
    checkActor(entry.reportsTo);
    assert(
      new Set(entry.skills.map((skill) => skill.skillId)).size ===
        entry.skills.length,
    );
    const visited = new Set([entry.id]);
    let next = entry.reportsTo;
    while (next.type === "agent") {
      assert(!visited.has(next.agentId));
      visited.add(next.agentId);
      const parent = agents.get(next.agentId);
      assert(Boolean(parent));
      if (!parent) break;
      next = parent.reportsTo;
    }
  }
  for (const entry of value.jobs) {
    assert(entry.projectId === projectId);
    checkActor(entry.assignment.assignedBy);
    checkAgent(entry.assignment.assignedToAgentId);
    checkAgent(entry.progress.reportedByAgentId);
    for (const change of entry.assignmentHistory) {
      checkActor(change.changedBy);
      checkAgent(change.previousAgentId);
      checkAgent(change.assignedAgentId);
    }
    if (entry.work.type === "local") {
      for (const update of entry.work.updates)
        checkAgent(update.recordedByAgentId);
      if (entry.work.outcome) checkAgent(entry.work.outcome.recordedByAgentId);
    }
  }
  for (const entry of value.messages) {
    assert(entry.projectId === projectId);
    if (entry.sender.type !== "system") checkActor(entry.sender);
    checkAgent(entry.recipientAgentId);
    checkJob(entry.jobId);
    checkMessage(entry.replyToMessageId);
  }
  for (const entry of value.receipts) {
    if (entry.sender.type !== "system") checkActor(entry.sender);
    checkAgent(entry.recipientAgentId);
    checkJob(entry.jobId);
  }
  for (const entry of value.voiceTurns) {
    checkAgent(entry.agentId);
    assert(entry.ownerUserId === ownerUserId);
  }
  assert(
    new Set(
      value.voiceTurns.map((entry) =>
        JSON.stringify([
          entry.agentId,
          entry.threadId,
          entry.turnId,
          entry.nativeItemId,
        ]),
      ),
    ).size === value.voiceTurns.length,
  );
  for (const entry of value.helpRequests) {
    assert(entry.projectId === projectId);
    checkAgent(entry.requesterAgentId);
    checkActor(entry.target);
    checkJob(entry.jobId);
    checkMessage(entry.messageId);
    checkMessage(entry.responseMessageId);
    assert(
      entry.replyToHelpRequestId === null ||
        help.has(entry.replyToHelpRequestId),
    );
  }
  for (const entry of value.ownerInbox)
    assert(help.get(entry.helpRequestId)?.target.type === "user");
  for (const entry of value.nativeApprovals) checkAgent(entry.agentId);
  for (const entry of value.nativeStartAttempts) checkAgent(entry.agentId);
  assert(
    new Set(value.nativeStartAttempts.map((entry) => entry.sessionId)).size ===
      value.nativeStartAttempts.length,
  );
  for (const entry of value.preparation?.readiness ?? [])
    checkAgent(entry.agentId);
  assert(
    value.reservation === null || value.reservation.projectId === projectId,
  );
}

/** One trusted controller owns this file. An abandoned lock requires explicit recovery. */
export class FoundationStore {
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private failed = false;
  private closing: Promise<void> | null = null;
  private readonly listeners = new Set<() => void>();
  private constructor(
    private readonly directory: string,
    private readonly lock: FileHandle,
    private state: FoundationState,
  ) {}

  static async open(input: {
    directory: string;
    projectId: string;
    ownerUserId: string;
  }): Promise<FoundationStore> {
    if (!isAbsolute(input.directory))
      throw new Error("Foundation directory must be an absolute trusted path.");
    const initial: FoundationState = {
      schema: 1,
      projectId: input.projectId,
      ownerUserId: input.ownerUserId,
      agents: [],
      projectSettings: {
        projectId: input.projectId,
        revision: 1,
        primaryAgentId: null,
      },
      provisioning: [],
      jobs: [],
      messages: [],
      intentFingerprints: {},
      receipts: [],
      voiceTurns: [],
      helpRequests: [],
      ownerInbox: [],
      nativeApprovals: [],
      nativeStartAttempts: [],
      preparation: null,
      reservation: null,
    };
    validateState(initial, input.projectId, input.ownerUserId);
    await mkdir(input.directory, { recursive: true, mode: 0o700 });
    const directoryStat = await lstat(input.directory);
    if (
      !directoryStat.isDirectory() ||
      directoryStat.isSymbolicLink() ||
      (directoryStat.mode & 0o022) !== 0 ||
      (process.getuid && directoryStat.uid !== process.getuid())
    )
      throw new Error("Foundation directory ownership is unsafe.");
    let lock: FileHandle;
    try {
      lock = await open(
        join(input.directory, "foundation.lock"),
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
    } catch {
      throw new Error(
        "Foundation state is already owned or its writer lock is unavailable. Explicit recovery is required; no lock was removed.",
      );
    }
    const store = new FoundationStore(input.directory, lock, initial);
    try {
      await lock.writeFile(
        JSON.stringify({ pid: process.pid, token: randomUUID() }),
      );
      await lock.sync();
      let file: FileHandle | undefined;
      try {
        file = await open(
          join(input.directory, "foundation.json"),
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (file) {
        try {
          const stat = await file.stat();
          if (
            !stat.isFile() ||
            stat.nlink !== 1 ||
            (stat.mode & 0o077) !== 0 ||
            (process.getuid && stat.uid !== process.getuid()) ||
            stat.size > 32 * 1024 * 1024
          )
            throw new Error("Unsafe foundation state file.");
          const saved: unknown = JSON.parse(await file.readFile("utf8"));
          validateState(saved, input.projectId, input.ownerUserId);
          store.state = saved;
        } finally {
          await file.close();
        }
      } else await store.persist(initial);
      return store;
    } catch {
      await store.close().catch(() => undefined);
      throw new Error(
        "Foundation state could not be opened safely; existing records were not reset.",
      );
    }
  }

  snapshot(): FoundationState {
    return structuredClone(this.state);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  update<T>(mutation: (state: FoundationState) => T): Promise<T> {
    if (this.closed || this.failed)
      return Promise.reject(
        new Error("Foundation store is closed or requires recovery."),
      );
    const result = this.queue.then(async () => {
      if (this.failed) throw new Error("Foundation store requires recovery.");
      const draft = this.snapshot();
      const returned = mutation(draft);
      if (returned instanceof Promise)
        throw new Error("Foundation mutations must be synchronous.");
      validateState(draft, this.state.projectId, this.state.ownerUserId);
      // Clone before persistence to prevent retained mutation references changing committed state.
      const next = structuredClone(draft);
      const detachedResult = structuredClone(returned);
      try {
        await this.persist(next);
      } catch {
        this.failed = true;
        throw new Error(
          "Foundation persistence failed; further writes require recovery.",
        );
      }
      this.state = next;
      for (const listener of this.listeners) {
        try {
          listener();
        } catch {
          /* Observers cannot invalidate a committed write. */
        }
      }
      return detachedResult;
    });
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async ownsLock(): Promise<boolean> {
    try {
      const [held, current] = await Promise.all([
        this.lock.stat(),
        lstat(join(this.directory, "foundation.lock")),
      ]);
      return (
        current.isFile() && held.ino === current.ino && held.dev === current.dev
      );
    } catch {
      return false;
    }
  }

  private async persist(state: FoundationState): Promise<void> {
    if (!(await this.ownsLock()))
      throw new Error("Foundation writer ownership was lost.");
    const serialized = JSON.stringify(state);
    if (Buffer.byteLength(serialized) > 32 * 1024 * 1024)
      throw new Error("Foundation state exceeds its storage limit.");
    const temporary = join(this.directory, `foundation-${randomUUID()}.tmp`);
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
      await file.close();
      if (!(await this.ownsLock()))
        throw new Error("Foundation writer ownership was lost.");
      await rename(temporary, join(this.directory, "foundation.json"));
      const directory = await open(this.directory, constants.O_RDONLY);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      await file.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
    }
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      await this.queue;
      this.listeners.clear();
      try {
        if (await this.ownsLock())
          await unlink(join(this.directory, "foundation.lock"));
      } finally {
        await this.lock.close();
      }
    })();
    return this.closing;
  }
}
