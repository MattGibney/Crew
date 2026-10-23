/** Canonical #87 boundary. Type-only; implementations belong to #88/#89/#90.
 * See docs/AGENT-CONTRACTS.md for invariants enforced by the owning servers.
 * No DTO is a security boundary. Validate all serialized inputs server-side.
 */
export type Id = string;
export type Timestamp = string; // ISO 8601 UTC
export type Revision = number; // Positive, monotonically increasing per record
export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type Actor =
  { type: "user"; userId: Id } | { type: "agent"; agentId: Id };
export interface RevisionReference {
  id: Id;
  revision: Revision;
}
export interface ModelAccess {
  id: Id;
  runtime: "codex";
  authentication: { method: "chatgpt-subscription"; signInRef: string };
}
export interface Skill {
  id: Id;
  projectId: Id;
  revision: Revision;
  name: string;
  description: string;
  directoryRef: string; // Crew-owned native SKILL.md directory, not personal skills
  updatedAt: Timestamp;
}
export interface AppliedConfiguration {
  profileRevision: Revision;
  instructionsDigest?: string; // SHA-256 of verified native instructions, not a second prompt store
  permissionGroups: RevisionReference[];
  serviceConnections: RevisionReference[];
  skills: RevisionReference[];
  runtimeConfigRevision: Revision;
  appliedAt: Timestamp;
}
export interface InstructionPreparation {
  state: "compacting" | "completed" | "failed" | "uncertain";
  threadId: string;
  turnId: string | null;
  itemId: string | null;
  startedAt: Timestamp;
  completedAt: Timestamp | null;
  error: RuntimeError | null;
}
export interface AgentSession {
  sessionId: Id | null; // Logical Start-to-Stop identity; distinct from thread/turn
  desiredState: "started" | "stopped";
  observedState:
    "stopped" | "starting" | "started" | "stopping" | "error" | "unknown";
  activeTurnId: string | null;
  startedAt: Timestamp | null;
  lastObservedAt: Timestamp | null;
  lastError: RuntimeError | null;
  appliedConfiguration: AppliedConfiguration | null;
  instructionPreparation?: InstructionPreparation | null;
}
export interface Agent {
  id: Id;
  projectId: Id;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  archivedAt: Timestamp | null;
  profile: {
    revision: Revision;
    name: string;
    pictureRef: string | null;
    personality: string;
    systemPrompt: string;
    /** Optional per-agent voice override; absent legacy values mean null. */
    voice?: string | null;
  };
  skills: { skillId: Id; enabled: boolean }[];
  access: {
    permissionGroupIds: Id[];
    serviceConnectionIds: Id[];
    inheritPersonalServiceCredentials: false; // Desired policy, not isolation evidence
  };
  runtime: {
    provider: "codex";
    modelAccessId: Id;
    configRef: string;
    threadId: string | null;
    session: AgentSession;
  };
  scratchpad: { markdown: string; revision: Revision; updatedAt: Timestamp };
  reportsTo: Actor; // One next escalation hop; human root; reject cycles
  resources: { id: Id; kind: string; location: string; metadata: JsonObject }[];
}
export interface WorkLink {
  label: string;
  url: string;
}
export interface AssignmentEvent {
  id: Id;
  recordedAt: Timestamp;
  changedBy: Actor;
  previousAgentId: Id | null;
  assignedAgentId: Id | null;
  instruction: string | null;
}
export interface TicketBackedWork {
  type: "ticket";
  ticket: {
    provider: "linear" | "github";
    connectionId: Id;
    externalId: string;
    url: string;
  };
}
export interface LocalWorkUpdate {
  id: Id;
  recordedByAgentId: Id;
  recordedAt: Timestamp;
  kind: string;
  text: string;
  links: WorkLink[];
}
export interface LocalWork {
  type: "local";
  title: string;
  objective: string;
  updates: LocalWorkUpdate[];
  outcome: {
    summary: string;
    links: WorkLink[];
    recordedByAgentId: Id;
    recordedAt: Timestamp;
  } | null;
}
export type JobStatus =
  | "not_started"
  | "in_progress"
  | "blocked"
  | "ready"
  | "completed"
  | "cancelled";
