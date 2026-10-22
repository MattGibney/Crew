export interface ArchiveCandidate {
  id?: string;
  status?: string;
  execution?: { live?: boolean | null } | null;
  lifecycleRequests?: { status: string }[];
  archivedAt?: string;
  disposedAt?: string;
  removedAt?: string;
}
// Shared projections only. Archiving never changes or deletes retained evidence.
export function isArchivedTask(task: ArchiveCandidate | null | undefined) {
  return (
    Boolean(task?.archivedAt) ||
    ["disposed", "removed", "archived"].includes(task?.status || "")
  );
}

export function archiveTime(task: ArchiveCandidate | null | undefined) {
  for (const value of [task?.archivedAt, task?.disposedAt, task?.removedAt]) {
    if (typeof value === "string" && Number.isFinite(Date.parse(value)))
      return value;
  }
  return null;
}

export const activeTasks = <T extends ArchiveCandidate>(
  tasks: readonly T[] | null | undefined,
): T[] =>
  (Array.isArray(tasks) ? tasks : []).filter((task) => !isArchivedTask(task));
export const archivedTasks = <T extends ArchiveCandidate>(
  tasks: readonly T[] | null | undefined,
): T[] =>
  (Array.isArray(tasks) ? tasks : []).filter(isArchivedTask).sort((a, b) => {
    const aTime = archiveTime(a),
      bTime = archiveTime(b);
    return (
      (bTime ? Date.parse(bTime) : -Infinity) -
        (aTime ? Date.parse(aTime) : -Infinity) ||
      String(a.id).localeCompare(String(b.id))
    );
  });
