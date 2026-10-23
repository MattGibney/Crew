import type {
  AccessRequest,
  Actor,
  Agent,
  AgentCreationPreset,
  ApprovalGrant,
  CrewAction,
  EnvironmentPolicy,
  PermissionGroup,
  ServiceCapability,
  ServiceConnection,
  Skill,
} from "../agents/contracts.mjs";

/** Owner UI DTOs only. Never imports the vault or server implementation. */
export interface OwnerConnectionSetupChoice {
  id: string;
  label: string;
  service: string;
  transport: ServiceConnection["transport"];
  authenticationMethods: ServiceConnection["authentication"]["method"][];
  guide?: {
    credentialLabel: string;
    credentialUrl: string;
    documentationUrl: string;
    accountOwnership: { personal: string; dedicated: string };
    steps: string[];
  };
}
export interface OwnerConnectionVerification {
  requestId: string;
  verificationId: string | null;
  connectionId: string;
  expiresAt: string;
  state: "verifying" | "verified" | "failed" | "cancelled" | "saved";
  identity: ServiceConnection["identity"] | null;
  identityStatus: "verified" | "unavailable";
  capabilities: ServiceCapability[];
  capabilitiesStatus: "verified" | "unavailable";
  accountKind: "personal" | "dedicated";
  name: string;
  setupChoiceId: string;
  reason: string | null;
}
export interface OwnerConnectionAccessSelection {
  requestId: string;
  verificationId: string;
  groupSelections: {
    groupId: string;
    expectedRevision: number;
    capabilityIds: string[];
  }[];
  agentSelections: {
    agentId: string;
    expectedRevision: number | null;
    permissionGroupIds: string[];
  }[];
}
export interface OwnerRuntimeDefaults {
  modelAccessId: string;
  configRef: string;
}
export interface OwnerCatalogueSnapshot {
  state: "available" | "undiscovered" | "failed";
  capabilities: ServiceCapability[];
}
export interface AccessOwnerView {
  projectId: string;
  agents: Agent[];
  /** Trusted host configuration, not a model credential or an agent-supplied reference. */
  runtimeDefaults: OwnerRuntimeDefaults | null;
  groups: PermissionGroup[];
  skills?: Skill[];
  presets: AgentCreationPreset[];
  creationDefaults: { revision: number; presetId: string | null };
  assignments: {
    agentId: string;
    permissionGroupIds: string[];
    serviceConnectionIds: string[];
    revision: number;
  }[];
  connections: ServiceConnection[];
  environmentPolicies: EnvironmentPolicy[];
  requests: AccessRequest[];
  grants: ApprovalGrant[];
  audit: {
    id: string;
    at: string;
    actor: Actor | null;
    action: string;
    subjectId: string;
  }[];
  setupChoices: OwnerConnectionSetupChoice[];
  capabilities: ServiceCapability[];
  catalogue: { connectionId: string; state: OwnerCatalogueSnapshot["state"] }[];
  crewCapabilities: {
    action: CrewAction;
    label: string;
    description: string;
  }[];
  canVerifyConnections: boolean;
  canGuideConnections?: boolean;
  connectionSetups?: OwnerConnectionVerification[];
}
