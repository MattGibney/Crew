import type { CrewAction, CrewPermission } from "../agents/contracts.mjs";

type CrewScopeType = CrewPermission["scope"]["type"];

// Creation and catalogue operations address the project rather than an existing
// agent. Keep the editor's choices and authorization target check in one place.
const projectActions = new Set<CrewAction>([
  "agents.create",
  "jobs.read",
  "jobs.create",
  "skills.read",
  "skills.write",
  "browser.control",
  "environments.create",
]);
const projectScopes: readonly CrewScopeType[] = ["project"];
const agentScopes: readonly CrewScopeType[] = ["self", "agents", "project"];

export function crewActionRequiresProject(action: CrewAction): boolean {
  return projectActions.has(action);
}

export function crewPermissionScopes(
  action: CrewAction,
): readonly CrewScopeType[] {
  return crewActionRequiresProject(action) ? projectScopes : agentScopes;
}

export function defaultCrewPermissionScope(
  action: CrewAction,
): CrewPermission["scope"] {
  return { type: crewActionRequiresProject(action) ? "project" : "self" };
}
