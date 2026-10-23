import { randomUUID } from "node:crypto";
import type { Agent, PermissionGroup } from "../agents/contracts.mjs";
import type { AccessState } from "./state.mjs";

export function memberGroups(
  state: Pick<AccessState, "groups">,
  groupIds: readonly string[],
): PermissionGroup[] {
  return state.groups.filter((group) => groupIds.includes(group.id));
}
export function connectionIds(
  state: Pick<AccessState, "groups">,
  groupIds: readonly string[],
): string[] {
  return [
    ...new Set(
      memberGroups(state, groupIds).flatMap((group) =>
        group.grants.services.map((grant) => grant.connectionId),
      ),
    ),
  ];
}
export function skillSelections(
  state: Pick<AccessState, "groups">,
  groupIds: readonly string[],
): Agent["skills"] {
  return [
    ...new Set(
      memberGroups(state, groupIds).flatMap(
        (group) => group.grants.skillIds ?? [],
      ),
    ),
  ].map((skillId) => ({ skillId, enabled: true }));
}
function compatibilityGroup(
  state: AccessState,
  name: string,
  services: PermissionGroup["grants"]["services"],
  skillIds: string[] = [],
): string {
  const id = randomUUID(),
    at = new Date().toISOString();
  state.groups.push({
    id,
    projectId: state.projectId,
    name: name.slice(0, 256),
    description:
      "Compatibility group preserves the exact earlier individual selection. Review memberships and grants in Settings.",
    revision: 1,
    updatedAt: at,
    grants: { crew: [], services, environmentPolicyIds: [], skillIds },
  });
  state.audit.push({
    id: randomUUID(),
    at,
    actor: null,
    action: "group.created-from-individual-selection",
    subjectId: id,
  });
  return id;
}
/** Preserve the old intersection: group operations AND individual connections.
 * Never expose a legacy shared service grant to previously unassigned members. */
export function migrateGroupDerivedAccess(state: AccessState): void {
  if (state.groupAccessVersion === 1) return;
  const original = structuredClone(state.groups);
  const selections = [
    ...state.assignments.map((row) => ({
      row,
      name: `Retained agent access ${row.agentId}`,
      skills: [] as Agent["skills"],
    })),
    ...state.presets.map((row) => ({
      row,
      name: `Retained preset access ${row.name}`,
      skills: row.skills,
    })),
  ];
  for (const { row, name, skills } of selections) {
    const services = row.serviceConnectionIds
      .filter((id) =>
        state.connections.some((connection) => connection.id === id),
      )
      .map((id) => ({
        connectionId: id,
        capabilities: [
          ...new Set(
            original
              .filter((group) => row.permissionGroupIds.includes(group.id))
              .flatMap((group) =>
                group.grants.services
                  .filter((grant) => grant.connectionId === id)
                  .flatMap((grant) => grant.capabilities),
              ),
          ),
        ],
      }));
    const enabled = skills
      .filter((skill) => skill.enabled)
      .map((skill) => skill.skillId);
    if (services.length || enabled.length)
      row.permissionGroupIds.push(
        compatibilityGroup(state, name, services, enabled),
      );
    row.serviceConnectionIds = [];
    row.revision++;
  }
  for (const group of state.groups) {
    if (
      !original.some((row) => row.id === group.id) ||
      !group.grants.services.length
    )
      continue;
    group.grants.services = [];
    group.revision++;
    group.updatedAt = new Date().toISOString();
  }
  state.pendingLegacySkillAgentIds = state.assignments.map(
    (row) => row.agentId,
  );
  state.groupAccessVersion = 1;
  state.audit.push({
    id: randomUUID(),
    at: new Date().toISOString(),
    actor: null,
    action: "access.converted-to-group-derived-authority",
    subjectId: state.projectId,
  });
}
/** Foundation records remain provenance. This runs before any native/gateway startup. */
export function migrateLegacyAgentSkills(
  state: AccessState,
  agents: Agent[],
): void {
  if (!state.pendingLegacySkillAgentIds) return;
  for (const agentId of agents.map((agent) => agent.id)) {
    const agent = agents.find((row) => row.id === agentId);
    if (!agent)
      throw new Error(
        "Legacy agent skill migration requires its retained foundation record.",
      );
    const enabled = agent.skills
      .filter((skill) => skill.enabled)
      .map((skill) => skill.skillId);
    let assignment = state.assignments.find((row) => row.agentId === agentId);
    if (!assignment) {
      assignment = {
        agentId,
        permissionGroupIds: [],
        serviceConnectionIds: [],
        revision: 1,
      };
      state.assignments.push(assignment);
    }
    if (enabled.length) {
      assignment.permissionGroupIds.push(
        compatibilityGroup(
          state,
          `Retained skills for ${agent.profile.name}`,
          [],
          enabled,
        ),
      );
      assignment.revision++;
    }
  }
  delete state.pendingLegacySkillAgentIds;
}