export interface JobProgress {
  status: JobStatus;
  label: string | null; // Ideally 2–3 words; no workflow gate
  detail: string | null;
  percent: number | null; // Finite 0–100; may decrease; null is unavailable
  reportedByAgentId: Id | null;
  reportedAt: Timestamp | null;
}
export interface Job {
  id: Id;
  projectId: Id;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  assignment: {
    assignedBy: Actor;
    assignedToAgentId: Id | null;
    instruction: string | null;
  };
  work: TicketBackedWork | LocalWork;
  progress: JobProgress;
  assignmentHistory: AssignmentEvent[];
}
export type AgentContent =
  | { type: "text"; text: string }
  | { type: "image"; fileRef: string; caption: string | null }
  | { type: "file"; fileRef: string; name: string; mediaType: string }
  | { type: "data"; value: JsonValue }; // Sanitized structured tool result
export type DeliveryMode = "queue" | "steer";
export type MessageSender =
  Actor | { type: "system"; source: "schedule" | "preparation"; sourceId: Id };
export interface AgentMessage {
  id: Id;
  projectId: Id;
  sender: MessageSender;
  visibility: "public" | "private";
  recipientAgentId: Id;
  jobId: Id | null;
  replyToMessageId: Id | null;
  kind: "message" | "assignment" | "help_request" | "result";
  content: AgentContent[];
  deliveryMode: DeliveryMode;
  createdAt: Timestamp;
  delivery: {
    state: "queued" | "sending" | "delivered" | "uncertain" | "failed";
    attempts: DeliveryAttempt[];
    runtimeMessageRef: string | null;
    deliveredAt: Timestamp | null;
    error: RuntimeError | null;
  };
}
export interface DeliveryAttempt {
  id: Id;
  sessionId: Id;
  threadId: string;
  turnId: string | null;
  attemptedAt: Timestamp;
  outcome: "pending" | "acknowledged" | "not_sent" | "uncertain";
  runtimeMessageRef: string | null;
}
export interface MessageReceipt {
  messageId: Id;
  sender: MessageSender;
  visibility: "public" | "private";
  turnId: string;
  recipientAgentId: Id;
  jobId: Id | null;
  sessionId: Id;
  threadId: string;
  attemptId: Id;
  runtimeMessageRef: string | null;
  acknowledgedAt: Timestamp;
}
export interface HelpRequest {
  id: Id;
  projectId: Id;
  requesterAgentId: Id;
  target: Actor; // Snapshot of next reportsTo hop; human targets use owner inbox
  jobId: Id | null;
  messageId: Id;
  replyToHelpRequestId: Id | null; // Each further escalation is a new correlated hop
  state: "open" | "answered" | "escalated" | "cancelled";
  responseMessageId: Id | null;
  createdAt: Timestamp;
}

// #89 owns policy, vault, connections and approval UI. No ambient authority.
export type CrewAction =
  | "agents.read"
  | "agents.create"
  | "agents.update"
  | "agents.archive"
  | "sessions.start"
  | "sessions.stop"
  | "sessions.restart"
  | "messages.send"
  | "history.read"
  | "help.request"
  | "help.respond"
  | "jobs.read"
  | "jobs.create"
  | "jobs.assign"
  | "jobs.update"
  | "scratchpad.read"
  | "scratchpad.write"
  | "skills.read"
  | "skills.write"
  | "skills.assign"
  | "resources.read"
  | "browser.control"
  | "browser.external"
  | "environments.read"
  | "environments.create"
  | "environments.attach"
  | "environments.execute"
  | "environments.dispose"
  | "groups.read"
  | "groups.write"
  | "groups.assign"
  | "connections.read"
  | "connections.assign"
  | "connections.manage"
  | "grants.review"
  | "grants.approve"
  | "grants.revoke";
