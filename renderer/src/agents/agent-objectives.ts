import type { Job } from "../../../src/agents/contracts.mjs";

/** Personal local work only: external tickets and delegated work are separate. */
export function agentObjectives(jobs: Job[], agentId: string) {
  const own = jobs.filter(
    (job) =>
      job.work.type === "local" && job.assignment.assignedToAgentId === agentId,
  );
  const newest = (a: Job, b: Job) => b.updatedAt.localeCompare(a.updatedAt);
  return {
    notStarted: own
      .filter((job) => job.progress.status === "not_started")
      .toSorted(newest),
    inProgress: own
      .filter((job) =>
        ["in_progress", "blocked", "ready"].includes(job.progress.status),
      )
      .toSorted(newest),
    completed: own
      .filter((job) => job.progress.status === "completed")
      .toSorted((a, b) => {
        const completedAt = (job: Job) =>
          job.work.type === "local"
            ? (job.work.outcome?.recordedAt ?? job.updatedAt)
            : job.updatedAt;
        return completedAt(b).localeCompare(completedAt(a));
      })
      .slice(0, 5),
  };
}
