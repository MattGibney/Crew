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
} from "../agents/contracts.mjs";

/** Owner UI DTOs only. Never imports the vault or server implementation. */
export interface OwnerConnectionSetupChoice {
  id: string;
  label: string;
  service: string;
  transport: ServiceConnection["transport"];
  authenticationMethods: ServiceConnection["authentication"]["method"][];
}
export interface OwnerRuntimeDefaults {
  modelAccessId: string;
  configRef: string;
}
export interface AccessOwnerView {
  projectId: string;
  agents: Agent[];
  /** Trusted host configuration, not a model credential or an agent-supplied reference. */
  runtimeDefaults: OwnerRuntimeDefaults | null;
  groups: PermissionGroup[];
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
  catalogue: { connectionId: string; state: "available" | "unavailable" }[];
  crewCapabilities: {
    action: CrewAction;
    label: string;
    description: string;
  }[];
  canVerifyConnections: boolean;
}