export type CrewTarget = { type: "agent"; agentId: Id } | { type: "project" };
export interface CrewPermission {
  action: CrewAction;
}
export interface PermissionGroup {
  id: Id;
  projectId: Id;
  name: string;
  description: string;
  revision: Revision;
  updatedAt: Timestamp;
  grants: {
    crew: CrewPermission[];
    services: { connectionId: Id; capabilities: string[] }[];
    environmentPolicyIds: Id[];
    /** Nonsecret project references; executable resources use canonical policy/connection grants. */
    resourceIds?: Id[];
  };
}
/** Trusted control-plane only. Agents receive ServiceConnectionView. */
export interface ServiceConnection {
  id: Id;
  projectId: Id;
  name: string;
  service: string;
  revision: Revision;
  identity: {
    displayName: string;
    externalAccountId: string | null;
    emailAddress: string | null;
  };
  transport:
    | { type: "mcp"; serverConfigRef: string }
    | { type: "cli"; executorConfigRef: string };
  authentication:
    | { method: "none" }
    | { method: "oauth" | "token" | "ssh-key"; credentialRef: string };
  observedState:
    "unknown" | "connected" | "reauthentication-required" | "error";
  lastVerifiedAt: Timestamp | null;
}
export type ServiceConnectionView = Pick<
  ServiceConnection,
  | "id"
  | "projectId"
  | "name"
  | "service"
  | "identity"
  | "observedState"
  | "lastVerifiedAt"
>;
export interface CallerContext {
  projectId: Id;
  agentId: Id;
  sessionId: Id; // Bound by authenticated gateway transport, never model arguments
}
export interface OperationIdentity {
  invocationId: Id; // Stable logical operation ID; immutable operation/arguments
  connectionId: Id;
  operation: string; // Discovered namespaced capability ID
  arguments: JsonObject; // Normalized, schema-validated; service secrets prohibited
  argumentsFingerprint: string; // SHA-256 canonical JSON, computed by trusted gateway
}
export type GrantScope =
  | {
      type: "exact_operation";
      connectionId: Id;
      operation: string;
      argumentsFingerprint: string;
    }
  | {
      type: "capability";
      connectionId: Id;
      capabilities: string[];
      constraints: ArgumentConstraint[];
    };
export interface ArgumentConstraint {
  pointer: string; // RFC 6901 JSON pointer; missing path denies
  allowedValues: JsonValue[]; // Exact JSON equality; AND across constraints
}
export type GrantDuration =
  | { type: "once"; logicalInvocationId: Id }
  | { type: "session"; sessionId: Id }
  | { type: "persistent" };
export interface AccessRequest {
  id: Id;
  caller: CallerContext;
  jobId: Id | null;
  operation: OperationIdentity;
  requestedScope: GrantScope;
  justification: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  state: "pending" | "approved" | "rejected" | "cancelled" | "expired";
  grantId: Id | null;
  decidedBy: Actor | null;
  reason: string | null;
}
export interface ApprovalGrant {
  id: Id;
  projectId: Id;
  requestId: Id;
  agentId: Id;
  approvedBy: Actor;
  approvedAt: Timestamp;
  duration: GrantDuration;
  scope: GrantScope;
  state: "active" | "reserved" | "consumed" | "revoked" | "expired";
  reservedInvocationId: Id | null;
  revokedAt: Timestamp | null;
  revokedBy: Actor | null;
}
export interface AuthorizationInput {
  caller: CallerContext;
  jobId: Id | null;
  operation: OperationIdentity;
}
export type AccessSource =
  | { type: "group"; groupId: Id; revision: Revision }
  | { type: "grant"; grantId: Id };
export type AuthorizationDecision =
  | { state: "allowed"; reservationId: Id; sources: AccessSource[] }
  | { state: "approval_required"; accessRequestId: Id }
  | { state: "denied"; reason: string };
