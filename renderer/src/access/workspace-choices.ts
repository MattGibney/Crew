import type { WorkspacePermissionChoice } from "./types";

/** Equivalent legacy IDs stay valid; one choice represents their exact shared
 * folder identity and enforcement configuration. Unknown metadata never merges. */
export function groupWorkspaceChoices(
  rows: readonly WorkspacePermissionChoice[],
) {
  const result = new Map<
    string,
    WorkspacePermissionChoice & { policyIds: string[] }
  >();
  for (const row of rows) {
    const key = row.configurationKey ?? `policy:${row.policy.id}`;
    const existing = result.get(key);
    if (existing) existing.policyIds.push(row.policy.id);
    else result.set(key, { ...row, policyIds: [row.policy.id] });
  }
  const choices = [...result.values()];
  return choices.map((choice) =>
    choices.some(
      (other) =>
        other !== choice &&
        other.label === choice.label &&
        other.description === choice.description,
    )
      ? {
          ...choice,
          description: `${choice.description} · Policy ${choice.policy.id}`,
        }
      : choice,
  );
}
