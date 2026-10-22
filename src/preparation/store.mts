import { Ajv } from "ajv";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { withStateLock } from "../orchestration/state-lock.mjs";
import { readTask } from "../orchestration/store.mjs";
import { errorCode } from "../shared/errors.mjs";
import type {
  BeginPreparationInput,
  PreparationPlan,
  PreparationParticipant,
  PreparationParticipantInput,
  PreparationIdentity,
  PreparationActor,
  PreparationPhase,
  PreparationDelivery,
  ReportPreparationInput,
  PreparationRequest,
  PreparationResponse,
} from "./contracts.mjs";
const ajv = new Ajv({ strict: false });
const id = { type: "string", pattern: "^[a-zA-Z0-9_-]{1,160}$" };
const text = (maxLength: number) => ({
  type: "string",
  minLength: 1,
  maxLength,
});
const nullableId = { anyOf: [id, { type: "null" }] };
const participantProperties = {
  id,
  role: { enum: ["manager", "worker"] },
  taskId: nullableId,
  runId: nullableId,
  threadId: nullableId,
  requestId: id,
  required: { type: "boolean" },
  message: text(12000),
};
const participantFields = Object.keys(participantProperties);
const responseShape = {
  type: "object",
  additionalProperties: false,
  required: ["responseId", "state", "note", "at"],
  properties: {
    responseId: id,
    state: { enum: ["preparing", "ready", "needs-input", "blocked"] },
    note: text(12000),
    continuation: text(20000),
    at: text(80),
  },
};
const planShape = ajv.compile<PreparationPlan>({
  type: "object",
  additionalProperties: false,
  required: [
    "schema",
    "id",
    "purpose",
    "projectId",
    "phase",
    "participants",
    "createdAt",
    "updatedAt",
  ],
  properties: {
    schema: { const: 1 },
    id,
    purpose: { enum: ["update", "quit"] },
    projectId: id,
    phase: { enum: ["preparing", "ready", "canceled", "complete"] },
    createdAt: text(80),
    updatedAt: text(80),
    participants: {
      type: "array",
      maxItems: 256,
      items: {
        type: "object",
        additionalProperties: false,
        required: [...participantFields, "delivery", "response", "responses"],
        properties: {
          ...participantProperties,
          delivery: {
            type: "object",
            additionalProperties: false,
            required: ["state", "at"],
            properties: {
              state: {
                enum: [
                  "pending",
                  "attempted",
                  "acknowledged",
                  "failed",
                  "uncertain",
                ],
              },
              at: text(80),
              nativeTurnId: id,
              error: text(2000),
            },
          },
          response: { anyOf: [responseShape, { type: "null" }] },
          responses: { type: "array", maxItems: 256, items: responseShape },
        },
      },
    },
  },
});
const reportShape = ajv.compile<ReportPreparationInput>({
  type: "object",
  additionalProperties: false,
  required: [
    "preparationId",
    "participantId",
    "requestId",
    "responseId",
    "state",
    "note",
  ],
  properties: {
    preparationId: id,
    participantId: id,
    requestId: id,
    responseId: id,
    state: { enum: ["preparing", "ready", "needs-input", "blocked"] },
    note: text(12000),
    continuation: text(20000),
  },
});
function validId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,160}$/.test(value))
    throw new Error("Invalid preparation identity");
}
export function parsePreparation(value: unknown): PreparationPlan {
  if (!planShape(value))
    throw new Error(
      "Preparation state is malformed; preserve its retained evidence",
    );
  if (
    !Number.isFinite(Date.parse(value.createdAt)) ||
    !Number.isFinite(Date.parse(value.updatedAt)) ||
    new Set(value.participants.map((p) => p.id)).size !==
      value.participants.length ||
    new Set(value.participants.map((p) => p.requestId)).size !==
      value.participants.length ||
    new Set(
      value.participants.map((p) =>
        p.role === "manager" ? "manager" : `worker:${p.taskId}:${p.runId}`,
      ),
    ).size !== value.participants.length
  )
    throw new Error("Preparation identity or timestamp is malformed");
  for (const participant of value.participants) {
    if (
      !participant.message.trim() ||
      !Number.isFinite(Date.parse(participant.delivery.at)) ||
      (participant.role === "manager"
        ? participant.taskId !== null || participant.runId !== null
        : !participant.taskId || (participant.required && !participant.runId))
    )
      throw new Error("Preparation participant binding is malformed");
    if (
      new Set(participant.responses.map((r) => r.responseId)).size !==
        participant.responses.length ||
      participant.responses.some(
        (r) =>
          !r.note.trim() ||
          !Number.isFinite(Date.parse(r.at)) ||
          (r.continuation !== undefined && !r.continuation.trim()),
      ) ||
      JSON.stringify(participant.response) !==
        JSON.stringify(participant.responses.at(-1) || null)
    )
      throw new Error("Preparation response history is malformed");
  }
  return value;
}
const file = (stateDir: string) => path.join(stateDir, "preparation.json");
export async function readPreparation(
  stateDir: string,
): Promise<PreparationPlan | null> {
  try {
    const raw = await fs.readFile(file(stateDir), "utf8");
    if (Buffer.byteLength(raw) > 8388608)
      throw new Error("Preparation state exceeds its bound");
    const value: unknown = JSON.parse(raw);
    return parsePreparation(value);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    if (error instanceof SyntaxError)
      throw new Error(
        "Preparation state is malformed; preserve its retained evidence",
      );
    throw error;
  }
}
async function writeAtomic(target: string, serialized: string) {
  const temp = `${target}.${randomUUID()}.tmp`;
  if (Buffer.byteLength(serialized) > 8388608)
    throw new Error("Preparation state exceeds its bound");
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  try {
    const handle = await fs.open(temp, "wx", 0o600);
    try {
      await handle.writeFile(serialized);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temp, target);
    const directory = await fs.open(path.dirname(target), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await fs.unlink(temp).catch((error) => {
      if (errorCode(error) !== "ENOENT") throw error;
    });
  }
}
async function save(stateDir: string, plan: PreparationPlan) {
  plan.updatedAt = new Date().toISOString();
  parsePreparation(plan);
  await writeAtomic(file(stateDir), JSON.stringify(plan, null, 2) + "\n");
  return structuredClone(plan);
}
function participant(
  plan: PreparationPlan,
  identity: PreparationIdentity,
): PreparationParticipant {
  validId(identity.preparationId);
  validId(identity.participantId);
  validId(identity.requestId);
  const found = plan.participants.find((p) => p.id === identity.participantId);
  if (
    plan.id !== identity.preparationId ||
    !found ||
    found.requestId !== identity.requestId
  )
    throw new Error("Stale or changed preparation request");
  return found;
}
const inputParticipant = (
  p: PreparationParticipantInput,
): PreparationParticipantInput => ({
  id: p.id,
  role: p.role,
  taskId: p.taskId,
  runId: p.runId,
  threadId: p.threadId,
  requestId: p.requestId,
  required: p.required,
  message: p.message,
});
export async function beginPreparation(
  stateDir: string,
  input: BeginPreparationInput,
) {
  const at = new Date().toISOString();
  const candidate: PreparationPlan = {
    schema: 1,
    id: input.id,
    purpose: input.purpose,
    projectId: input.projectId,
    phase: "preparing",
    participants: input.participants.map((p) => ({
      ...inputParticipant(p),
      delivery: { state: "pending", at },
      response: null,
      responses: [],
    })),
    createdAt: at,
    updatedAt: at,
  };
  parsePreparation(candidate);
  return withStateLock(stateDir, ".preparation.lock", async () => {
    const existing = await readPreparation(stateDir);
    if (existing?.id === input.id) {
      if (
        existing.purpose !== input.purpose ||
        existing.projectId !== input.projectId ||
        JSON.stringify(existing.participants.map(inputParticipant)) !==
          JSON.stringify(candidate.participants.map(inputParticipant))
      )
        throw new Error("Preparation ID reused with changed content");
      return existing;
    }
    if (existing && !["canceled", "complete"].includes(existing.phase))
      throw new Error("Another preparation is still holding this project");
    const history = path.join(stateDir, "preparations");
    const reused = await fs
      .stat(path.join(history, `${candidate.id}.json`))
      .then(
        () => true,
        (error) => {
          if (errorCode(error) === "ENOENT") return false;
          throw error;
        },
      );
    if (reused)
      throw new Error("Preparation ID belongs to retained historical evidence");
    if (existing)
      await writeAtomic(
        path.join(history, `${existing.id}.json`),
        JSON.stringify(existing, null, 2) + "\n",
      );
    return save(stateDir, candidate);
  });
}
export async function claimPreparationDelivery(
  stateDir: string,
  identity: PreparationIdentity,
): Promise<boolean> {
  return withStateLock(stateDir, ".preparation.lock", async () => {
    const plan = await readPreparation(stateDir);
    if (!plan) throw new Error("Preparation unavailable");
    const found = participant(plan, identity);
    if (!["preparing", "ready"].includes(plan.phase)) return false;
    if (!found.required || found.delivery.state !== "pending") return false;
    found.delivery = { state: "attempted", at: new Date().toISOString() };
    await save(stateDir, plan);
    return true;
  });
}
export async function recordPreparationDelivery(
  stateDir: string,
  identity: PreparationIdentity,
  delivery: {
    state: "acknowledged" | "failed" | "uncertain";
    nativeTurnId?: string;
    error?: string;
  },
) {
  return withStateLock(stateDir, ".preparation.lock", async () => {
    const plan = await readPreparation(stateDir);
    if (!plan) throw new Error("Preparation unavailable");
    const found = participant(plan, identity);
    if (
      !["acknowledged", "failed", "uncertain"].includes(delivery.state) ||
      (delivery.nativeTurnId !== undefined &&
        !/^[a-zA-Z0-9_-]{1,160}$/.test(delivery.nativeTurnId)) ||
      (delivery.error !== undefined &&
        (!delivery.error.trim() || delivery.error.length > 2000))
    )
      throw new Error("Invalid preparation delivery evidence");
    if (found.delivery.state !== "attempted") {
      if (
        found.delivery.state === delivery.state &&
        found.delivery.nativeTurnId === delivery.nativeTurnId &&
        found.delivery.error === delivery.error
      )
        return plan;
      throw new Error(
        "Preparation delivery has no matching unconfirmed attempt",
      );
    }
    found.delivery = { ...delivery, at: new Date().toISOString() };
    return save(stateDir, plan);
  });
}
async function scope(
  stateDir: string,
  plan: PreparationPlan,
  actor: PreparationActor,
  found: PreparationParticipant,
) {
  if (
    actor.role !== found.role ||
    (actor.role === "manager"
      ? actor.projectId !== plan.projectId
      : actor.projectId !== undefined && actor.projectId !== plan.projectId)
  )
    throw new Error("Preparation belongs to another role or project");
  if (actor.role === "worker") {
    if (actor.taskId !== found.taskId || actor.runId !== found.runId)
      throw new Error("Preparation belongs to another worker run");
    const task = await readTask(stateDir, actor.taskId);
    if (
      task.runId !== actor.runId ||
      task.projectId !== plan.projectId ||
      (found.threadId && task.threadId !== found.threadId)
    )
      throw new Error("Worker preparation context changed");
  } else if (actor.taskId !== undefined || actor.runId !== undefined)
    throw new Error("Manager preparation cannot use a worker binding");
}
export async function getPreparationRequest(
  stateDir: string,
  actor: PreparationActor,
): Promise<PreparationRequest | null> {
  const plan = await readPreparation(stateDir);
  if (!plan || !["preparing", "ready"].includes(plan.phase)) return null;
  const candidates = plan.participants.filter(
    (p) =>
      p.role === actor.role &&
      (actor.role === "manager" ||
        (p.taskId === actor.taskId && p.runId === actor.runId)),
  );
  if (candidates.length === 0) return null;
  if (candidates.length !== 1)
    throw new Error("Preparation participant is unavailable or ambiguous");
  const found = candidates[0];
  await scope(stateDir, plan, actor, found);
  return {
    preparationId: plan.id,
    participantId: found.id,
    requestId: found.requestId,
    purpose: plan.purpose,
    projectId: plan.projectId,
    participant: structuredClone(found),
  };
}
export async function reportPreparation(
  stateDir: string,
  actor: PreparationActor,
  input: ReportPreparationInput,
) {
  if (
    !reportShape(input) ||
    !input.note.trim() ||
    (input.continuation !== undefined && !input.continuation.trim())
  )
    throw new Error("Invalid preparation response");
  return withStateLock(stateDir, ".preparation.lock", async () => {
    const plan = await readPreparation(stateDir);
    if (!plan) throw new Error("Preparation unavailable");
    const found = participant(plan, input);
    if (plan.phase === "complete")
      throw new Error("Preparation has already completed");
    await scope(stateDir, plan, actor, found);
    const response = {
      responseId: input.responseId,
      state: input.state,
      note: input.note,
      ...(input.continuation === undefined
        ? {}
        : { continuation: input.continuation }),
    };
    const existing = found.responses.find(
      (r) => r.responseId === input.responseId,
    );
    if (existing) {
      const { at, ...content } = existing;
      if (JSON.stringify(content) !== JSON.stringify(response))
        throw new Error("Preparation response ID reused with changed content");
      return {
        ok: true,
        preparationId: plan.id,
        participantId: found.id,
        response: existing,
      };
    }
    if (!["preparing", "ready", "canceled"].includes(plan.phase))
      throw new Error("Preparation is no longer accepting responses");
    if (found.delivery.state === "pending" || found.delivery.state === "failed")
      throw new Error("Preparation request has not been delivered");
    if (found.responses.length >= 256)
      throw new Error("Preparation response limit reached");
    const recorded: PreparationResponse = {
      ...response,
      at: new Date().toISOString(),
    };
    found.responses.push(recorded);
    found.response = recorded;
    if (recorded.state !== "ready" && plan.phase !== "canceled")
      plan.phase = "preparing";
    await save(stateDir, plan);
    return {
      ok: true,
      preparationId: plan.id,
      participantId: found.id,
      response: recorded,
    };
  });
}
export async function setPreparationPhase(
  stateDir: string,
  id: string,
  phase: PreparationPhase,
) {
  validId(id);
  if (!["preparing", "ready", "canceled", "complete"].includes(phase))
    throw new Error("Invalid preparation phase");
  return withStateLock(stateDir, ".preparation.lock", async () => {
    const plan = await readPreparation(stateDir);
    if (!plan || plan.id !== id) throw new Error("Stale preparation identity");
    if (plan.phase === phase) return plan;
    if (["canceled", "complete"].includes(plan.phase))
      throw new Error("Preparation has already ended");
    if (
      (phase === "ready" || phase === "complete") &&
      plan.participants.some(
        (p) =>
          p.required &&
          (["pending", "failed"].includes(p.delivery.state) ||
            p.response?.state !== "ready"),
      )
    )
      throw new Error("Required agents have not acknowledged readiness");
    plan.phase = phase;
    return save(stateDir, plan);
  });
}
export const cancelPreparation = (stateDir: string, id: string) =>
  setPreparationPhase(stateDir, id, "canceled");