export interface ExecutionPermit {
  id: Id; // Attempt-specific, one-use, trusted executor only
  reservationId: Id;
  invocationId: Id;
  attemptId: Id;
}
export type AuthorizationSettlement =
  | { state: "accepted"; receiptId: Id }
  | { state: "not_executed"; receiptId: Id; evidence: string }
  | { state: "uncertain"; receiptId: Id };
export interface AuthorizationService {
  checkCrew(
    caller: CallerContext,
    action: CrewAction,
    target: CrewTarget,
  ): Promise<{ state: "allowed" } | { state: "denied"; reason: string }>;
  requestAccess(
    input: AuthorizationInput,
    requestedScope: GrantScope,
    justification: string,
  ): Promise<AccessRequest>;
  authorizeAndReserve(
    input: AuthorizationInput,
  ): Promise<AuthorizationDecision>;
  beginAttempt(
    reservationId: Id,
    attemptId: Id,
  ): Promise<
    | { state: "allowed"; permit: ExecutionPermit }
    | { state: "denied"; reason: string }
  >;
  /** Executor redeems once immediately before dispatch; fresh revocation check. */
  redeem(
    permit: ExecutionPermit,
  ): Promise<{ state: "allowed" } | { state: "denied"; reason: string }>;
  settle(
    reservationId: Id,
    attemptId: Id,
    result: AuthorizationSettlement,
  ): Promise<void>;
  releaseNotExecuted(reservationId: Id, evidence: string): Promise<void>;
  decide(
    requestId: Id,
    approver: Actor,
    decision:
      | { state: "approved"; duration: GrantDuration; scope: GrantScope }
      | { state: "rejected"; reason: string },
  ): Promise<AccessRequest>;
  revoke(grantId: Id, actor: Actor, reason: string): Promise<void>;
  closeSession(
    caller: CallerContext,
    reason: "stop" | "restart" | "unverifiable_recovery",
  ): Promise<void>;
}
/** Control plane, never a runtime tool. Gateway owns handshake/refresh;
 * #89 alone stores secrets. Opaque handles convey no secret bytes to agents.
 */
export interface CredentialVault {
  withCredential<T>(
    credentialRef: string,
    use: (handle: TrustedCredentialHandle) => Promise<T>,
  ): Promise<T>;
  replace(
    connectionId: Id,
    expectedRevision: Revision,
    handle: TrustedCredentialHandle,
  ): Promise<Revision>;
}
export interface TrustedCredentialHandle {
  readonly opaqueHandle: string;
  /** Trusted broker callback only; never serialized or returned to runtime. */
  use<T>(authenticate: (material: Uint8Array) => Promise<T>): Promise<T>;
}
export interface EnvironmentPolicy {
  id: Id;
  projectId: Id;
  revision: Revision;
  enforcementConfigRef: string; // Actual runtime-enforced filesystem/process/network policy
}
export type RuntimeIsolationResult =
  | {
      state: "ready";
      runtimeAccess: RuntimeAccessBinding;
      checkedAt: Timestamp;
      evidenceRef: string;
    }
  | { state: "blocked"; reason: string; limitations: string[] };
export interface RuntimeAccessBinding {
  caller: CallerContext;
  environmentPolicies: RevisionReference[];
  runtimeConfigRef: string; // Sanitized runtime config, no upstream MCP/CLI auth
  privateWorkspaceRef: string;
  brokerBindingRef: string; // Session-bound authenticated gateway endpoint handle
}
export interface RuntimeAccessProvider {
  prepare(
    caller: CallerContext,
    configuration: ConfigurationSnapshot,
  ): Promise<RuntimeIsolationResult>;
  release(caller: CallerContext): Promise<void>;
}

// #90 owns discovery, trusted executors and durable operation receipts.
export interface BrokerInvocation extends AuthorizationInput {
  createdAt: Timestamp;
}
export type BrokerResult =
  | { state: "succeeded"; receiptId: Id; content: AgentContent[] }
  | { state: "approval_required"; accessRequestId: Id }
  | { state: "denied"; reason: string }
  | { state: "not_executed"; receiptId: Id; reason: string }
  | { state: "uncertain"; receiptId: Id; reason: string }
  | { state: "failed"; receiptId: Id; reason: string };
