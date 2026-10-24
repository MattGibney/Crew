import { connectionIds, skillSelections } from "./group-access.mjs";
import type {
  AccessRequest,
  AccessSource,
  Actor,
  Agent,
  AgentCreationPreset,
  AgentProvisioning,
  ApprovalGrant,
  AuthorizationDecision,
  AuthorizationInput,
  AuthorizationService,
  AuthorizationSettlement,
  CallerContext,
  CrewAction,
  CrewTarget,
  EnvironmentPolicy,
  ExecutionPermit,
  GrantScope,
  Job,
  JsonValue,
  PermissionGroup,
  ServiceConnection,
  ServiceConnectionView,
} from "../agents/contracts.mjs";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { AccessStore } from "./state.mjs";
import { crewActionRequiresProject } from "./crew-scopes.mjs";
import type {
  AccessAssignment,
  AccessReservation,
  AccessState,
} from "./state.mjs";
import {
  crewActions,
  validateActor,
  validateConnection,
  validateEnvironmentPolicy,
  validateGroup,
  validatePreset,
  validateInput,
  validateRecord,
  validateScope,
} from "./validation.mjs";

/** Supplied by #88; never another agent/session database. These reads must not
 * acquire a lock held while calling closeSession. Close before native Stop. */
export interface AccessIdentitySource {
  getAgent(agentId: string): Promise<Agent | null>;
  getJob(jobId: string): Promise<Job | null>;
}
/** Supplied by #90 from real discovered/schema-validated operations. No ambient
 * catalogue or invented operation names. Input fingerprints are #90's RFC8785. */
export interface AccessCatalogue {
  hasSkill?(skillId: string): Promise<boolean>;
  hasOperation(connectionId: string, operation: string): Promise<boolean>;
}
export type OwnerAccessSnapshot = Pick<
  AccessState,
  | "presets"
  | "creationDefaults"
  | "groups"
  | "assignments"
  | "connections"
  | "environmentPolicies"
  | "requests"
  | "grants"
  | "audit"
>;
type CatalogueEvidence = {
  connectionId: string;
  revision: number;
  operations: string[];
}[];
const presetView = (
  state: AccessState,
  preset: AgentCreationPreset,
): AgentCreationPreset => ({
  ...preset,
  skills: skillSelections(state, preset.permissionGroupIds),
  serviceConnectionIds: connectionIds(state, preset.permissionGroupIds),
});
const now = () => new Date().toISOString();
const denied = (reason: string) => ({ state: "denied" as const, reason });
const administrative = new Set<CrewAction>([
  "groups.write",
  "groups.assign",
  "connections.assign",
  "connections.manage",
  "grants.approve",
  "grants.revoke",
]);
function exact(input: AuthorizationInput): GrantScope {
  const { connectionId, operation, argumentsFingerprint } = input.operation;
  return {
    type: "exact_operation",
    connectionId,
    operation,
    argumentsFingerprint,
  };
}
function sameCaller(a: CallerContext, b: CallerContext): boolean {
  return (
    a.projectId === b.projectId &&
    a.agentId === b.agentId &&
    a.sessionId === b.sessionId
  );
}
function sameInput(a: AuthorizationInput, b: AuthorizationInput): boolean {
  return isDeepStrictEqual(a, b);
}
function matches(scope: GrantScope, input: AuthorizationInput): boolean {
  const operation = input.operation;
  if (scope.connectionId !== operation.connectionId) return false;
  if (scope.type === "exact_operation")
    return (
      scope.operation === operation.operation &&
      scope.argumentsFingerprint === operation.argumentsFingerprint
    );
  if (!scope.capabilities.includes(operation.operation)) return false;
  return scope.constraints.every((constraint) => {
    let value: JsonValue | undefined = operation.arguments;
    for (const token of constraint.pointer === ""
      ? []
      : constraint.pointer.slice(1).split("/")) {
      const key = token.replace(/~1/g, "/").replace(/~0/g, "~");
      if (
        value === null ||
        typeof value !== "object" ||
        !Object.hasOwn(value, key)
      )
        return false;
      // Array indices have canonical decimal spelling; '-' and '01' are not indices.
      if (Array.isArray(value)) {
        if (!/^(0|[1-9][0-9]*)$/.test(key)) return false;
        value = value[Number(key)];
      } else value = value[key];
    }
    return (
      value !== undefined &&
      constraint.allowedValues.some((allowed) =>
        isDeepStrictEqual(value, allowed),
      )
    );
  });
}
function audit(
  state: AccessState,
  actor: Actor | null,
  action: string,
  subjectId: string,
): void {
  state.audit.push({ id: randomUUID(), at: now(), actor, action, subjectId });
}
function revision(
  current: { revision: number } | undefined,
  expected: number | null,
): number {
  if (expected !== null && (!Number.isSafeInteger(expected) || expected < 1))
    throw new Error("Invalid expected revision.");
  if ((current?.revision ?? null) !== expected)
    throw new Error("Access settings changed. Reload before saving.");
  if (current?.revision === Number.MAX_SAFE_INTEGER)
    throw new Error("Access revision exhausted.");
  return (current?.revision ?? 0) + 1;
}
function upsert<T extends { id: string }>(rows: T[], value: T): void {
  const index = rows.findIndex((row) => row.id === value.id);
  if (index < 0) rows.push(value);
  else rows[index] = value;
}
function owner(state: AccessState, actor: Actor): void {
  validateActor(actor);
  if (actor.type !== "user" || actor.userId !== state.ownerUserId)
    throw new Error(
      "Only the authenticated project owner can administer access.",
    );
}

/** Trusted control-plane object. Never expose decide/admin/permit methods as
 * generic agent tools; HTTP/IPC must bind the owner/caller from its transport. */
