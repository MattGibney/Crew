/** Identity and enforcement configuration, deliberately excluding policy IDs and
 * revisions. Policy IDs remain authoritative references in groups and history. */
export interface WorkspaceIdentityRecord {
  policy: { id: string; projectId: string };
  workspace: { path: string; device: number; inode: number };
  writable: boolean;
  executableDirectories: { path: string; device: number; inode: number }[];
  managedWorktreeRoot: { path: string; device: number; inode: number } | null;
  gitDirectory: { path: string; device: number; inode: number } | null;
}
export function workspaceConfigurationKey(
  row: WorkspaceIdentityRecord,
): string {
  const identity = (value: WorkspaceIdentityRecord["workspace"] | null) =>
    value && [value.path, value.device, value.inode];
  return JSON.stringify([
    row.policy.projectId,
    identity(row.workspace),
    row.writable,
    row.executableDirectories
      .map(identity)
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    identity(row.managedWorktreeRoot),
    identity(row.gitDirectory),
  ]);
}
/** Presentation grouping only: no durable record or reference is rewritten. */
export function equivalentWorkspaceChoices<T extends WorkspaceIdentityRecord>(
  rows: readonly T[],
) {
  const grouped = new Map<string, { workspace: T; policyIds: string[] }>();
  for (const row of rows) {
    const key = workspaceConfigurationKey(row);
    const choice = grouped.get(key);
    if (choice) choice.policyIds.push(row.policy.id);
    else grouped.set(key, { workspace: row, policyIds: [row.policy.id] });
  }
  return [...grouped.values()];
}
export function workspaceConfigurationDescription(
  row: WorkspaceIdentityRecord,
): string {
  return [
    row.writable ? "Read and write files" : "Read files only",
    row.executableDirectories.length
      ? `Tools: ${row.executableDirectories.map((entry) => entry.path).join(", ")}`
      : "No additional tool directories",
    row.managedWorktreeRoot
      ? `Managed worktrees: ${row.managedWorktreeRoot.path}`
      : "No managed worktree creation",
  ].join(" · ");
}