export type AttemptNumber = 1 | 2 | 3 | 4; // Original + at most three retries
export interface OperationAttempt {
  id: Id;
  number: AttemptNumber;
  startedAt: Timestamp;
  settledAt: Timestamp | null;
  outcome: "pending" | "succeeded" | "not_executed" | "uncertain" | "failed";
  evidenceRef: string | null;
}
export interface OperationReceipt {
  id: Id;
  caller: CallerContext;
  jobId: Id | null;
  operation: Omit<OperationIdentity, "arguments">;
  reservationId: Id | null;
  grantId: Id | null;
  attempts: OperationAttempt[];
  outcome: "pending" | "succeeded" | "not_executed" | "uncertain" | "failed";
  externalReference: string | null;
  verificationRef: string | null;
  startedAt: Timestamp;
  settledAt: Timestamp | null;
}
export type VerificationResult =
  | {
      state: "executed";
      externalReference: string | null;
      content: AgentContent[];
      evidenceRef: string;
    }
  | { state: "not_executed"; evidenceRef: string; explanation: string }
  | { state: "unknown"; reason: string };
export interface ServiceCapability {
  id: string; // Stable connection-ID + upstream-name mapping; never display-name authority
  connectionId: Id;
  upstreamName: string;
  description: string;
  inputSchema: JsonObject;
  outputSchema: JsonObject | null;
  verification: "read_only" | "unsupported";
}
export interface BrokerCallOptions {
  signal?: AbortSignal;
  onProgress?: (event: BrokerProgress) => void;
}
export interface BrokerProgress {
  invocationId: Id;
  attemptId: Id;
  label: string;
  detail: string | null;
}
/** Agent-facing service. Caller is bound by transport, not accepted from model JSON. */
export interface OperationBroker {
  listCapabilities(caller: CallerContext): Promise<ServiceCapability[]>;
  invoke(
    invocation: BrokerInvocation,
    options?: BrokerCallOptions,
  ): Promise<BrokerResult>;
  reconcile(caller: CallerContext, invocationId: Id): Promise<BrokerResult>;
  cancel(caller: CallerContext, invocationId: Id): Promise<BrokerResult>;
  settlement(projectId: Id, caller?: CallerContext): Promise<BrokerSettlement>;
}
/** Trusted-only; one actual attempt. Broker, not executor, owns retries. */
export interface ServiceExecutor {
  listCapabilities(connection: ServiceConnection): Promise<ServiceCapability[]>;
  execute(
    invocation: BrokerInvocation,
    permit: ExecutionPermit,
    options?: BrokerCallOptions,
  ): Promise<ExecutorResult>;
  verify(
    receipt: OperationReceipt,
    options?: BrokerCallOptions,
  ): Promise<VerificationResult>;
}
export type ExecutorResult =
  | {
      state: "succeeded";
      content: AgentContent[];
      externalReference: string | null;
    }
  | { state: "not_executed"; evidenceRef: string; reason: string }
  | { state: "uncertain"; verificationRef: string | null; reason: string }
  | { state: "failed"; externalReference: string | null; reason: string };
export interface BrokerSettlement {
  inFlightInvocationIds: Id[];
  uncertainInvocationIds: Id[];
  pendingApprovalIds: Id[];
  observedAt: Timestamp;
}