export class ProjectAuthorizationService
  implements AuthorizationService, AgentProvisioning
{
  constructor(
    private readonly store: AccessStore,
    private readonly identities: AccessIdentitySource,
    private readonly catalogue: AccessCatalogue,
  ) {}

  private async agent(state: AccessState, agentId: string): Promise<Agent> {
    const agent = await this.identities.getAgent(agentId);
    if (
      !agent ||
      agent.id !== agentId ||
      agent.projectId !== state.projectId ||
      agent.archivedAt !== null
    )
      throw new Error("Agent unavailable in this project.");
    return agent;
  }
  private async live(state: AccessState, caller: CallerContext): Promise<void> {
    validateRecord("caller", caller);
    if (
      caller.projectId !== state.projectId ||
      state.closedSessions.some((closed) => sameCaller(closed, caller))
    )
      throw new Error("Agent permission session is closed.");
    const agent = await this.agent(state, caller.agentId);
    const session = agent.runtime.session;
    if (
      session.sessionId !== caller.sessionId ||
      session.desiredState !== "started" ||
      session.observedState !== "started"
    )
      throw new Error("No verified started agent session.");
  }
  private async operation(
    state: AccessState,
    input: AuthorizationInput,
    evidence: CatalogueEvidence,
  ): Promise<void> {
    validateInput(input);
    await this.live(state, input.caller);
    if (input.jobId !== null) {
      const job = await this.identities.getJob(input.jobId);
      if (
        !job ||
        job.id !== input.jobId ||
        job.projectId !== state.projectId ||
        job.assignment.assignedToAgentId !== input.caller.agentId
      )
        throw new Error("Job does not belong to this caller.");
    }
    if (
      !state.connections.some((row) => row.id === input.operation.connectionId)
    )
      throw new Error("Connection unavailable in this project.");
    const assignment = state.assignments.find(
      (row) => row.agentId === input.caller.agentId,
    );
    if (
      !connectionIds(state, assignment?.permissionGroupIds ?? []).includes(
        input.operation.connectionId,
      )
    )
      throw new Error(
        "No current group makes this connection available to this agent.",
      );
    this.assertCatalogue(state, evidence, input.operation.connectionId, [
      input.operation.operation,
    ]);
    for (const previous of [
      ...state.reservations.map((row) => row.input),
      ...state.requests.map((row) => ({
        caller: row.caller,
        jobId: row.jobId,
        operation: row.operation,
      })),
    ]) {
      if (
        previous.operation.invocationId === input.operation.invocationId &&
        !sameInput(previous, input)
      )
        throw new Error("Logical invocation identity cannot change.");
    }
  }
  /** Discovery may re-enter getConnection; never invoke it while holding the store. */
  private async discover(
    scopes: { connectionId: string; operations: string[] }[],
  ): Promise<CatalogueEvidence> {
    const evidence = await this.store.transaction((state) =>
      scopes.map((scope) => {
        const connection = state.connections.find(
          (row) => row.id === scope.connectionId,
        );
        if (!connection)
          throw new Error("Connection unavailable in this project.");
        return { ...scope, revision: connection.revision };
      }),
    );
    for (const scope of evidence)
      for (const operation of scope.operations)
        if (!(await this.catalogue.hasOperation(scope.connectionId, operation)))
          throw new Error(
            "Operation is not in the discovered capability catalogue.",
          );
    return evidence;
  }
  private assertCatalogue(
    state: AccessState,
    evidence: CatalogueEvidence,
    connectionId: string,
    operations: string[],
  ): void {
    const connection = state.connections.find((row) => row.id === connectionId);
    const scope = evidence.find(
      (row) =>
        row.connectionId === connectionId &&
        row.revision === connection?.revision &&
        operations.every((op) => row.operations.includes(op)),
    );
    if (!scope)
      throw new Error(
        "Connection changed during capability discovery. Retry with current settings.",
      );
  }
  private scopeOperations(scope: GrantScope): {
    connectionId: string;
    operations: string[];
  } {
    return {
      connectionId: scope.connectionId,
      operations:
        scope.type === "exact_operation"
          ? [scope.operation]
          : scope.capabilities,
    };
  }
  private async reservationEvidence(
    reservationId: string,
  ): Promise<CatalogueEvidence> {
    const input = await this.store.transaction(
      (state) =>
        state.reservations.find((row) => row.id === reservationId)?.input ??
        null,
    );
    if (!input) throw new Error("Unknown reservation.");
    return this.discover([
      {
        connectionId: input.operation.connectionId,
        operations: [input.operation.operation],
      },
    ]);
  }
  private sources(
    state: AccessState,
    input: AuthorizationInput,
  ): AccessSource[] {
    const assignment = state.assignments.find(
      (row) => row.agentId === input.caller.agentId,
    );
    const groups: AccessSource[] = state.groups
      .filter(
        (group) =>
          assignment?.permissionGroupIds.includes(group.id) &&
          group.grants.services.some(
            (service) =>
              service.connectionId === input.operation.connectionId &&
              service.capabilities.includes(input.operation.operation),
          ),
      )
      .map((group) => ({
        type: "group",
        groupId: group.id,
        revision: group.revision,
      }));
    const grants: AccessSource[] = state.grants
      .filter((grant) => {
        if (
          grant.agentId !== input.caller.agentId ||
          !["active", "reserved"].includes(grant.state) ||
          !matches(grant.scope, input)
        )
          return false;
        if (grant.duration.type === "session")
          return grant.duration.sessionId === input.caller.sessionId;
        if (grant.duration.type === "once")
          return (
            grant.duration.logicalInvocationId ===
              input.operation.invocationId &&
            (grant.reservedInvocationId === null ||
              grant.reservedInvocationId === input.operation.invocationId)
          );
        return true;
      })
      .map((grant) => ({ type: "grant", grantId: grant.id }));
    return [...groups, ...grants];
  }
  private reserveOnce(
    state: AccessState,
    input: AuthorizationInput,
    reservation: AccessReservation,
    sources: AccessSource[],
  ): void {
    if (
      sources.some(
        (source) =>
          source.type === "group" ||
          state.grants.find(
            (grant) => source.type === "grant" && grant.id === source.grantId,
          )?.duration.type !== "once",
      )
    )
      return;
    const source = sources.find((source) => source.type === "grant");
    const grant =
      source?.type === "grant"
        ? state.grants.find((row) => row.id === source.grantId)
        : undefined;
    if (!grant || grant.duration.type !== "once")
      throw new Error("No matching authority.");
    grant.state = "reserved";
    grant.reservedInvocationId = input.operation.invocationId;
    reservation.onceGrantId = grant.id;
  }
  private request(
    state: AccessState,
    input: AuthorizationInput,
    requestedScope: GrantScope,
    justification: string,
  ): AccessRequest {
    const existing = state.requests.find(
      (row) => row.operation.invocationId === input.operation.invocationId,
    );
    if (existing) return existing;
    const request: AccessRequest = {
      id: randomUUID(),
      ...input,
      requestedScope,
      justification,
      createdAt: now(),
      updatedAt: now(),
      state: "pending",
      grantId: null,
      decidedBy: null,
      reason: null,
    };
    state.requests.push(request);
    audit(
      state,
      { type: "agent", agentId: input.caller.agentId },
      "request.created",
      request.id,
    );
    return request;
  }

  /** Catalogue visibility only: never admits execution or changes session state. */
  async canDiscoverBrowser(caller: CallerContext): Promise<boolean> {
    caller = structuredClone(caller);
    return this.store.transaction(async (state) => {
      try {
        validateRecord("caller", caller);
        if (
          caller.projectId !== state.projectId ||
          state.closedSessions.some((closed) => sameCaller(closed, caller))
        )
          return false;
        const agent = await this.agent(state, caller.agentId);
        const session = agent.runtime.session;
        if (
          session.sessionId !== caller.sessionId ||
          session.desiredState !== "started" ||
          !["starting", "started"].includes(session.observedState)
        )
          return false;
        const assignment = state.assignments.find(
          (row) => row.agentId === caller.agentId,
        );
        return state.groups.some(
          (group) =>
            assignment?.permissionGroupIds.includes(group.id) &&
            group.grants.crew.some(
              (permission) => permission.action === "browser.control",
            ),
        );
      } catch {
        return false;
      }
    });
  }

  /** Fresh group authority for page traffic and owner-open operations. This is
   * deliberately independent of a running native session; it never admits tools. */
  async canUseExternalBrowser(agentId: string): Promise<boolean> {
    return this.store.transaction(async (state) => {
      try {
        await this.agent(state, agentId);
        const assignment = state.assignments.find(
          (row) => row.agentId === agentId,
        );
        const actions = new Set(
          state.groups
            .filter((group) =>
              assignment?.permissionGroupIds.includes(group.id),
            )
            .flatMap((group) =>
              group.grants.crew.map((permission) => permission.action),
            ),
        );
        return (
          actions.has("browser.control") && actions.has("browser.external")
        );
      } catch {
        return false;
      }
    });
  }

  async checkCrew(
    caller: CallerContext,
    action: CrewAction,
    target: CrewTarget,
  ): ReturnType<AuthorizationService["checkCrew"]> {
    caller = structuredClone(caller);
    target = structuredClone(target);
    return this.store.transaction(async (state) => {
      try {
        await this.live(state, caller);
        if (!crewActions.includes(action) || administrative.has(action))
          return denied("Owner administration is required.");
        if (target.type !== "agent" && target.type !== "project")
          return denied("Invalid access target.");
        if (target.type === "agent") {
          const recipient = await this.agent(state, target.agentId);
          if (
            action === "agents.archive" &&
            (recipient.reportsTo.type !== "agent" ||
              recipient.reportsTo.agentId !== caller.agentId)
          )
            return denied("Only your current child agents can be retired.");
        }
        if (crewActionRequiresProject(action) && target.type !== "project")
          return denied("This operation requires project scope.");
        const assignment = state.assignments.find(
          (row) => row.agentId === caller.agentId,
        );
        const allowed = state.groups.some(
          (group) =>
            assignment?.permissionGroupIds.includes(group.id) &&
            group.grants.crew.some(
              (permission) => permission.action === action,
            ),
        );
        return allowed
          ? { state: "allowed" as const }
          : denied("No current group grants this capability.");
      } catch {
        return denied("Caller, session or target could not be verified.");
      }
    });
  }

  async requestAccess(
    input: AuthorizationInput,
    requestedScope: GrantScope,
    justification: string,
  ): Promise<AccessRequest> {
    input = structuredClone(input);
    requestedScope = structuredClone(requestedScope);
    validateInput(input);
    validateScope(requestedScope);
    if (
      typeof justification !== "string" ||
      !justification.trim() ||
      justification.length > 4096 ||
      !matches(requestedScope, input)
    )
      throw new Error(
        "Request needs a bounded justification and scope covering this operation.",
      );
    const evidence = await this.discover([
      {
        connectionId: input.operation.connectionId,
        operations: [input.operation.operation],
      },
      this.scopeOperations(requestedScope),
    ]);
    return this.store.transaction(async (state) => {
      await this.operation(state, input, evidence);
      const scope = this.scopeOperations(requestedScope);
      this.assertCatalogue(
        state,
        evidence,
        scope.connectionId,
        scope.operations,
      );
      const request = this.request(state, input, requestedScope, justification);
      if (request.state === "pending") {
        request.requestedScope = requestedScope;
        request.justification = justification;
        request.updatedAt = now();
      }
      return request;
    });
  }

  async authorizeAndReserve(
    input: AuthorizationInput,
  ): Promise<AuthorizationDecision> {
    input = structuredClone(input);
    validateInput(input);
    let evidence: CatalogueEvidence;
    try {
      evidence = await this.discover([
        {
          connectionId: input.operation.connectionId,
          operations: [input.operation.operation],
        },
      ]);
    } catch {
      return denied("Current operation catalogue is unavailable.");
    }
    return this.store.transaction(async (state) => {
      try {
        await this.operation(state, input, evidence);
      } catch (error) {
        return denied(
          error instanceof Error &&
            error.message.startsWith("Logical invocation")
            ? error.message
            : "Caller, assignment, session or operation could not be verified.",
        );
      }
      const existing = state.reservations.find(
        (row) =>
          row.input.operation.invocationId === input.operation.invocationId,
      );
      const sources = this.sources(state, input);
      if (existing && existing.state !== "released")
        return { state: "allowed", reservationId: existing.id, sources }; // Replay reference only; never execution authority.
      if (!sources.length) {
        const request = this.request(
          state,
          input,
          exact(input),
          "The operation requires owner access approval.",
        );
        return request.state === "pending"
          ? { state: "approval_required", accessRequestId: request.id }
          : denied(
              "The prior access decision no longer authorizes this invocation.",
            );
      }
      const reservation: AccessReservation = existing ?? {
        id: randomUUID(),
        input,
        onceGrantId: null,
        state: "open",
        attempts: [],
      };
      reservation.state = "open";
      this.reserveOnce(state, input, reservation, sources);
      if (!existing) state.reservations.push(reservation);
      audit(state, null, "invocation.reserved", input.operation.invocationId);
      return { state: "allowed", reservationId: reservation.id, sources };
    });
  }

  async beginAttempt(
    reservationId: string,
    attemptId: string,
  ): ReturnType<AuthorizationService["beginAttempt"]> {
    if (typeof attemptId !== "string" || !attemptId || attemptId.length > 256)
      return denied("Invalid attempt identity.");
    let evidence: CatalogueEvidence;
    try {
      evidence = await this.reservationEvidence(reservationId);
    } catch {
      return denied("Current operation catalogue is unavailable.");
    }
    return this.store.transaction(async (state) => {
      const reservation = state.reservations.find(
        (row) => row.id === reservationId,
      );
      if (!reservation || reservation.state !== "open")
        return denied("Reservation is unavailable or already settled.");
      try {
        await this.operation(state, reservation.input, evidence);
      } catch {
        return denied("Current caller or connection access is unavailable.");
      }
      const sources = this.sources(state, reservation.input);
      if (!sources.length)
        return denied("Authority has been removed or revoked.");
      const existing = reservation.attempts.find(
        (row) => row.permit.attemptId === attemptId,
      );
      if (existing)
        return existing.result || existing.admitted
          ? denied("Attempt was already admitted or settled.")
          : { state: "allowed", permit: existing.permit };
      if (
        state.reservations.some((row) =>
          row.attempts.some(
            (attempt) => attempt.permit.attemptId === attemptId,
          ),
        )
      )
        return denied(
          "Attempt identity already belongs to another invocation.",
        );
      if (
        reservation.attempts.length >= 4 ||
        reservation.attempts.some((row) => row.result?.state !== "not_executed")
      )
        return denied(
          "An attempt is pending, uncertain, accepted, or the retry bound was reached.",
        );
      this.reserveOnce(state, reservation.input, reservation, sources);
      const permit: ExecutionPermit = {
        id: randomUUID(),
        reservationId,
        invocationId: reservation.input.operation.invocationId,
        attemptId,
      };
      reservation.attempts.push({ permit, admitted: false, result: null });
      return { state: "allowed", permit };
    });
  }

  async redeem(
    permit: ExecutionPermit,
  ): ReturnType<AuthorizationService["redeem"]> {
    permit = structuredClone(permit);
    validateRecord("permit", permit);
    let evidence: CatalogueEvidence;
    try {
      evidence = await this.reservationEvidence(permit.reservationId);
    } catch {
      return denied("Current operation catalogue is unavailable.");
    }
    return this.store.transaction(async (state) => {
      const reservation = state.reservations.find(
        (row) => row.id === permit.reservationId,
      );
      const attempt = reservation?.attempts.find((row) =>
        isDeepStrictEqual(row.permit, permit),
      );
      if (
        !reservation ||
        reservation.state !== "open" ||
        !attempt ||
        attempt.admitted ||
        attempt.result
      )
        return denied("Permit is invalid, already redeemed or settled.");
      if (
        reservation.attempts.some(
          (other) =>
            other !== attempt && other.result?.state !== "not_executed",
        )
      )
        return denied(
          "Another execution attempt remains active or unresolved.",
        );
      try {
        await this.operation(state, reservation.input, evidence);
      } catch {
        return denied("Current session or assigned connection is unavailable.");
      }
      const sources = this.sources(state, reservation.input);
      if (!sources.length)
        return denied("Authority was removed before execution admission.");
      this.reserveOnce(state, reservation.input, reservation, sources);
      attempt.admitted = true; // Durable linearization point before executor dispatch.
      audit(state, null, "attempt.admitted", permit.attemptId);
      return { state: "allowed" };
    });
  }

  async settle(
    reservationId: string,
    attemptId: string,
    result: AuthorizationSettlement,
  ): Promise<void> {
    result = structuredClone(result);
    validateRecord("settlement", result);
    await this.store.transaction((state) => {
      const reservation = state.reservations.find(
        (row) => row.id === reservationId,
      );
      const attempt = reservation?.attempts.find(
        (row) => row.permit.attemptId === attemptId,
      );
      if (!reservation || !attempt)
        throw new Error("Unknown reservation or attempt.");
      if (isDeepStrictEqual(attempt.result, result)) return;
      if (attempt.result && attempt.result.state !== "uncertain")
        throw new Error("Conflicting settled result.");
      if (!attempt.admitted && result.state !== "not_executed")
        throw new Error(
          "Unadmitted operation cannot report acceptance or uncertainty.",
        );
      attempt.result = result;
      reservation.state =
        result.state === "accepted"
          ? "accepted"
          : result.state === "uncertain"
            ? "uncertain"
            : "open";
      const grant = state.grants.find(
        (row) => row.id === reservation.onceGrantId,
      );
      if (grant?.state === "reserved" && result.state === "accepted")
        grant.state = "consumed";
      audit(state, null, `attempt.${result.state}`, attemptId);
    });
  }

  async releaseNotExecuted(
    reservationId: string,
    evidence: string,
  ): Promise<void> {
    if (
      typeof evidence !== "string" ||
      !evidence.trim() ||
      evidence.length > 4096
    )
      throw new Error("Conclusive bounded non-execution evidence is required.");
    await this.store.transaction((state) => {
      const reservation = state.reservations.find(
        (row) => row.id === reservationId,
      );
      if (!reservation) throw new Error("Unknown reservation.");
      if (reservation.state === "released") return;
      if (
        reservation.state !== "open" ||
        reservation.attempts.some(
          (row) => row.admitted && row.result?.state !== "not_executed",
        )
      )
        throw new Error(
          "Cannot release accepted, active or uncertain execution.",
        );
      for (const attempt of reservation.attempts)
        if (!attempt.result)
          attempt.result = {
            state: "not_executed",
            receiptId: `release:${reservation.id}`,
            evidence,
          };
      reservation.state = "released";
      const grant = state.grants.find(
        (row) => row.id === reservation.onceGrantId,
      );
      if (grant?.state === "reserved") {
        grant.state = state.closedSessions.some((caller) =>
          sameCaller(caller, reservation.input.caller),
        )
          ? "expired"
          : "active";
        grant.reservedInvocationId = null;
      }
      audit(state, null, "reservation.released_not_executed", reservation.id);
    });
  }

  async decide(
    requestId: string,
    approver: Actor,
    decision: Parameters<AuthorizationService["decide"]>[2],
  ): Promise<AccessRequest> {
    approver = structuredClone(approver);
    decision = structuredClone(decision);
    if (decision.state !== "approved" && decision.state !== "rejected")
      throw new Error("Invalid access decision.");
    if (decision.state === "approved") {
      validateRecord("duration", decision.duration);
      validateScope(decision.scope);
    } else if (
      typeof decision.reason !== "string" ||
      !decision.reason.trim() ||
      decision.reason.length > 4096
    )
      throw new Error("A bounded rejection reason is required.");
    const reviewed = await this.store.transaction((state) => {
      owner(state, approver);
      return state.requests.find((row) => row.id === requestId) ?? null;
    });
    if (!reviewed) throw new Error("Unknown access request.");
    const evidence =
      decision.state === "approved"
        ? await this.discover([
            {
              connectionId: reviewed.operation.connectionId,
              operations: [reviewed.operation.operation],
            },
            this.scopeOperations(decision.scope),
          ])
        : [];
    return this.store.transaction(async (state) => {
      owner(state, approver);
      const request = state.requests.find((row) => row.id === requestId);
      if (!request) throw new Error("Unknown access request.");
      if (request.state !== "pending") {
        const grant = state.grants.find((row) => row.id === request.grantId);
        if (
          decision.state === "approved" &&
          request.state === "approved" &&
          grant &&
          isDeepStrictEqual(grant.scope, decision.scope) &&
          isDeepStrictEqual(grant.duration, decision.duration)
        )
          return request;
        if (
          decision.state === "rejected" &&
          request.state === "rejected" &&
          request.reason === decision.reason
        )
          return request;
        throw new Error("Request was already decided or expired.");
      }
      if (decision.state === "approved") {
        await this.operation(
          state,
          {
            caller: request.caller,
            jobId: request.jobId,
            operation: request.operation,
          },
          evidence,
        );
        const scope = this.scopeOperations(decision.scope);
        this.assertCatalogue(
          state,
          evidence,
          scope.connectionId,
          scope.operations,
        );
        if (!matches(decision.scope, request))
          throw new Error(
            "Approved scope must explicitly cover the reviewed operation.",
          );
        const duration = decision.duration;
        if (
          duration.type === "once" &&
          (duration.logicalInvocationId !== request.operation.invocationId ||
            decision.scope.type !== "exact_operation")
        )
          throw new Error("Once approval must bind this exact invocation.");
        if (
          duration.type === "session" &&
          duration.sessionId !== request.caller.sessionId
        )
          throw new Error(
            "Session approval must bind this live logical session.",
          );
        const grant: ApprovalGrant = {
          id: randomUUID(),
          projectId: state.projectId,
          requestId,
          agentId: request.caller.agentId,
          approvedBy: approver,
          approvedAt: now(),
          duration,
          scope: decision.scope,
          state: "active",
          reservedInvocationId: null,
          revokedAt: null,
          revokedBy: null,
        };
        state.grants.push(grant);
        request.grantId = grant.id;
      }
      request.state = decision.state;
      request.decidedBy = approver;
      request.updatedAt = now();
      request.reason = decision.state === "rejected" ? decision.reason : null;
      audit(state, approver, `request.${decision.state}`, requestId);
      return request;
    });
  }

  async revoke(grantId: string, actor: Actor, reason: string): Promise<void> {
    actor = structuredClone(actor);
    if (typeof reason !== "string" || !reason.trim() || reason.length > 4096)
      throw new Error("A bounded revocation reason is required.");
    await this.store.transaction((state) => {
      owner(state, actor);
      const grant = state.grants.find((row) => row.id === grantId);
      if (!grant) throw new Error("Unknown grant.");
      if (grant.state === "revoked") return;
      grant.state = "revoked";
      grant.revokedAt = now();
      grant.revokedBy = actor;
      audit(state, actor, "grant.revoked", grantId);
    });
  }

  async closeSession(
    caller: CallerContext,
    reason: "stop" | "restart" | "unverifiable_recovery",
  ): Promise<void> {
    caller = structuredClone(caller);
    validateRecord("caller", caller);
    if (!["stop", "restart", "unverifiable_recovery"].includes(reason))
      throw new Error("Invalid session closure reason.");
    await this.store.transaction((state) => {
      if (caller.projectId !== state.projectId)
        throw new Error("Foreign session.");
      if (state.closedSessions.some((closed) => sameCaller(closed, caller)))
        return;
      state.closedSessions.push(caller);
      for (const request of state.requests)
        if (sameCaller(request.caller, caller) && request.state === "pending") {
          request.state = "expired";
          request.reason = reason;
          request.updatedAt = now();
        }
      for (const grant of state.grants)
        if (
          grant.agentId === caller.agentId &&
          grant.duration.type === "session" &&
          grant.duration.sessionId === caller.sessionId &&
          grant.state === "active"
        )
          grant.state = "expired";
      for (const reservation of state.reservations)
        if (
          sameCaller(reservation.input.caller, caller) &&
          reservation.state === "open"
        ) {
          for (const attempt of reservation.attempts)
            if (!attempt.admitted && !attempt.result)
              attempt.result = {
                state: "not_executed",
                receiptId: `closed:${caller.sessionId}`,
                evidence: "Session closed before permit redemption.",
              };
          if (
            reservation.attempts.every(
              (row) => row.result?.state === "not_executed",
            )
          )
            reservation.state = "released";
          const grant = state.grants.find(
            (row) => row.id === reservation.onceGrantId,
          );
          if (grant?.state === "reserved" && reservation.state === "released") {
            grant.state = "expired";
            grant.reservedInvocationId = null;
          }
        }
      for (const grant of state.grants)
        if (
          grant.duration.type === "once" &&
          grant.state === "active" &&
          state.requests.some(
            (request) =>
              request.id === grant.requestId &&
              sameCaller(request.caller, caller),
          )
        )
          grant.state = "expired";
      audit(state, null, `session.${reason}`, caller.sessionId);
    });
  }

  async snapshot(actor: Actor): Promise<OwnerAccessSnapshot> {
    actor = structuredClone(actor);
    return this.store.transaction((state) => {
      owner(state, actor);
      const {
        groups,
        presets,
        creationDefaults,
        assignments,
        connections,
        environmentPolicies,
        requests,
        grants,
        audit,
      } = state;
      return {
        groups,
        presets: presets.map((preset) => presetView(state, preset)),
        creationDefaults,
        assignments: assignments.map((row) => ({
          ...row,
          serviceConnectionIds: connectionIds(state, row.permissionGroupIds),
        })),
        connections,
        environmentPolicies,
        requests,
        grants,
        audit,
      };
    });
  }
  private async creationGroups(
    state: AccessState,
    actor: Actor,
  ): Promise<string[] | null> {
    validateActor(actor);
    if (actor.type === "user") {
      owner(state, actor);
      return null;
    }
    const creator = await this.agent(state, actor.agentId);
    const sessionId = creator.runtime.session.sessionId;
    if (!sessionId) throw new Error("Creating agent session is unavailable.");
    await this.live(state, {
      projectId: state.projectId,
      agentId: creator.id,
      sessionId,
    });
    const groups =
      state.assignments.find((row) => row.agentId === creator.id)
        ?.permissionGroupIds ?? [];
    if (
      !state.groups.some(
        (group) =>
          groups.includes(group.id) &&
          group.grants.crew.some((grant) => grant.action === "agents.create"),
      )
    )
      throw new Error(
        "Creating agent does not have current agent creation permission.",
      );
    return groups;
  }
  private delegablePreset(
    state: AccessState,
    preset: AgentCreationPreset,
    groups: string[] | null,
  ): boolean {
    return preset.permissionGroupIds.every((id) => {
      const group = state.groups.find((row) => row.id === id);
      return (
        !!group &&
        (groups === null ||
          (groups.includes(id) &&
            !group.grants.crew.some(
              (grant) => grant.action === "agents.create",
            )))
      );
    });
  }
  async listPresets(actor?: Actor): Promise<AgentCreationPreset[]> {
    actor = actor === undefined ? undefined : structuredClone(actor);
    return this.store.transaction(async (state) => {
      const groups =
        actor === undefined ? null : await this.creationGroups(state, actor);
      return state.presets
        .filter(
          (row) =>
            row.enabled &&
            (groups === null || this.delegablePreset(state, row, groups)),
        )
        .map((preset) => presetView(state, preset));
    });
  }
  async defaultPreset(): Promise<AgentCreationPreset | null> {
    return this.store.transaction((state) => {
      const preset = state.presets.find(
        (row) => row.id === state.creationDefaults.presetId && row.enabled,
      );
      return preset ? presetView(state, preset) : null;
    });
  }
  async savePreset(
    actor: Actor,
    preset: AgentCreationPreset,
    expectedRevision: number | null,
  ): Promise<AgentCreationPreset> {
    actor = structuredClone(actor);
    preset = structuredClone(preset);
    validatePreset(preset);
    return this.store.transaction((state) => {
      owner(state, actor);
      if (preset.projectId !== state.projectId)
        throw new Error("Foreign creation preset.");
      this.assertAssignments(
        state,
        preset.permissionGroupIds,
        preset.serviceConnectionIds,
      );
      preset.revision = revision(
        state.presets.find((row) => row.id === preset.id),
        expectedRevision,
      );
      // Retained selection fields are compatibility projections, never authority.
      preset.skills = skillSelections(state, preset.permissionGroupIds);
      preset.serviceConnectionIds = connectionIds(
        state,
        preset.permissionGroupIds,
      );
      upsert(state.presets, preset);
      audit(state, actor, "preset.saved", preset.id);
      return preset;
    });
  }
  async removePreset(
    actor: Actor,
    presetId: string,
    expectedRevision: number,
  ): Promise<void> {
    await this.store.transaction((state) => {
      owner(state, actor);
      const preset = state.presets.find((row) => row.id === presetId);
      if (!preset) throw new Error("Template unavailable.");
      revision(preset, expectedRevision);
      state.presets = state.presets.filter((row) => row.id !== presetId);
      if (state.creationDefaults.presetId === presetId) {
        state.creationDefaults = {
          revision: revision(
            state.creationDefaults,
            state.creationDefaults.revision,
          ),
          presetId: null,
        };
      }
      audit(state, actor, "preset.removed", presetId);
    });
  }
  async setDefaultPreset(
    actor: Actor,
    presetId: string | null,
    expectedRevision: number,
  ): Promise<AccessState["creationDefaults"]> {
    return this.store.transaction((state) => {
      owner(state, actor);
      if (
        presetId !== null &&
        !state.presets.some((row) => row.id === presetId && row.enabled)
      )
        throw new Error("Choose an enabled creation preset.");
      state.creationDefaults = {
        revision: revision(state.creationDefaults, expectedRevision),
        presetId,
      };
      audit(state, actor, "preset.default_saved", presetId ?? "none");
      return state.creationDefaults;
    });
  }
  private assertAssignments(
    state: AccessState,
    groupIds: string[],
    connectionIds: string[],
  ): void {
    if (
      groupIds.some((id) => !state.groups.some((row) => row.id === id)) ||
      connectionIds.some(
        (id) => !state.connections.some((row) => row.id === id),
      )
    )
      throw new Error(
        "Assignments must refer to current project groups and connections.",
      );
  }
  async skillsFor(agentId: string): Promise<Agent["skills"]> {
    return this.store.transaction((state) =>
      skillSelections(
        state,
        state.assignments.find((row) => row.agentId === agentId)
          ?.permissionGroupIds ?? [],
      ),
    );
  }
  async accessFor(agentId: string): Promise<Agent["access"]> {
    return this.store.transaction((state) => {
      const ids =
        state.assignments.find((row) => row.agentId === agentId)
          ?.permissionGroupIds ?? [];
      return {
        permissionGroupIds: ids,
        serviceConnectionIds: connectionIds(state, ids),
        inheritPersonalServiceCredentials: false,
      };
    });
  }
  /** Called under the foundation's creation/admission gate, never recursively acquires it.
   * Only a new stopped child gets a preset. Managers cannot use this to alter self/existing access.
   */
  async applyPreset(
    input: Parameters<AgentProvisioning["applyPreset"]>[0],
  ): Promise<Agent["access"]> {
    input = structuredClone(input);
    validateActor(input.actor);
    return this.store.transaction(async (state) => {
      const target = await this.agent(state, input.agentId);
      if (
        target.runtime.session.sessionId !== null ||
        target.runtime.threadId !== null
      )
        throw new Error(
          "Creation access applies only to a new unprovisioned agent.",
        );
      const receipt = state.presetApplications?.find(
        (row) => row.agentId === target.id,
      );
      if (receipt) {
        if (
          !isDeepStrictEqual(receipt.actor, input.actor) ||
          receipt.presetId !== input.presetId ||
          receipt.presetRevision !== input.expectedPresetRevision
        )
          throw new Error(
            "Provisioning retry differs from the committed preset application.",
          );
        // The original access transaction already succeeded. Return today's
        // authority without reapplying an old preset or restoring revoked access.
        const current = state.assignments.find(
          (row) => row.agentId === target.id,
        );
        return {
          permissionGroupIds: current?.permissionGroupIds ?? [],
          serviceConnectionIds: connectionIds(
            state,
            current?.permissionGroupIds ?? [],
          ),
          inheritPersonalServiceCredentials: false,
        };
      }
      if (state.assignments.some((row) => row.agentId === target.id))
        throw new Error(
          "Existing access has no matching preset application receipt.",
        );
      if (
        input.actor.type === "agent" &&
        (target.id === input.actor.agentId ||
          target.reportsTo.type !== "agent" ||
          target.reportsTo.agentId !== input.actor.agentId)
      )
        throw new Error(
          "Creation access must belong to this agent's new child.",
        );
      const creatorGroups = await this.creationGroups(state, input.actor);
      const preset = state.presets.find(
        (row) => row.id === input.presetId && row.enabled,
      );
      if (!preset || preset.revision !== input.expectedPresetRevision)
        throw new Error(
          "Creation preset changed; choose its current revision.",
        );
      if (!this.delegablePreset(state, preset, creatorGroups))
        throw new Error(
          "Child groups must be a subset of the creator's current groups and cannot grant agents.create.",
        );
      this.assertAssignments(
        state,
        preset.permissionGroupIds,
        preset.serviceConnectionIds,
      );
      if (
        target.runtime.modelAccessId !== preset.modelAccessId ||
        target.runtime.configRef !== preset.configRef
      )
        throw new Error("Agent runtime differs from its approved preset.");
      const access: Agent["access"] = {
        permissionGroupIds: [...preset.permissionGroupIds],
        serviceConnectionIds: connectionIds(state, preset.permissionGroupIds),
        inheritPersonalServiceCredentials: false,
      };
      state.assignments.push({
        agentId: target.id,
        permissionGroupIds: access.permissionGroupIds,
        serviceConnectionIds: [],
        revision: 1,
      });
      (state.presetApplications ??= []).push({
        agentId: target.id,
        actor: input.actor,
        presetId: input.presetId,
        presetRevision: input.expectedPresetRevision,
        appliedAt: now(),
      });
      audit(state, input.actor, "preset.applied", target.id);
      return access;
    });
  }
  subscribe(listener: () => void): () => void {
    return this.store.subscribe(listener);
  }

  /** Access is authoritative; foundation and renderer must project these assignments. */
  async assignment(agentId: string): Promise<AccessAssignment | null> {
    return this.store.transaction((state) =>
      (() => {
        const row = state.assignments.find((row) => row.agentId === agentId);
        return row
          ? {
              ...row,
              serviceConnectionIds: connectionIds(
                state,
                row.permissionGroupIds,
              ),
            }
          : null;
      })(),
    );
  }
  async allowedOperations(
    caller: CallerContext,
    connectionId: string,
  ): Promise<string[]> {
    return this.store.transaction(async (state) => {
      await this.live(state, caller);
      const ids =
        state.assignments.find((row) => row.agentId === caller.agentId)
          ?.permissionGroupIds ?? [];
      if (!connectionIds(state, ids).includes(connectionId)) return [];
      const operations = state.groups
        .filter((group) => ids.includes(group.id))
        .flatMap((group) =>
          group.grants.services
            .filter((grant) => grant.connectionId === connectionId)
            .flatMap((grant) => grant.capabilities),
        );
      for (const grant of state.grants) {
        if (
          grant.agentId !== caller.agentId ||
          grant.scope.connectionId !== connectionId ||
          !["active", "reserved"].includes(grant.state) ||
          (grant.duration.type === "session" &&
            grant.duration.sessionId !== caller.sessionId)
        )
          continue;
        operations.push(
          ...(grant.scope.type === "capability"
            ? grant.scope.capabilities
            : [grant.scope.operation]),
        );
      }
      return [...new Set(operations)];
    });
  }
  async listAssignedConnections(
    caller: CallerContext,
  ): Promise<ServiceConnection[]> {
    return this.store.transaction(async (state) => {
      await this.live(state, caller);
      const assignment = state.assignments.find(
        (row) => row.agentId === caller.agentId,
      );
      return state.connections.filter((row) =>
        connectionIds(state, assignment?.permissionGroupIds ?? []).includes(
          row.id,
        ),
      );
    });
  }
  /** Trusted gateway metadata. Do not expose this record to the runtime. */
  async getConnection(connectionId: string): Promise<ServiceConnection | null> {
    return this.store.transaction(
      (state) =>
        state.connections.find((row) => row.id === connectionId) ?? null,
    );
  }
  async connectionViews(
    caller: CallerContext,
  ): Promise<ServiceConnectionView[]> {
    caller = structuredClone(caller);
    return this.store.transaction(async (state) => {
      await this.live(state, caller);
      const assignment = state.assignments.find(
        (row) => row.agentId === caller.agentId,
      );
      return state.connections
        .filter((row) =>
          connectionIds(state, assignment?.permissionGroupIds ?? []).includes(
            row.id,
          ),
        )
        .map(
          ({
            id,
            projectId,
            name,
            service,
            identity,
            observedState,
            lastVerifiedAt,
          }) => ({
            id,
            projectId,
            name,
            service,
            identity,
            observedState,
            lastVerifiedAt,
          }),
        );
    });
  }
  async removeGroup(
    actor: Actor,
    groupId: string,
    expectedRevision: number,
  ): Promise<void> {
    actor = structuredClone(actor);
    await this.store.transaction((state) => {
      owner(state, actor);
      const group = state.groups.find((row) => row.id === groupId);
      if (!group) throw new Error("Permission group unavailable.");
      revision(group, expectedRevision);
      state.groups = state.groups.filter((row) => row.id !== groupId);
      for (const assignment of state.assignments) {
        if (!assignment.permissionGroupIds.includes(groupId)) continue;
        assignment.permissionGroupIds = assignment.permissionGroupIds.filter(
          (id) => id !== groupId,
        );
        assignment.serviceConnectionIds = connectionIds(
          state,
          assignment.permissionGroupIds,
        );
        assignment.revision = revision(assignment, assignment.revision);
      }
      for (const preset of state.presets) {
        if (!preset.permissionGroupIds.includes(groupId)) continue;
        preset.permissionGroupIds = preset.permissionGroupIds.filter(
          (id) => id !== groupId,
        );
        preset.skills = skillSelections(state, preset.permissionGroupIds);
        preset.serviceConnectionIds = connectionIds(
          state,
          preset.permissionGroupIds,
        );
        preset.revision = revision(preset, preset.revision);
      }
      audit(state, actor, "group.removed", groupId);
    });
  }
  async saveGroup(
    actor: Actor,
    group: PermissionGroup,
    expectedRevision: number | null,
  ): Promise<PermissionGroup> {
    actor = structuredClone(actor);
    group = structuredClone(group);
    validateGroup(group);
    // Authenticate before allowing any upstream discovery.
    const existingGroup = await this.store.transaction((state) => {
      owner(state, actor);
      return state.groups.find((row) => row.id === group.id) ?? null;
    });
    for (const skillId of group.grants.skillIds ?? [])
      if (
        !(await this.catalogue.hasSkill?.(skillId)) &&
        !existingGroup?.grants.skillIds?.includes(skillId)
      )
        throw new Error("Group skills must exist in this project catalogue.");
    const evidence = await this.discover(
      group.grants.services.map((service) => ({
        connectionId: service.connectionId,
        operations: service.capabilities,
      })),
    );
    return this.store.transaction(async (state) => {
      owner(state, actor);
      if (group.projectId !== state.projectId)
        throw new Error("Foreign permission group.");
      for (const service of group.grants.services) {
        if (!state.connections.some((row) => row.id === service.connectionId))
          throw new Error("Unknown group connection.");
        this.assertCatalogue(
          state,
          evidence,
          service.connectionId,
          service.capabilities,
        );
      }
      if (
        group.grants.environmentPolicyIds.some(
          (id) => !state.environmentPolicies.some((row) => row.id === id),
        )
      )
        throw new Error("Unknown environment policy.");
      group.revision = revision(
        state.groups.find((row) => row.id === group.id),
        expectedRevision,
      );
      group.updatedAt = now();
      upsert(state.groups, group);
      audit(state, actor, "group.saved", group.id);
      return group;
    });
  }
  async saveConnection(
    actor: Actor,
    connection: ServiceConnection,
    expectedRevision: number | null,
    prepareAuthentication?: (
      current: ServiceConnection | null,
    ) => Promise<ServiceConnection["authentication"]>,
  ): Promise<ServiceConnection> {
    actor = structuredClone(actor);
    connection = structuredClone(connection);
    validateConnection(connection);
    return this.store.transaction(async (state) => {
      owner(state, actor);
      if (connection.projectId !== state.projectId)
        throw new Error("Foreign service connection.");
      const current = state.connections.find((row) => row.id === connection.id);
      // Stable connection identity is part of every existing scope. A new
      // service/account/executor needs a new connection and explicit assignment.
      if (
        current &&
        (current.service !== connection.service ||
          !isDeepStrictEqual(current.identity, connection.identity) ||
          !isDeepStrictEqual(current.transport, connection.transport))
      )
        throw new Error(
          "Create a new connection to change the service identity or executor; existing grants are bound to this connection.",
        );
      if (
        !current &&
        state.audit.some(
          (row) =>
            row.action === "connection.removed" &&
            row.subjectId === connection.id,
        )
      )
        throw new Error("A removed connection identity cannot be reused.");
      connection.revision = revision(current, expectedRevision);
      // Owner vault writes run only after identity and revision checks. A commit
      // failure fails the store closed; never claim a credential-only save succeeded.
      if (prepareAuthentication)
        connection.authentication = await prepareAuthentication(
          current ?? null,
        );
      validateConnection(connection);
      upsert(state.connections, connection);
      audit(state, actor, "connection.saved", connection.id);
      return connection;
    });
  }
  async removeConnection(
    actor: Actor,
    connectionId: string,
    expectedRevision: number,
  ): Promise<void> {
    actor = structuredClone(actor);
    await this.store.transaction((state) => {
      owner(state, actor);
      revision(
        state.connections.find((row) => row.id === connectionId),
        expectedRevision,
      );
      state.connections = state.connections.filter(
        (row) => row.id !== connectionId,
      );
      for (const group of state.groups) {
        if (
          group.grants.services.some(
            (grant) => grant.connectionId === connectionId,
          )
        ) {
          group.grants.services = group.grants.services.filter(
            (grant) => grant.connectionId !== connectionId,
          );
          group.revision++;
          group.updatedAt = now();
        }
      }
      for (const assignment of state.assignments)
        if (assignment.serviceConnectionIds.includes(connectionId)) {
          assignment.serviceConnectionIds =
            assignment.serviceConnectionIds.filter((id) => id !== connectionId);
          assignment.revision++;
        }
      for (const request of state.requests)
        if (
          request.operation.connectionId === connectionId &&
          request.state === "pending"
        ) {
          request.state = "cancelled";
          request.reason = "The owner removed this connection.";
          request.updatedAt = now();
        }
      for (const grant of state.grants)
        if (
          grant.scope.connectionId === connectionId &&
          ["active", "reserved"].includes(grant.state)
        ) {
          grant.state = "revoked";
          grant.revokedAt = now();
          grant.revokedBy = actor;
        }
      // Preserve in-flight operation evidence; deletion cannot undo an admitted call.
      audit(state, actor, "connection.removed", connectionId);
    });
  }
  /** Trusted gateway health observation; no credential or identity mutation. */
  async observeConnection(
    connectionId: string,
    expectedRevision: number,
    observation: Pick<ServiceConnection, "observedState" | "lastVerifiedAt">,
  ): Promise<ServiceConnection> {
    observation = structuredClone(observation);
    return this.store.transaction((state) => {
      const current = state.connections.find((row) => row.id === connectionId);
      if (!current) throw new Error("Unknown connection.");
      const next = {
        ...current,
        observedState: observation.observedState,
        lastVerifiedAt: observation.lastVerifiedAt,
        revision: revision(current, expectedRevision),
      };
      validateConnection(next);
      upsert(state.connections, next);
      return next;
    });
  }
  async setAssignments(
    actor: Actor,
    agentId: string,
    permissionGroupIds: string[],
    serviceConnectionIds: string[] | undefined,
    expectedRevision: number | null,
  ): Promise<AccessAssignment> {
    actor = structuredClone(actor);
    permissionGroupIds = [...permissionGroupIds];
    serviceConnectionIds = serviceConnectionIds
      ? [...serviceConnectionIds]
      : undefined;
    return this.store.transaction(async (state) => {
      owner(state, actor);
      await this.agent(state, agentId);
      const current = state.assignments.find((row) => row.agentId === agentId);
      if (
        current &&
        serviceConnectionIds !== undefined &&
        isDeepStrictEqual(
          [...current.permissionGroupIds].sort(),
          [...permissionGroupIds].sort(),
        ) &&
        !isDeepStrictEqual(
          [...connectionIds(state, permissionGroupIds)].sort(),
          [...serviceConnectionIds].sort(),
        )
      )
        throw new Error(
          "Connections derive from group memberships. Change the group service grants or membership; an individual connection list cannot change access.",
        );
      const assignment = {
        agentId,
        permissionGroupIds,
        serviceConnectionIds: [],
        revision: revision(current, expectedRevision),
      };
      validateRecord("assignment", assignment);
      if (
        permissionGroupIds.some(
          (id) => !state.groups.some((row) => row.id === id),
        ) ||
        serviceConnectionIds?.some(
          (id) => !state.connections.some((row) => row.id === id),
        )
      )
        throw new Error(
          "Assignments must refer to current project groups and connections.",
        );
      if (current) Object.assign(current, assignment);
      else state.assignments.push(assignment);
      audit(state, actor, "assignment.saved", agentId);
      return {
        ...assignment,
        serviceConnectionIds: connectionIds(
          state,
          assignment.permissionGroupIds,
        ),
      };
    });
  }
  async saveEnvironmentPolicy(
    actor: Actor,
    policy: EnvironmentPolicy,
    expectedRevision: number | null,
  ): Promise<EnvironmentPolicy> {
    actor = structuredClone(actor);
    policy = structuredClone(policy);
    validateEnvironmentPolicy(policy);
    return this.store.transaction((state) => {
      owner(state, actor);
      if (policy.projectId !== state.projectId)
        throw new Error("Foreign environment policy.");
      policy.revision = revision(
        state.environmentPolicies.find((row) => row.id === policy.id),
        expectedRevision,
      );
      upsert(state.environmentPolicies, policy);
      audit(state, actor, "environment_policy.saved", policy.id);
      return policy;
    });
  }
}
