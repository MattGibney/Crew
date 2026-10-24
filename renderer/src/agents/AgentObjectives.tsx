import { Circle, CircleCheck, CircleDot, ChevronRight } from "lucide-react";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import type { Job } from "../../../src/agents/contracts.mjs";
import { agentObjectives } from "./agent-objectives";

export function AgentObjectives({
  jobs,
  agentId,
}: {
  jobs: Job[];
  agentId: string;
}) {
  const groups = agentObjectives(jobs, agentId);
  const sections = [
    {
      title: "Not started",
      jobs: groups.notStarted,
      icon: Circle,
      empty: "Nothing waiting to start.",
    },
    {
      title: "In progress",
      jobs: groups.inProgress,
      icon: CircleDot,
      empty: "No objectives in progress.",
    },
    {
      title: "Recently completed",
      jobs: groups.completed,
      icon: CircleCheck,
      empty: "No completed objectives yet.",
    },
  ];
  return (
    <section aria-label="Agent objectives" className="min-w-0 space-y-6">
      <div>
        <h2 className="text-sm font-semibold">Objectives</h2>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          Their personal to-do list.
        </p>
      </div>
      {sections.map(({ title, jobs, icon: Icon, empty }) => (
        <section key={title} aria-label={title} className="space-y-2">
          <h3 className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <Icon className="size-3.5" aria-hidden="true" />
            {title}
            <span className="ml-auto tabular-nums">{jobs.length}</span>
          </h3>
          {jobs.length ? (
            <div className="divide-y">
              {jobs.map((job) => (
                <Objective key={job.id} job={job} />
              ))}
            </div>
          ) : (
            <p className="py-2 text-xs leading-5 text-muted-foreground">
              {empty}
            </p>
          )}
        </section>
      ))}
    </section>
  );
}
function Objective({ job }: { job: Job }) {
  if (job.work.type !== "local") return null;
  const work = job.work;
  const label =
    job.progress.label ||
    {
      blocked: "Blocked",
      ready: "Ready to review",
      in_progress: "In progress",
      not_started: "Not started",
      completed: "Completed",
      cancelled: "Cancelled",
    }[job.progress.status];
  return (
    <Collapsible className="py-3">
      <CollapsibleTrigger className="group flex w-full min-w-0 cursor-pointer items-start gap-2 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <div className="min-w-0 flex-1">
          <h4 className="break-words text-sm font-medium leading-5">
            {work.title}
          </h4>
          <p
            className={`mt-1 text-xs leading-5 ${job.progress.status === "blocked" ? "text-destructive" : "text-muted-foreground"}`}
          >
            {label}
            {job.progress.percent !== null &&
            job.progress.status !== "completed" &&
            job.progress.status !== "not_started"
              ? ` · ${job.progress.percent}%`
              : ""}
          </p>
        </div>
        <ChevronRight
          aria-hidden="true"
          className="mt-1 size-3.5 shrink-0 text-muted-foreground transition-transform group-aria-expanded:rotate-90"
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="space-y-3 pt-3 text-xs leading-5 text-muted-foreground">
          <p className="whitespace-pre-wrap break-words">{work.objective}</p>
          {job.progress.detail && (
            <p className="whitespace-pre-wrap break-words">
              {job.progress.detail}
            </p>
          )}
          {work.outcome && (
            <div>
              <p className="mb-1 font-medium text-foreground">Outcome</p>
              <p className="whitespace-pre-wrap break-words">
                {work.outcome.summary}
              </p>
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
