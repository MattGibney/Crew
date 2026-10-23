import type { CrewAction } from "../agents/contracts.mjs";

// Creation and catalogue operations address the project rather than an existing
// agent. This target shape does not restrict group capability authority.
const projectActions = new Set<CrewAction>([
  "agents.create",
  "jobs.read",
  "jobs.create",
  "skills.read",
  "skills.write",
  "resources.read",
  "browser.control",
  "environments.create",
]);
export function crewActionRequiresProject(action: CrewAction): boolean {
  return projectActions.has(action);
}
