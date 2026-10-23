import type {
  Agent,
  AuthorizationService,
  CrewPermission,
  EnvironmentPolicy,
  PermissionGroup,
  Revision,
  ServiceConnection,
} from "../../../src/agents/contracts.mjs";
import type { OwnerConnectionSetupChoice } from "../../../src/access/owner-contracts.mjs";

/** Presentation gating only. The owner transport must authenticate every callback. */
export interface OwnerPanelProps {
  isOwner: boolean;
  onNotify: (message: string) => void;
}

export type GroupDraft = Pick<
  PermissionGroup,
  "name" | "description" | "grants"
>;
export type GroupSave = {
  id: PermissionGroup["id"] | null;
  expectedRevision: Revision | null;
  draft: GroupDraft;
};

/** Labels come from the current Crew catalogue; actions retain canonical types. */
export type CrewPermissionChoice = {
  action: CrewPermission["action"];
  label: string;
  description: string;
};

/** Owner-approved workspace metadata; never a user-entered policy identity. */
export type WorkspacePermissionChoice = {
  policy: EnvironmentPolicy;
  /** Exact canonical directory identity and enforcement configuration. */
  configurationKey?: string;
  label: string;
  description: string;
};

/** Trusted gateway configuration choices, never arbitrary shell commands or paths. */
export type ConnectionSetupChoice = OwnerConnectionSetupChoice;

export type ConnectionDraft = Pick<
  ServiceConnection,
  "name" | "service" | "identity" | "transport"
> & {
  authenticationMethod: ServiceConnection["authentication"]["method"];
};

/** Private owner-entry data. Never persist, log, forward to an agent, or echo in errors. */
export type ConnectionSave = {
  id: ServiceConnection["id"] | null;
  expectedRevision: Revision | null;
  draft: ConnectionDraft;
  /** null retains the current credential; a string is new private credential material. */
  credential: string | null;
};

export type AssignmentSave = {
  agentId: Agent["id"];
  expectedRevision: Revision | null;
  permissionGroupIds: Agent["access"]["permissionGroupIds"];
  /** Deprecated compatibility input; memberships alone determine connections. */
  serviceConnectionIds?: Agent["access"]["serviceConnectionIds"];
};

export type AccessDecision = Parameters<AuthorizationService["decide"]>[2];