// #88 owns native Codex integration, transport and session lifecycle.
export interface ConfigurationSnapshot {
  profile: Agent["profile"];
  skills: Skill[]; // Enabled skills only, exact revisions
  permissionGroups: RevisionReference[]; // Descriptive, never authority cache
  serviceConnections: RevisionReference[];
  runtimeConfig: RevisionReference;
}
export interface RuntimeBinding extends CallerContext {
  threadId: string;
}
export interface RuntimeStartInput {
  caller: CallerContext;
  thread: { mode: "create" } | { mode: "resume"; threadId: string };
  modelAccess: ModelAccess; // Runtime-managed subscription reference only
  configuration: ConfigurationSnapshot;
  access: RuntimeAccessBinding;
  instructionRefresh?: {
    intent: "start" | "restart";
    previousInstructionsDigest: string | null;
  };
  onInstructionPreparation?: (
    preparation: InstructionPreparation,
  ) => Promise<void>;
}
export interface RuntimeError {
  code:
    | "unsupported"
    | "missing_thread"
    | "identity_mismatch"
    | "configuration_rejected"
    | "isolation_blocked"
    | "disconnected"
    | "native_approval_required"
    | "cancelled"
    | "runtime_error";
  message: string; // Bounded and sanitized
}
export type RuntimeResult<T> =
  | { state: "acknowledged"; value: T }
  | { state: "failed"; error: RuntimeError };
export interface RuntimeStartAcknowledgement {
  binding: RuntimeBinding;
  appliedConfiguration: AppliedConfiguration; // Only after native acknowledgement
  observedAt: Timestamp;
}
export type RuntimeStartResult =
  | { state: "acknowledged"; value: RuntimeStartAcknowledgement }
  | {
      state: "failed" | "uncertain";
      error: RuntimeError;
      retainedThreadId: string | null;
      nativeDispatched?: false; // Explicit adapter proof that no native process/request began
    };
export type DeliveryResult =
  | {
      state: "acknowledged";
      runtimeMessageRef: string | null;
      turnId: string;
      acknowledgedAt: Timestamp;
    }
  | { state: "not_sent"; error: RuntimeError }
  | { state: "uncertain"; error: RuntimeError };
export interface RuntimeDeliveryInput {
  binding: RuntimeBinding;
  attemptId: Id;
  message: Pick<
    AgentMessage,
    | "id"
    | "sender"
    | "recipientAgentId"
    | "jobId"
    | "replyToMessageId"
    | "kind"
    | "content"
    | "deliveryMode"
  >;
  expectedTurnId: string | null; // Non-null for active steer; null for idle delivery
}
export interface AgentRuntimeAdapter {
  capabilities: {
    activeTurnSteering: boolean;
    instructionApplication: "on_resume" | "unsupported";
  };
  start(input: RuntimeStartInput): Promise<RuntimeStartResult>;
  stop(
    binding: RuntimeBinding,
  ): Promise<RuntimeResult<{ stoppedAt: Timestamp }>>;
  deliver(input: RuntimeDeliveryInput): Promise<DeliveryResult>;
  reconcileDelivery(
    binding: RuntimeBinding,
    attempt: DeliveryAttempt,
  ): Promise<DeliveryResult>;
  readHistory(
    binding: RuntimeBinding,
    cursor?: string,
  ): Promise<
    RuntimeResult<{
      items: RuntimeHistoryItem[];
      nextCursor: string | null;
    }>
  >;
  respondToNativeApproval(
    binding: RuntimeBinding,
    approvalId: string,
    response: JsonValue,
  ): Promise<RuntimeResult<null>>;
  cancelTurn(
    binding: RuntimeBinding,
    turnId: string,
  ): Promise<RuntimeResult<null>>;
  observe(binding: RuntimeBinding): AsyncIterable<RuntimeEvent>;
}
export interface RuntimeHistoryItem {
  /** Native item time, or its containing turn start when only turn timing exists. */
  timestamp?: Timestamp;
  timestampSource?: "native_item" | "native_turn";
  runtimeRef: string;
  turnId: string | null;
  kind: "message" | "tool" | "approval" | "other";
  sender:
    | MessageSender
    | { type: "assistant"; agentId: Id }
    | { type: "system" }
    | { type: "unattributed_native"; nativeRole: string }
    | { type: "tool"; name: string };
  content: AgentContent[];
  metadata: JsonObject; // Sanitized display data; no private reasoning
}
export type RuntimeEvent = {
  binding: RuntimeBinding;
  observedAt: Timestamp;
} & (
  | {
      kind: "turn";
      turnId: string;
      state: "started" | "completed" | "cancelled" | "failed";
    }
  | { kind: "history"; item: RuntimeHistoryItem }
  | {
      kind: "native_approval";
      approvalId: string;
      turnId: string;
      request: JsonObject;
    }
  | { kind: "delivery"; attemptId: Id; result: DeliveryResult }
  | { kind: "configuration"; state: "rejected"; error: RuntimeError }
  | {
      kind: "connection";
      state: "connected" | "disconnected";
      error: RuntimeError | null;
    }
);
export interface PreparationReadiness {
  preparationId: Id;
  requiredAfter: Timestamp;
  agentId: Id;
  sessionId: Id;
  state: "pending" | "ready" | "blocked";
  continuationSavedAt: Timestamp | null;
  detail: string | null;
}
export interface ExecutionReservation {
  id: Id;
  projectId: Id;
  reason: "quit" | "restart" | "update";
  acquiredAt: Timestamp;
}
/** #88 composes these ports. Preparation never reserves or tears down resources. */
export interface AgentLifecycle {
  start(agentId: Id): Promise<RuntimeStartResult>;
  stop(agentId: Id): Promise<RuntimeResult<null>>;
  restart(agentId: Id): Promise<RuntimeStartResult>;
  prepare(
    projectId: Id,
    reason: ExecutionReservation["reason"],
  ): Promise<PreparationReadiness[]>;
  reserveExecution(
    projectId: Id,
    reason: ExecutionReservation["reason"],
  ): Promise<
    | { state: "reserved"; reservation: ExecutionReservation }
    | { state: "blocked"; reason: string }
  >;
  releaseExecution(reservationId: Id): Promise<void>;
}

