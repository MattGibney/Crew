import type {
  Agent,
  CrewAction,
  CrewPermission,
  PermissionGroup,
} from "../agents/contracts.mjs";

/** Guided setup stores intent and receipts only. Access remains authoritative. */
export type AgentFolderAccess = "none" | "read_only" | "read_write";
export interface AgentSetupDraft {
  step: number;
  mode: "create" | "repair";
  agentId: string | null;
  name: string;
  instructions: string;
  personality: string;
  pictureRef: string | null;
  voice: string | null;
  skills: Agent["skills"];
  folderAccess: AgentFolderAccess;
  groupMode: "new" | "existing";
  groupName: string;
  /** Existing memberships to retain; new mode adds a named group to this list. */
  groupIds: string[];
  /** Grants for the new group only. Existing groups are never rewritten here. */
  crewActions: CrewAction[];
  serviceConnectionIds: string[];
  serviceCapabilities: { connectionId: string; capabilities: string[] }[];
  makePrimary: boolean;
}
export interface AgentSetupReview {
  draftRevision: number;
  directory: string;
  folderAccess: AgentFolderAccess;
  groups: PermissionGroup[];
  /** Exact proposed additional group, without its folder policy until approval. */
  newGroup: {
    id: string;
    name: string;
    grants: PermissionGroup["grants"];
  } | null;
  connections: { id: string; name: string; revision: number }[];
  workspaces: {
    policyId: string;
    revision: number;
    directory: string;
    access: Exclude<AgentFolderAccess, "none">;
  }[];
  crewGrants: CrewPermission[];
  serviceCapabilities: { connectionId: string; capabilities: string[] }[];
  warnings: string[];
  revisions: {
    groups: { id: string; revision: number }[];
    connections: { id: string; revision: number }[];
    policies: { id: string; revision: number }[];
    assignment: number | null;
    projectSettings: number;
    profile: number | null;
    skills?: { id: string; revision: number }[];
  };
}
export interface AgentSetupRecord {
  id: string;
  revision: number;
  draft: AgentSetupDraft;
  phase: "draft" | "reviewed" | "applying" | "complete";
  review: AgentSetupReview | null;
  result: {
    agentId: string;
    mode: "create" | "repair";
    primary: boolean;
  } | null;
  error: string | null;
}
export type SetupRecord = AgentSetupRecord;
export type AgentSetupState = AgentSetupRecord;
export interface AgentSetupRequests {
  "setup.read": Record<string, never>;
  "setup.open": {
    expectedRevision: number | null;
    mode: "create" | "repair";
    agentId?: string;
  };
  "setup.new": {
    expectedRevision: number | null;
    mode: "create" | "repair";
    agentId?: string;
  };
  "setup.save": { expectedRevision: number | null; draft: AgentSetupDraft };
  /** Discard only the current unapplied editor draft; never changes an agent. */
  "setup.discard": { expectedRevision: number };
  "setup.review": { expectedRevision: number };
  "setup.complete": { expectedRevision: number };
}
