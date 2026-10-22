import { Ajv } from "ajv";
import { isDeepStrictEqual } from "node:util";
import type { AccessState } from "./state.mjs";
import type {
  Actor,
  AuthorizationInput,
  EnvironmentPolicy,
  GrantScope,
  PermissionGroup,
  ServiceConnection,
} from "../agents/contracts.mjs";

const id = { type: "string", minLength: 1, maxLength: 256 };
const text = { type: "string", maxLength: 4096 };
const revision = {
  type: "integer",
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER,
};
const nullable = (schema: object) => ({ anyOf: [schema, { type: "null" }] });
const array = (items: object, maxItems = 10000) => ({
  type: "array",
  items,
  maxItems,
});
const ids = { ...array(id, 256), uniqueItems: true };
const object = (properties: Record<string, unknown>) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const one = (value: string) => ({ const: value });
const ref = (name: string) => ({ $ref: `#/$defs/${name}` });
const fingerprint = { type: "string", pattern: "^[a-f0-9]{64}$" };
const timestamp = {
  type: "string",
  pattern: "^\\d{4}-\\d\\d-\\d\\dT.*Z$",
  maxLength: 40,
};
export const crewActions = [
  "agents.read",
  "agents.create",
  "agents.update",
  "agents.archive",
  "sessions.start",
  "sessions.stop",
  "sessions.restart",
  "messages.send",
  "history.read",
  "help.request",
  "help.respond",
  "jobs.read",
  "jobs.create",
  "jobs.assign",
  "jobs.update",
  "scratchpad.read",
  "scratchpad.write",
  "skills.read",
  "skills.write",
  "skills.assign",
  "environments.read",
  "environments.create",
  "environments.attach",
  "environments.execute",
  "environments.dispose",
  "groups.read",
  "groups.write",
  "groups.assign",
  "connections.read",
  "connections.assign",
  "connections.manage",
  "grants.review",
  "grants.approve",
  "grants.revoke",
] as const;
const definitions = {
  json: {
    anyOf: [
      { type: "null" },
      { type: "boolean" },
      { type: "number" },
      { type: "string", maxLength: 65536 },
      array(ref("json"), 1000),
      {
        type: "object",
        additionalProperties: ref("json"),
        maxProperties: 1000,
      },
    ],
  },
  actor: {
    anyOf: [
      object({ type: one("user"), userId: id }),
      object({ type: one("agent"), agentId: id }),
    ],
  },
  caller: object({ projectId: id, agentId: id, sessionId: id }),
  operation: object({
    invocationId: id,
    connectionId: id,
    operation: id,
    arguments: {
      type: "object",
      additionalProperties: ref("json"),
      maxProperties: 1000,
    },
    argumentsFingerprint: fingerprint,
  }),
  input: object({
    caller: ref("caller"),
    jobId: nullable(id),
    operation: ref("operation"),
  }),
  scope: {
    anyOf: [
      object({
        type: one("exact_operation"),
        connectionId: id,
        operation: id,
        argumentsFingerprint: fingerprint,
      }),
      object({
        type: one("capability"),
        connectionId: id,
        capabilities: { ...ids, minItems: 1 },
        constraints: array(
          object({
            pointer: {
              type: "string",
              pattern: "^(?:/(?:[^~]|~[01])*)*$",
              maxLength: 1024,
            },
            allowedValues: { ...array(ref("json"), 256), minItems: 1 },
          }),
          64,
        ),
      }),
    ],
  },
  duration: {
    anyOf: [
      object({ type: one("once"), logicalInvocationId: id }),
      object({ type: one("session"), sessionId: id }),
      object({ type: one("persistent") }),
    ],
  },
  group: object({
    id,
    projectId: id,
    name: id,
    description: text,
    revision,
    updatedAt: timestamp,
    grants: object({
      crew: array(
        object({
          action: { enum: crewActions },
          scope: {
            anyOf: [
              object({ type: one("self") }),
              object({ type: one("agents"), agentIds: ids }),
              object({ type: one("project") }),
            ],
          },
        }),
        256,
      ),
      services: array(object({ connectionId: id, capabilities: ids }), 256),
      environmentPolicyIds: ids,
    }),
  }),
  connection: object({
    id,
    projectId: id,
    name: id,
    service: id,
    revision,
    identity: object({
      displayName: id,
      externalAccountId: nullable(id),
      emailAddress: nullable(id),
    }),
    transport: {
      anyOf: [
        object({ type: one("mcp"), serverConfigRef: id }),
        object({ type: one("cli"), executorConfigRef: id }),
      ],
    },
    authentication: {
      anyOf: [
        object({ method: one("none") }),
        object({
          method: { enum: ["oauth", "token", "ssh-key"] },
          credentialRef: id,
        }),
      ],
    },
    observedState: {
      enum: ["unknown", "connected", "reauthentication-required", "error"],
    },
    lastVerifiedAt: nullable(timestamp),
  }),
  environmentPolicy: object({
    id,
    projectId: id,
    revision,
    enforcementConfigRef: id,
  }),
  request: object({
    id,
    caller: ref("caller"),
    jobId: nullable(id),
    operation: ref("operation"),
    requestedScope: ref("scope"),
    justification: text,
    createdAt: timestamp,
    updatedAt: timestamp,
    state: {
      enum: ["pending", "approved", "rejected", "cancelled", "expired"],
    },
    grantId: nullable(id),
    decidedBy: nullable(ref("actor")),
    reason: nullable(text),
  }),
  grant: object({
    id,
    projectId: id,
    requestId: id,
    agentId: id,
    approvedBy: ref("actor"),
    approvedAt: timestamp,
    duration: ref("duration"),
    scope: ref("scope"),
    state: { enum: ["active", "reserved", "consumed", "revoked", "expired"] },
    reservedInvocationId: nullable(id),
    revokedAt: nullable(timestamp),
    revokedBy: nullable(ref("actor")),
  }),
  permit: object({ id, reservationId: id, invocationId: id, attemptId: id }),
  settlement: {
    anyOf: [
      object({ state: one("accepted"), receiptId: id }),
      object({ state: one("uncertain"), receiptId: id }),
      object({
        state: one("not_executed"),
        receiptId: id,
        evidence: { ...text, minLength: 1 },
      }),
    ],
  },
  reservation: object({
    id,
    input: ref("input"),
    onceGrantId: nullable(id),
    state: { enum: ["open", "accepted", "uncertain", "released"] },
    attempts: array(
      object({
        permit: ref("permit"),
        admitted: { type: "boolean" },
        result: nullable(ref("settlement")),
      }),
      4,
    ),
  }),
  assignment: object({
    agentId: id,
    permissionGroupIds: ids,
    serviceConnectionIds: ids,
    revision,
  }),
  audit: object({
    id,
    at: timestamp,
    actor: nullable(ref("actor")),
    action: id,
    subjectId: id,
  }),
};
const ajv = new Ajv({ strict: true, allErrors: false });
const validators = new Map<string, ReturnType<typeof ajv.compile>>();
function check(name: string, value: unknown): void {
  let validate = validators.get(name);
  if (!validate) {
    validate = ajv.compile({ $defs: definitions, ...ref(name) });
    validators.set(name, validate);
  }
  if (!validate(value)) throw new Error(`Invalid access ${name}.`); // No input values in diagnostics.
}
export function validateInput(
  value: unknown,
): asserts value is AuthorizationInput {
  check("input", value);
  if (Buffer.byteLength(JSON.stringify(value)) > 65536)
    throw new Error("Operation input too large.");
}
export function validateScope(value: unknown): asserts value is GrantScope {
  check("scope", value);
}
export function validateGroup(
  value: unknown,
): asserts value is PermissionGroup {
  check("group", value);
}
export function validateConnection(
  value: unknown,
): asserts value is ServiceConnection {
  check("connection", value);
}
export function validateActor(value: unknown): asserts value is Actor {
  check("actor", value);
}
export function validateEnvironmentPolicy(
  value: unknown,
): asserts value is EnvironmentPolicy {
  check("environmentPolicy", value);
}
export function validateRecord(
  name: "caller" | "duration" | "permit" | "settlement" | "assignment",
  value: unknown,
): void {
  check(name, value);
}
const stateValidator = ajv.compile<AccessState>({
  $defs: definitions,
  ...object({
    version: { const: 1 },
    projectId: id,
    ownerUserId: id,
    groups: array(ref("group")),
    connections: array(ref("connection")),
    environmentPolicies: array(ref("environmentPolicy")),
    assignments: array(ref("assignment")),
    requests: array(ref("request")),
    grants: array(ref("grant")),
    reservations: array(ref("reservation")),
    closedSessions: array(ref("caller")),
    audit: array(ref("audit"), 20000),
  }),
});
export function validateState(value: unknown): asserts value is AccessState {
  if (!stateValidator(value))
    throw new Error("Malformed access state; restore instead of resetting.");
  for (const rows of [
    value.groups,
    value.connections,
    value.environmentPolicies,
    value.requests,
    value.grants,
    value.reservations,
    value.audit,
  ])
    if (new Set(rows.map((row) => row.id)).size !== rows.length)
      throw new Error("Duplicate access identity.");
  if (
    new Set(value.assignments.map((row) => row.agentId)).size !==
    value.assignments.length
  )
    throw new Error("Duplicate access assignment.");
  for (const row of [
    ...value.groups,
    ...value.connections,
    ...value.environmentPolicies,
    ...value.grants,
  ])
    if (row.projectId !== value.projectId)
      throw new Error("Foreign access state.");
  for (const row of [
    ...value.requests,
    ...value.reservations.map((item) => item.input),
  ])
    if (row.caller.projectId !== value.projectId)
      throw new Error("Foreign access request.");
  for (const grant of value.grants)
    if (
      grant.approvedBy.type !== "user" ||
      grant.approvedBy.userId !== value.ownerUserId
    )
      throw new Error("Invalid approval authority.");
  for (const caller of value.closedSessions)
    if (caller.projectId !== value.projectId)
      throw new Error("Foreign closed permission session.");
  // Recovery must preserve the same identity/one-active-attempt invariants as
  // live admission. A structurally valid JSON record is not execution evidence.
  const inputs = new Map<string, AuthorizationInput>();
  for (const rows of [
    value.requests.map(({ caller, jobId, operation }) => ({
      caller,
      jobId,
      operation,
    })),
    value.reservations.map((row) => row.input),
  ]) {
    const invocationIds = new Set<string>();
    for (const input of rows) {
      const id = input.operation.invocationId;
      if (invocationIds.has(id))
        throw new Error("Duplicate logical invocation.");
      invocationIds.add(id);
      const prior = inputs.get(id);
      if (prior && !isDeepStrictEqual(prior, input))
        throw new Error("Conflicting logical invocation identity.");
      inputs.set(id, input);
    }
  }
  const attemptIds = new Set<string>(),
    permitIds = new Set<string>();
  for (const reservation of value.reservations) {
    for (const [index, attempt] of reservation.attempts.entries()) {
      const { permit, result } = attempt;
      if (
        permit.reservationId !== reservation.id ||
        permit.invocationId !== reservation.input.operation.invocationId
      )
        throw new Error("Mismatched execution permit identity.");
      if (attemptIds.has(permit.attemptId) || permitIds.has(permit.id))
        throw new Error("Duplicate execution attempt or permit.");
      attemptIds.add(permit.attemptId);
      permitIds.add(permit.id);
      if (!attempt.admitted && result && result.state !== "not_executed")
        throw new Error(
          "Unadmitted execution has an accepted or uncertain result.",
        );
      if (
        index < reservation.attempts.length - 1 &&
        result?.state !== "not_executed"
      )
        throw new Error("Concurrent or replayed execution attempts.");
    }
    const last = reservation.attempts.at(-1)?.result?.state;
    if (
      (reservation.state === "accepted" && last !== "accepted") ||
      (reservation.state === "uncertain" && last !== "uncertain") ||
      (reservation.state === "open" &&
        (last === "accepted" || last === "uncertain")) ||
      (reservation.state === "released" &&
        reservation.attempts.some(
          (attempt) => attempt.result?.state !== "not_executed",
        ))
    )
      throw new Error(
        "Reservation state conflicts with retained execution evidence.",
      );
  }
}
