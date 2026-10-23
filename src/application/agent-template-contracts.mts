/** Owner presentation subset of the project environment-template catalogue.
 * The catalogue remains the sole definition/version/assignment authority.
 * These views omit commands, environment values and host directory settings.
 */
export interface AgentTemplateDefinitionView {
  id: string;
  revision: number;
  name: string;
  description: string;
  tools: {
    name: "node" | "npm";
    versionRequirement: string | null;
  }[];
  capabilities: {
    packageDownloads: boolean;
    network: boolean;
    localhostPorts: number[];
  };
}

export interface AgentTemplateAssignmentView {
  agentId: string;
  revision: number;
  templateId: string | null;
  templateRevision: number | null;
  updatedAt: string;
}

/** Route: environments.templates.snapshot {}. Latest definitions only. */
export interface AgentTemplateSnapshotView {
  templates: AgentTemplateDefinitionView[];
  assignments: AgentTemplateAssignmentView[];
}

/** Route: environments.templates.assign <this direct input>.
 * Returns the canonical saved AgentTemplateAssignmentView. No preparation.
 */
export interface AgentTemplateAssignmentInput {
  agentId: string;
  expectedRevision: number | null;
  templateId: string | null;
  templateRevision: number | null;
}
