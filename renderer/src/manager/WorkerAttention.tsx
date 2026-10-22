import type { ManagerProps, WorkerTask } from "../contracts/manager.js";

import { useEffect, useState } from "react";
import {
  ArrowUpRight,
  Clock3,
  FolderGit2,
  Hand,
  Layers,
  LoaderCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  workspaceWorkers,
  currentAssignment,
  queuedAssignments,
  formatElapsed,
  groupWorkers,
  pendingAttention,
  workerProgress,
  workerWorkflow,
  workerStatus,
  workerTiming,
} from "./worker-model.js";

export function WorkerStatus({ task }: { task: WorkerTask }) {
  const tone = ["failed", "blocked"].includes(task.status)
    ? "border-destructive/25 bg-destructive/10 text-destructive"
    : ["awaiting_answer", "paused"].includes(task.status) ||
        pendingAttention(task).length
      ? "border-chart-4/35 bg-chart-4/10 text-foreground"
      : task.status === "completed"
        ? "border-chart-2/30 bg-chart-2/10 text-foreground"
        : ["running", "launching", "verifying"].includes(task.status)
          ? "border-primary/20 bg-primary/10 text-primary"
          : "border-border bg-muted text-muted-foreground";
  const workflow = workerWorkflow(task);
  return (
    <>
      {workflow && (
        <Badge
          variant="outline"
          aria-label={`Workflow: ${workflow}`}
          title={workflow}
          className="max-w-64 text-[10px]"
        >
          <span className="truncate">{workflow}</span>
        </Badge>
      )}
      <Badge
        variant="outline"
        aria-label={`Execution: ${workerStatus(task)}`}
        className={`shrink-0 gap-1.5 text-[10px] ${tone}`}
      >
        <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
        {workerStatus(task)}
      </Badge>
      {(task.pendingApprovalCount || 0) > 0 && (
        <Badge
          variant="outline"
          aria-label="Native approval needed"
          className="shrink-0 text-[10px]"
        >
          Needs approval
        </Badge>
      )}
    </>
  );
}
function WorkerCard({
  task,
  now,
  onSelect,
  compact,
}: {
  task: WorkerTask;
  now: number;
  onSelect: (id: string) => void;
  compact: boolean;
}) {
  const timing = workerTiming(task, now),
    attention = pendingAttention(task);
  const assignment = currentAssignment(task),
    queued = queuedAssignments(task).length;
  const title = assignment.brief?.trim().split("\n")[0] || "Worker task";
  return (
    <article data-worker-id={task.id} className="h-full min-w-0">
      <button
        type="button"
        onClick={() => onSelect(task.id)}
        aria-label={`Open worker ${assignment.ticket || task.id}: ${title}`}
        className="group flex h-full w-full min-w-0 flex-col rounded-xl border bg-card p-3 text-left shadow-xs transition-colors hover:border-primary/40 hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <div className="flex min-h-5 flex-wrap items-center justify-between gap-1.5">
          <span
            className="truncate text-[11px] font-medium text-muted-foreground"
            title={task.id}
          >
            {assignment.ticket || task.id}
          </span>
          <WorkerStatus task={task} />
        </div>
        <h3
          className="mt-2 min-h-10 line-clamp-2 break-words text-sm font-semibold leading-5"
          title={title}
        >
          {title}
        </h3>
        {queued > 0 && (
          <p className="mt-1 text-[11px] text-muted-foreground">
            {queued} follow-up{queued === 1 ? "" : "s"} queued
          </p>
        )}
        {!compact && (
          <p
            className="mt-1 min-h-5 line-clamp-1 break-words text-xs leading-5 text-muted-foreground"
            title={workerProgress(task)}
          >
            {workerProgress(task)}
          </p>
        )}
        {!compact && (
          <div className="mt-auto flex items-center justify-between gap-2 pt-2 text-[10px] text-muted-foreground">
            <span className="flex min-w-0 items-center gap-1">
              <Clock3 className="size-3 shrink-0" aria-hidden="true" />
              {timing.elapsed !== null
                ? `${formatElapsed(timing.elapsed)} elapsed`
                : "Timing unavailable"}
            </span>
            <span className="flex items-center gap-1">
              {attention.length ? (
                <>
                  <Hand className="size-3" aria-hidden="true" />
                  {attention.length} to review
                </>
              ) : (
                <>
                  {timing.live === true
                    ? "Process live"
                    : timing.live === false
                      ? "Process ended"
                      : "Liveness unverified"}
                  <ArrowUpRight
                    className="size-3 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
                    aria-hidden="true"
                  />
                </>
              )}
            </span>
          </div>
        )}
      </button>
    </article>
  );
}
export function WorkerAttention({
  view,
  onSelect,
  onRetry,
  compact = false,
}: {
  view: ManagerProps["manager"]["orchestration"];
  onSelect: (id: string) => void;
  onRetry?: () => void;
  compact?: boolean;
}) {
  const tasks = workspaceWorkers(view.tasks || []),
    groups = groupWorkers(tasks);
  const [now, setNow] = useState(Date.now()),
    [filter, setFilter] = useState("all");
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const shown =
    filter === "attention"
      ? tasks.filter(
          (task) =>
            task.pendingApprovalCount ||
            pendingAttention(task).length ||
            ["failed", "blocked", "awaiting_answer"].includes(task.status),
        )
      : filter === "active"
        ? groups.active
        : tasks;
  return (
    <section aria-label="Workers and worktrees" className="min-w-0 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id="attention-title" className="text-sm font-semibold">
            Your crew{" "}
            <span className="ml-1 text-muted-foreground">{tasks.length}</span>
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Independent work. One manager.
          </p>
        </div>
        <Layers className="size-4 text-muted-foreground" aria-hidden="true" />
      </div>
      {view.error && (
        <div
          role="alert"
          className="rounded-lg border border-destructive/30 p-3 text-xs text-destructive"
        >
          {view.error}
          {onRetry && (
            <Button size="sm" variant="outline" onClick={onRetry}>
              Retry
            </Button>
          )}
        </div>
      )}
      {view.loading && (
        <p role="status" className="flex gap-2 text-xs text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" />
          Loading workers…
        </p>
      )}
      {tasks.length > 0 && (
        <div className="flex gap-1" aria-label="Filter workers">
          {[
            ["all", "All"],
            ["active", "Current"],
            ["attention", "Needs attention"],
          ].map(([value, label]) => (
            <Button
              key={value}
              size="sm"
              variant={filter === value ? "secondary" : "ghost"}
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
              className="h-7 px-2 text-[11px]"
            >
              {label}
            </Button>
          ))}
        </div>
      )}
      {!view.loading && !tasks.length && (
        <div className="rounded-xl border border-dashed px-5 py-9 text-center">
          <FolderGit2 className="mx-auto mb-3 size-6 text-muted-foreground" />
          <h3 className="text-sm font-medium">A workspace for every task</h3>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            Agree a task with your manager. Its worker and progress appear here.
          </p>
        </div>
      )}
      <div
        id="worker-state"
        className="grid auto-rows-fr grid-cols-[repeat(auto-fit,minmax(min(100%,240px),1fr))] gap-2.5"
      >
        {shown.map((task) => (
          <WorkerCard
            key={task.id}
            task={task}
            now={now}
            onSelect={onSelect}
            compact={compact}
          />
        ))}
      </div>
      {tasks.length > 0 && !shown.length && (
        <p className="py-8 text-center text-xs text-muted-foreground">
          No workers in this view.
        </p>
      )}
      {tasks.length > 0 && (
        <p
          id="controller-status"
          className="text-[11px] leading-5 text-muted-foreground"
        >
          Select a worker to follow its work. Give instructions and review
          decisions with your manager.
        </p>
      )}
    </section>
  );
}
