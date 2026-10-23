import type {
  Agent,
  AgentContent,
  AgentCreationPreset,
  ProjectAgentSettings,
  Actor,
  AgentMessage,
  DeliveryMode,
  ExecutionReservation,
  HelpRequest,
  Id,
  Job,
  JsonObject,
  JsonValue,
  MessageReceipt,
  PreparationReadiness,
  RuntimeEvent,
  RuntimeHistoryItem,
  RuntimeResult,
  RuntimeStartResult,
  ServiceConnectionView,
  Skill,
} from "../../../src/agents/contracts.mjs";
import type { VoiceArtifactPage } from "../../../src/agents/owner-api.mjs";

/** Disposable renderer projection. Native history is read separately, never persisted here. */
export interface AgentsSnapshot {
  projectId: Id;
  projectName: string;
  ownerId: Id;
  /** null/absent means this host has no retained voice artifact capability. */
  voiceArtifactsRevision?: number | null;
  /** Explicit project selection; absence is setup, never inferred from agent order. */
  primaryAgentId?: Id | null;
  projectSettings?: ProjectAgentSettings;
  creationPresets?: AgentCreationPreset[];
  agents: Agent[];
  jobs: Job[];
  skills: Skill[];
  pendingMessages: AgentMessage[];
  receipts: MessageReceipt[];
  helpRequests: HelpRequest[];
  ownerInbox: { helpRequestId: Id; content: AgentContent[] }[];
  nativeApprovals: {
    agentId: Id;
    approvalId: string;
    turnId: string;
    request: JsonObject;
    state?: "pending" | "responding" | "uncertain";
    /** Only supplied when native request declares exact supported choices. */
    choices?: { label: string; response: JsonValue }[];
  }[];
  readiness: PreparationReadiness[];
  serviceConnections?: ServiceConnectionView[];
}

export type ProfileInput = Omit<Agent["profile"], "revision">;
export interface SaveProfileInput {
  expectedRevision: number;
  profile: ProfileInput;
  skills: Agent["skills"];
}
export interface CreateAgentInput {
  presetId: Id;
  expectedPresetRevision: number;
  name?: string;
  reportsTo?: Actor;
}
export interface SendMessageInput {
  recipientAgentId: Id;
  jobId: Id | null;
  replyToMessageId: Id | null;
  content: AgentContent[];
  deliveryMode: DeliveryMode;
}
export interface CreateJobInput {
  work:
    | { type: "local"; title: string; objective: string }
    | Extract<Job["work"], { type: "ticket" }>;
  assignedToAgentId: Id | null;
  instruction: string | null;
}
export type AgentsClientEvent =
  { kind: "changed" } | { kind: "runtime"; event: RuntimeEvent };

/** Owner control plane. The server authenticates the owner; no actor is supplied by forms. */
export interface AgentsClient {
  selectContact?(
    agentId: Id | null,
    expectedRevision: number,
  ): Promise<unknown>;
  recoverSession?(agentId: Id): Promise<RuntimeResult<null>>;
  readSnapshot(): Promise<AgentsSnapshot>;
  readVoiceArtifacts?(
    agentId: Id,
    cursor?: string,
  ): Promise<RuntimeResult<VoiceArtifactPage>>;
  subscribe(listener: (event: AgentsClientEvent) => void): () => void;
  readHistory(
    agentId: Id,
    cursor?: string,
  ): Promise<
    RuntimeResult<{
      items: RuntimeHistoryItem[];
      nextCursor: string | null;
    }>
  >;
  createAgent(input: CreateAgentInput): Promise<Agent>;
  saveProfile(agentId: Id, input: SaveProfileInput): Promise<Agent>;
  lifecycle(
    agentId: Id,
    action: "start" | "stop" | "restart",
  ): Promise<RuntimeStartResult | RuntimeResult<null>>;
  sendMessage(input: SendMessageInput): Promise<unknown>;
  reconcileMessage(messageId: Id): Promise<unknown>;
  retryMessage?(messageId: Id): Promise<unknown>;
  respondToHelp(helpId: Id, content: AgentContent[]): Promise<unknown>;
  respondToNativeApproval(
    agentId: Id,
    approvalId: string,
    response: JsonValue,
  ): Promise<RuntimeResult<null>>;
  createJob(input: CreateJobInput): Promise<Job>;
  assignJob(
    jobId: Id,
    agentId: Id | null,
    instruction: string | null,
  ): Promise<Job>;
  archiveAgent(agentId: Id): Promise<unknown>;
  prepare(
    reason: ExecutionReservation["reason"],
  ): Promise<PreparationReadiness[]>;
  /** Resolves only already-authorized artifact references; never returns a credential. */
  artifactUrl?(fileRef: string): string | null;
  /** Private project picture bytes pass through the authenticated owner channel. */
  saveImage?(picture: string): Promise<{ imageRef: string }>;
  readImage?(imageRef: string): Promise<{ picture: string } | null>;
}
