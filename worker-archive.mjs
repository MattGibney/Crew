// Shared projections only. Archiving never changes or deletes retained evidence.
export function isArchivedTask(task) {
  if (!task || task.execution?.live === true || task.lifecycleRequests?.some(request => ['pending', 'processing'].includes(request.status))) return false;
  return ['disposed', 'removed', 'archived'].includes(task.status);
}

export function archiveTime(task) {
  for (const value of [task?.archivedAt, task?.disposedAt, task?.removedAt]) {
    if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return value;
  }
  return null;
}

export const activeTasks = tasks => (Array.isArray(tasks) ? tasks : []).filter(task => !isArchivedTask(task));
export const archivedTasks = tasks => (Array.isArray(tasks) ? tasks : []).filter(isArchivedTask).sort((a, b) => {
  const aTime = archiveTime(a), bTime = archiveTime(b);
  return (bTime ? Date.parse(bTime) : -Infinity) - (aTime ? Date.parse(aTime) : -Infinity) || String(a.id).localeCompare(String(b.id));
});