// #88 usability amendments: one production composition, owner-approved creation.
export interface ProjectAgentSettings {
  projectId: Id;
  revision: Revision;
  primaryAgentId: Id | null;
  /** Owner-selected direct contact; absent/null falls back to the primary agent. */
  contactAgentId?: Id | null;
}
/** Access owns this data and its revision-checked administration. No credentials. */
export interface AgentCreationPreset {
  id: Id;
  projectId: Id;
  revision: Revision;
  name: string;
  enabled: boolean;
  profile: Omit<Agent["profile"], "revision">;
  skills: Agent["skills"];
  modelAccessId: Id;
  configRef: string;
  permissionGroupIds: Id[];
  serviceConnectionIds: Id[];
  /** Exact owner-approved template revision; assigning it runs no preparation. */
  environmentTemplate?: { id: Id; revision: Revision };
}
/** The same instance serializes native admission, permit redemption and the final
 * lifecycle reservation. Callbacks must not recursively acquire this gate. */
export interface ExecutionAdmissionGate {
  run<T>(operation: () => Promise<T>): Promise<T>;
}
/** Trusted composition port. Access is the only assignment/preset authority. */
export interface AgentProvisioning {
  listPresets(): Promise<AgentCreationPreset[]>;
  applyPreset(input: {
    actor: Actor;
    agentId: Id;
    presetId: Id;
    expectedPresetRevision: Revision;
  }): Promise<Agent["access"]>;
  accessFor(agentId: Id): Promise<Agent["access"]>;
}
/** Skill storage/UI are owned by #34/#95; the runtime consumes exact revisions. */
export interface ProjectSkillSource {
  list(): Promise<Skill[]>;
  resolve(skillId: Id, revision: Revision): Promise<{ nativePath: string }>;
}
/** Explicit environment operations. No job/status/lifecycle inference. */
export interface AgentEnvironmentService {
  resources?(agentId: Id): Agent["resources"] | Promise<Agent["resources"]>;
  list?(caller: CallerContext, agentId: Id): Promise<JsonValue>;
  invoke(input: {
    caller: CallerContext;
    agentId: Id;
    action:
      | "create"
      | "attach"
      | "execute"
      | "dispose"
      | "prepare"
      | "start"
      | "status"
      | "stop";
    requestId: Id;
    arguments: JsonObject;
  }): Promise<JsonValue>;
}
